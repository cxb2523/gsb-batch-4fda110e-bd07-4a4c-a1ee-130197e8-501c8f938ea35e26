package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

type failStyle int

const (
	failHTTP failStyle = iota
	failRPC
)

// pageServer answers tools/list from pages, keyed by the request's cursor
// ("" is the first page); a cursor in fail answers that failure instead.
func pageServer(t *testing.T, pages map[string]string, fail map[string]failStyle) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Params struct {
				Cursor string `json:"cursor"`
			} `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("request body: %v", err)
		}
		cursor := req.Params.Cursor
		switch style, failing := fail[cursor]; {
		case !failing:
		case style == failHTTP:
			http.Error(w, `{"result":{"tools":[]}}`, http.StatusInternalServerError)
			return
		case style == failRPC:
			_, _ = w.Write([]byte(`{"jsonrpc":"2.0","error":{"code":-32603,"message":"server exploded"}}`))
			return
		}
		page, ok := pages[cursor]
		if !ok {
			t.Errorf("unexpected cursor %q", cursor)
			http.Error(w, "bad cursor", http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":` + page + `}`))
	}
}

func TestHTTPClientPagination(t *testing.T) {
	srv := httptest.NewServer(pageServer(t, map[string]string{
		"":   `{"tools":[{"name":"alpha","description":"first"},{"name":"beta"}],"nextCursor":"c2"}`,
		"c2": `{"tools":[{"name":"alpha","description":"second"},{"name":"gamma"},{"name":"beta","description":"again"}]}`,
	}, nil))
	defer srv.Close()

	listing, err := NewMCPHttpClient(srv.URL, nil).ListToolsWithStatus()
	if err != nil {
		t.Fatalf("two pages should list: %v", err)
	}
	if listing.Status != ToolsComplete || listing.Reason != "" {
		t.Errorf("both pages read means complete: %+v", listing)
	}
	if len(listing.Tools) != 3 {
		t.Fatalf("tools merged by name: %+v", listing.Tools)
	}
	if got := []string{listing.Tools[0].Name, listing.Tools[1].Name, listing.Tools[2].Name}; strings.Join(got, ",") != "alpha,beta,gamma" {
		t.Errorf("tools keep the page order: %v", got)
	}
	if listing.Tools[0].Description != "first" || listing.Tools[1].Description != "" {
		t.Errorf("a name repeated later keeps its first occurrence: %+v", listing.Tools)
	}
}

func TestHTTPClientPaginationSecondPageHTTPError(t *testing.T) {
	srv := httptest.NewServer(pageServer(t, map[string]string{
		"": `{"tools":[{"name":"alpha"}],"nextCursor":"c2"}`,
	}, map[string]failStyle{"c2": failHTTP}))
	defer srv.Close()

	listing, err := NewMCPHttpClient(srv.URL, nil).ListToolsWithStatus()
	if err == nil {
		t.Fatal("a failed second page must be an error")
	}
	if listing.Status != ToolsFailed || len(listing.Tools) != 0 {
		t.Errorf("a failed page makes the listing fail: %+v", listing)
	}
	if !strings.Contains(listing.Reason, "page 2") || !strings.Contains(listing.Reason, "HTTP 500") {
		t.Errorf("reason names the page and status: %q", listing.Reason)
	}
}

func TestHTTPClientPaginationSecondPageRPCError(t *testing.T) {
	srv := httptest.NewServer(pageServer(t, map[string]string{
		"": `{"tools":[{"name":"alpha"}],"nextCursor":"c2"}`,
	}, map[string]failStyle{"c2": failRPC}))
	defer srv.Close()

	listing, err := NewMCPHttpClient(srv.URL, nil).ListToolsWithStatus()
	if err == nil {
		t.Fatal("a JSON-RPC error on a later page must be an error")
	}
	if listing.Status != ToolsFailed || !strings.Contains(listing.Reason, "page 2") ||
		!strings.Contains(listing.Reason, "JSON-RPC error") || !strings.Contains(listing.Reason, "server exploded") {
		t.Errorf("reason names the page and the JSON-RPC error: %+v", listing)
	}
}

