# Notion MCP connection

`tools/notion-oauth.mjs` uses official Notion OAuth discovery, dynamic client registration, authorization code + S256 PKCE, and refresh tokens.

## API

- `await status()` reads local connection metadata and, when disconnected, performs read-only OAuth discovery. It never registers a client or opens a browser. Possible states: `not_connected`, `needs_credentials`, `discovery_failed`, `needs_authorization`, `connected`. A saved token is not live MCP verification (`verified: false`).
- `await start({redirectUri})` must be called only from the user's Connect action. It dynamically registers a public client if needed and returns `{authorizeUrl, expiresIn, permissionNotice}`. The caller opens the authorization URL in response to that action.
- `await finish({code,state,redirectUri})` consumes a state once, checks its ten-minute TTL and exact callback match, exchanges the code, and saves tokens.
- `await getAccessToken()` returns a token only to the server-side MCP transport and refreshes shortly before expiry.
- `await refresh()` refreshes explicitly; concurrent refresh calls share one operation.

Callbacks are limited to local HTTP loopback addresses. OAuth endpoints require HTTPS and an exact allowlisted Notion hostname; redirects are not followed. Tokens and registration credentials are written atomically to `data/notion-oauth.json` with mode `0600`. Do not include that file in exported project archives. The state/verifier remains in process memory; restarting the local server requires restarting authorization.

When dynamic registration is unavailable, configure `NOTION_OAUTH_CLIENT_ID` and, only if the registered client requires it, `NOTION_OAUTH_CLIENT_SECRET`. Never obtain these by extracting another application's private credentials.

## Permission boundary

The module requests an explicit read-only scope only when the server advertises a recognized one. Otherwise it uses the server default and returns a notice explaining that OAuth can include read and edit permissions. Show `permissionNotice` beside the Connect action. The application must separately restrict its enabled MCP tools to read-only until the user enables writes. An OAuth token alone is not proof that tools/list or a workspace read succeeded.

## Evidence

The official [Notion cookbook](https://github.com/makenotion/notion-cookbook/blob/main/docs/mcp-client-integration.md) documents dynamic client registration, PKCE, and refresh support.

On 2026-10-13, initial metadata requests returned Cloudflare HTTP 403. A later retry succeeded. The user then completed OAuth in the connection page. Live authenticated MCP discovery returned 49 tools, and a real search found the “行动指南” page. No Notion pages were created or edited during verification.

`tools/notion-connection.mjs` maps the same application tools to either the configured API integration or the authorized MCP connection. This fixes the false “not authorized” response caused by checking only the integration key while an OAuth token was already present. MCP discovery returns compact summaries by default; provide `toolName` for the full input schema.

Local checks separately covered read-only metadata/status, broad-scope notices, invalid-state rejection and missing-token rejection. Connection state never exposes tokens to the browser or model.
