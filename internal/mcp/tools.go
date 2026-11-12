package mcp

import (
	"fmt"
	"os"
	"sync"
	"time"

	"kiromanager/internal/system"
)

// serverTimeout bounds how long one server may take to list its tools, so a
// slow or broken server never blocks the others.
const serverTimeout = 15 * time.Second

// NetworkErrorPrefix marks a listing that failed because the server could not
// be reached or answered in time, as opposed to a server that answered with
// an error. It is part of the failure reasons the UI shows.
const NetworkErrorPrefix = "network error: "

// ServerTools is the tool listing for one server: Status is "complete",
// "incomplete" or "failed", and Reason says why it isn't complete. Tools holds
// what was read, so the UI can show them even when the listing was cut short.
type ServerTools struct {
	Tools  []MCPTool         `json:"tools"`
	Status ToolListingStatus `json:"status"`
	Reason string            `json:"reason,omitempty"`
}

// GetToolsFromConfig lists tools for every enabled server concurrently; one
// slow or broken server never blocks the others. Each result carries whether
// the listing is complete. Complete listings are remembered as the server's
// size; failed and incomplete ones are remembered as failures, with the
// reason.
func (s *MCPService) GetToolsFromConfig(servers map[string]*MCPServerConfig) (map[string]ServerTools, error) {
	tools := make(map[string]ServerTools, len(servers))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for name, cfg := range servers {
		if cfg == nil || cfg.Disabled {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			listing, err := s.measure(name, cfg.launch())
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				tools[name] = ServerTools{Tools: []MCPTool{}, Status: ToolsFailed, Reason: err.Error()}
				return
			}
			tools[name] = ServerTools{Tools: listing.Tools, Status: listing.Status, Reason: listing.Reason}
		}()
	}
	wg.Wait()
	return tools, nil
}

// MeasureTools lists the tools of each server so its size is known, and
// returns why each failed one couldn't be measured. Servers being measured
// already, for another request, are waited for rather than started twice.
// A listing that is incomplete is reported as a failure too: its size would
// be wrong, and the reason says how it was cut short.
func (s *MCPService) MeasureTools(servers map[string]system.MCPLaunch) map[string]string {
	failed := map[string]string{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for name, launch := range servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if listing, err := s.measure(name, launch); err != nil {
				mu.Lock()
				failed[name] = err.Error()
				mu.Unlock()
			} else if listing.Status != ToolsComplete {
				mu.Lock()
				failed[name] = incompleteReason(listing)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return failed
}

// incompleteReason phrases an incomplete listing for a failure report.
func incompleteReason(listing ToolListing) string {
	return "tools/list incomplete: " + listing.Reason
}

// measure lists one server's tools and remembers the result. A second call
// for the same server while one runs waits for it and shares its result.
func (s *MCPService) measure(name string, launch system.MCPLaunch) (ToolListing, error) {
	key := name + "\x00" + launch.Key()
	s.mu.Lock()
	if run, ok := s.running[key]; ok {
		s.mu.Unlock()
		<-run.done
		return run.listing, run.err
	}
	run := &measurement{done: make(chan struct{})}
	s.running[key] = run
	s.mu.Unlock()

	run.listing, run.err = listWithTimeout(name, launch, s.workDir())
	if run.listing.Tools == nil {
		run.listing.Tools = []MCPTool{}
	}
	sizes := s.kiroService.MCPSizes()
	switch {
	case run.err != nil:
		s.logger.Warn("Failed to get tools for %s: %v", name, run.err)
		sizes.RecordFailure(name, launch, run.err.Error())
	case run.listing.Status != ToolsComplete:
		s.logger.Warn("Incomplete tools list for %s: %s", name, run.listing.Reason)
		sizes.RecordFailure(name, launch, incompleteReason(run.listing))
	default:
		if err := sizes.Record(name, launch, toolsSize(name, run.listing.Tools)); err != nil {
			s.logger.Warn("Could not remember the size of %s: %v", name, err)
		}
	}
	s.mu.Lock()
	delete(s.running, key)
	s.mu.Unlock()
	close(run.done)
	return run.listing, run.err
}

// measurement is one tools listing in progress.
type measurement struct {
	done    chan struct{}
	listing ToolListing
	err     error
}

// workDir is the folder servers start in, as Kiro starts them: the active
// Workspace, or the home folder in Global.
func (s *MCPService) workDir() string {
	if s.kiroService.GetMode() == system.ModeWorkspace {
		return s.kiroService.GetActiveWorkspace()
	}
	home, _ := os.UserHomeDir()
	return home
}

// listWithTimeout runs listServerTools with serverTimeout.
func listWithTimeout(name string, launch system.MCPLaunch, dir string) (ToolListing, error) {
	type result struct {
		listing ToolListing
		err     error
	}
	done := make(chan result, 1)
	go func() {
		l, err := listServerTools(launch, dir)
		done <- result{l, err}
	}()
	select {
	case r := <-done:
		return r.listing, r.err
	case <-time.After(serverTimeout):
		if launch.URL != "" {
			return ToolListing{}, fmt.Errorf("%stimeout connecting to %s", NetworkErrorPrefix, name)
		}
		return ToolListing{}, fmt.Errorf("timeout connecting to %s", name)
	}
}

// listServerTools connects with the HTTP or stdio transport and lists tools.
// Only the HTTP transport pages through tools/list; a stdio server's single
// reply is taken as its whole list, as before.
func listServerTools(cfg system.MCPLaunch, dir string) (ToolListing, error) {
	switch {
	case cfg.URL != "":
		return NewMCPHttpClient(cfg.URL, cfg.Headers).ListToolsWithStatus()
	case cfg.Command != "":
		client := NewMCPStdioClient(cfg.Command, cfg.Args, cfg.Env, dir)
		defer client.Close()
		if err := client.Connect(); err != nil {
			return ToolListing{}, err
		}
		tools, err := client.ListTools()
		if err != nil {
			return ToolListing{}, err
		}
		if tools == nil {
			tools = []MCPTool{}
		}
		return ToolListing{Tools: tools, Status: ToolsComplete}, nil
	default:
		return ToolListing{Tools: []MCPTool{}, Status: ToolsComplete}, nil
	}
}