func TestHTTPClientResponseTooLarge(t *testing.T) {
	srv := httptest.NewServer(pageServer(t, map[string]string{
		"":   `{"tools":[{"name":"alpha"}],"nextCursor":"c2"}`,
		"c2": `{"tools":[{"name":"beta","description":"` + strings.Repeat("x", 4096) + `"}]}`,
	}, nil))
	defer srv.Close()

	client := NewMCPHttpClient(srv.URL, nil)
	client.limit = 1024 // the real cap is 10 MiB; a small one keeps the test fast
	listing, err := client.ListToolsWithStatus()
	if err != nil {
		t.Fatalf("an oversized reply is an incomplete list, not an error: %v", err)
	}
	if listing.Status != ToolsIncomplete {
		t.Errorf("a reply over the size limit must be incomplete: %+v", listing)
	}
	if !strings.Contains(listing.Reason, "larger than") || !strings.Contains(listing.Reason, "limit") {
		t.Errorf("reason explains the size limit: %q", listing.Reason)
	}
	if len(listing.Tools) != 1 || listing.Tools[0].Name != "alpha" {
		t.Errorf("tools read before the oversized page are kept: %+v", listing.Tools)
	}
}

func TestHTTPClientOversizedFirstPage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"result":{"tools":[{"name":"alpha","description":"` + strings.Repeat("x", 4096) + `"}]}}`))
	}))
	defer srv.Close()

	client := NewMCPHttpClient(srv.URL, nil)
	client.limit = 1024
	listing, err := client.ListToolsWithStatus()
	if err != nil {
		t.Fatalf("an oversized first page is incomplete, not failed: %v", err)
	}
	if listing.Status != ToolsIncomplete || listing.Reason == "" {
		t.Errorf("an oversized first page must be incomplete with a reason: %+v", listing)
	}
}

func TestHTTPClientNetworkError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close() // nothing listens any more: a plain network failure

	listing, err := NewMCPHttpClient(url, nil).ListToolsWithStatus()
	if err == nil {
		t.Fatal("an unreachable server must fail")
	}
	if listing.Status != ToolsFailed || !strings.Contains(listing.Reason, "network error") {
		t.Errorf("reason names the network failure: %+v", listing)
	}
}

func TestHTTPClientNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not allowed", http.StatusForbidden)
	}))
	defer srv.Close()

	listing, err := NewMCPHttpClient(srv.URL, nil).ListToolsWithStatus()
	if err == nil {
		t.Fatal("a non-200 reply must fail")
	}
	if listing.Status != ToolsFailed || !strings.Contains(listing.Reason, "HTTP 403") {
		t.Errorf("reason names the status: %+v", listing)
	}
}

func TestHTTPClientPageLimit(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := calls.Add(1)
		_, _ = fmt.Fprintf(w, `{"result":{"tools":[{"name":"tool%d"}],"nextCursor":"c%d"}}`, page, page)
	}))
	defer srv.Close()

	listing, err := NewMCPHttpClient(srv.URL, nil).ListToolsWithStatus()
	if err != nil {
		t.Fatalf("the page limit stops the listing without an error: %v", err)
	}
	if listing.Status != ToolsIncomplete {
		t.Errorf("a server with more pages than the cap is incomplete: %+v", listing)
	}
	if !strings.Contains(listing.Reason, fmt.Sprintf("%d pages", maxToolPages)) {
		t.Errorf("reason names the page limit: %q", listing.Reason)
	}
	if len(listing.Tools) != maxToolPages || calls.Load() != int32(maxToolPages) {
		t.Errorf("one tool per page, no page past the cap: %d tools, %d requests", len(listing.Tools), calls.Load())
	}
}

func TestHTTPClientRepeatedCursor(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"result":{"tools":[{"name":"alpha"}],"nextCursor":"same"}}`))
	}))
	defer srv.Close()

	listing, err := NewMCPHttpClient(srv.URL, nil).ListToolsWithStatus()
	if err != nil {
		t.Fatalf("a stuck cursor stops the listing without an error: %v", err)
	}
	if listing.Status != ToolsIncomplete || !strings.Contains(listing.Reason, "same cursor") {
		t.Errorf("a cursor returned again is incomplete: %+v", listing)
	}
	if len(listing.Tools) != 1 || calls.Load() != 2 {
		t.Errorf("stops once the cursor repeats: %d tools, %d requests", len(listing.Tools), calls.Load())
	}
}
