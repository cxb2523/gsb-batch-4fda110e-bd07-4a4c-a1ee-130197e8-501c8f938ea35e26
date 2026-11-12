package mcp

// ToolListingStatus says how much of a server's tool list was read.
type ToolListingStatus string

const (
	// ToolsComplete means every page the server offered was read.
	ToolsComplete ToolListingStatus = "complete"
	// ToolsIncomplete means some tools could not be read: the list was cut
	// short by the response-size limit, the page limit, or a server that
	// stopped advancing. Tools holds what was read.
	ToolsIncomplete ToolListingStatus = "incomplete"
	// ToolsFailed means no trustworthy listing could be made. Tools is empty
	// and Reason says why.
	ToolsFailed ToolListingStatus = "failed"
)

// ToolListing is the outcome of listing one server's tools. Reason explains
// an incomplete or failed listing; it is empty when Status is ToolsComplete.
type ToolListing struct {
	Tools  []MCPTool
	Status ToolListingStatus
	Reason string
}
