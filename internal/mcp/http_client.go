package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// maxHTTPResponse caps how much of a remote server's reply is read.
const maxHTTPResponse = 10 << 20 // 10 MiB

// maxToolPages bounds how many tools/list pages one server may be asked for,
// so a server that keeps handing out cursors can't stall the whole listing.
const maxToolPages = 50

// errResponseTooLarge marks a reply body bigger than maxHTTPResponse. A tools
// listing that meets it is incomplete: some tools were never read.
type errResponseTooLarge struct {
	limit int
	page  int
}

func (e *errResponseTooLarge) Error() string {
	return fmt.Sprintf("page %d response is larger than the %d MiB limit; the rest of the list was not read", e.page, e.limit>>20)
}

// MCPHttpClient talks to a remote MCP server over HTTP (JSON or SSE replies).
type MCPHttpClient struct {
	url     string
	headers map[string]string
	client  *http.Client
	limit   int // most bytes read from one reply; maxHTTPResponse unless a test lowers it
}

// NewMCPHttpClient creates a client for url with optional request headers.
func NewMCPHttpClient(url string, headers map[string]string) *MCPHttpClient {
	return &MCPHttpClient{url: url, headers: headers, client: &http.Client{Timeout: 30 * time.Second}, limit: maxHTTPResponse}
}

// ListTools returns the tools the remote server exposes, following
// nextCursor through every page. An incomplete listing still returns the
// tools read so far, with no error; only a failed listing returns an error.
func (c *MCPHttpClient) ListTools() ([]MCPTool, error) {
	listing, err := c.ListToolsWithStatus()
	if err != nil {
		return nil, err
	}
	return listing.Tools, nil
}

// ListToolsWithStatus lists the remote server's tools page by page and says
// whether the list is complete. Tools are merged across pages by name, the
// first occurrence winning, so a tool repeated by a server appears once.
func (c *MCPHttpClient) ListToolsWithStatus() (ToolListing, error) {
	listing := ToolListing{Tools: []MCPTool{}, Status: ToolsComplete}
	seen := map[string]bool{}
	cursor := ""
	for page := 1; ; page++ {
		var result MCPToolsResult
		if err := c.callPage(toolsListPageRequest(page, cursor), page, &result); err != nil {
			var tooLarge *errResponseTooLarge
			if errors.As(err, &tooLarge) {
				listing.Status = ToolsIncomplete
				listing.Reason = tooLarge.Error()
				return listing, nil
			}
			if page > 1 {
				err = fmt.Errorf("page %d of tools/list failed: %w", page, err)
			}
			return ToolListing{Tools: []MCPTool{}, Status: ToolsFailed, Reason: err.Error()}, err
		}
		for _, tool := range result.Tools {
			if seen[tool.Name] {
				continue
			}
			seen[tool.Name] = true
			listing.Tools = append(listing.Tools, tool)
		}
		next := result.NextCursor
		if next == "" {
			return listing, nil
		}
		if next == cursor {
			listing.Status = ToolsIncomplete
			listing.Reason = fmt.Sprintf("stopped after %d pages: the server returned the same cursor %q again", page, next)
			return listing, nil
		}
		if page >= maxToolPages {
			listing.Status = ToolsIncomplete
			listing.Reason = fmt.Sprintf("stopped after %d pages: the server has more tools than were read", maxToolPages)
			return listing, nil
		}
		cursor = next
	}
}

// callPage POSTs one tools/list page and decodes the JSON-RPC result into out.
func (c *MCPHttpClient) callPage(req MCPRequest, page int, out any) error {
	limit := c.limit
	if limit <= 0 {
		limit = maxHTTPResponse
	}
	data, err := json.Marshal(req)
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequest(http.MethodPost, c.url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range c.headers {
		httpReq.Header.Set(k, v)
	}
	resp, err := c.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("network error: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
	if err != nil {
		return fmt.Errorf("network error: %w", err)
	}
	if len(body) > limit {
		return &errResponseTooLarge{limit: limit, page: page}
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(body), 200))
	}
	if err := decodeRPCResult(extractRPCPayload(body), out); err != nil {
		return err
	}
	return nil
}

// extractRPCPayload returns the JSON-RPC message from a plain JSON body or
// from the first "data:" line of a Server-Sent Events body.
func extractRPCPayload(body []byte) []byte {
	if !bytes.HasPrefix(body, []byte("event:")) {
		return body
	}
	for _, line := range bytes.Split(body, []byte("\n")) {
		if after, ok := bytes.CutPrefix(line, []byte("data: ")); ok {
			return after
		}
	}
	return nil
}

// decodeRPCResult unmarshals a JSON-RPC message and its result into out.
func decodeRPCResult(payload []byte, out any) error {
	if payload == nil {
		return fmt.Errorf("no data found in SSE response")
	}
	var msg struct {
		Result json.RawMessage `json:"result"`
		Error  *MCPError       `json:"error"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		return fmt.Errorf("invalid JSON response: %w", err)
	}
	if msg.Error != nil {
		return fmt.Errorf("JSON-RPC error: %s", msg.Error.Message)
	}
	return json.Unmarshal(msg.Result, out)
}

// truncate shortens s to at most n bytes for error messages.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
