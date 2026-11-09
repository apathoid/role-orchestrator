# C09.6 — MCP transport

C09 uses [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) with a stateless loopback endpoint owned by one adapter invocation. ACP registers the endpoint through [session/new](https://agentclientprotocol.com/protocol/v1/session-setup#mcp-servers) only after negotiating HTTP MCP. CLI uses the [Codex configuration override](https://developers.openai.com/codex/config-reference) for a required MCP server on the individual command.

## OBSERVED with controlled agents

Both adapters created a real subprocess and passed the real MCP endpoint through the normal provider boundary. Through HTTP tools the subprocess listed history, fetched omitted evidence and cited it in a validated Controller Decision. The subprocess received explicit denials for cross-operation access and the context payload budget. The endpoint closed after the invocation. A registered external tool ran through the same bridge with a standing decision from the Host broker. Its result was correlated with one invocation and one evidence record despite a replay of the same MCP request id.

## OBSERVED with installed binaries

Linux, Node 24.22.1. An empty working directory and a 15-second deadline were used for each probe. Codex CLI 0.165.0 reported HTTP 401, did not complete the turn and did not reach MCP discovery. Codex ACP 2.5.0 did not reach prompt dispatch before the deadline. Neither binary invoked context retrieval tools.

Native retrieval, skill compliance by a live model and end-to-end native integration remain UNVERIFIED. The controlled subprocess tests verify the transport and application contracts.
