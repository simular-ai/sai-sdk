# Sai in Claude and ChatGPT: plugins, remote MCP and OAuth

**Status:** Draft, 2026-10-20. Step 1 (Claude Code plugin) is in progress; steps 2-4 are design only.
**Source:** "SAI API partnership channel" (Google Doc), sections *Claude Plugin (Without remote server)*,
*Claude Plugin + Connector (with remote server)* and *ChatGPT (Remote MCP) Plugin*.

## Goal

Let people hand tasks to Sai from inside Claude (chat, Cowork, Claude Code) and ChatGPT, installed from
each vendor's directory instead of hand-editing an MCP config.

## What each surface can load

From Anthropic's [plugin platform support](https://claude.com/docs/plugins/platform-support) table:

| Component | claude.ai chat (web, desktop, mobile) | Cowork | Claude Code |
| - | - | - | - |
| Skills | Loads | Loads | Loads |
| Local MCP server (`command`, e.g. `npx @simular-ai/sai-mcp`) | Ignored | Only when the session runs on the user's computer | Loads |
| MCP server that needs a `${user_config.*}` value with no default | Ignored | Ignored (Cowork doesn't prompt) | Loads, prompts for the value |
| Remote MCP server (`type: http`, fixed URL) | Works once connected on the Connectors tab | Loads | Loads |

So a plugin that wraps today's local `@simular-ai/sai-mcp` with an API key works only in Claude Code.
Reaching chat, Cowork and ChatGPT needs a hosted MCP endpoint with OAuth sign-in.

## Plan

| Step | What | Reaches | Size |
| - | - | - | - |
| 1 | Claude Code plugin around the local `@simular-ai/sai-mcp` | Claude Code | ~0.5 day + directory review |
| 2 | OAuth authorization server on the Sai API service | (enables 3, 4) | ~1 week |
| 3 | Remote MCP endpoint (Streamable HTTP) | Claude chat, Cowork, Claude Code, ChatGPT | ~2 days |
| 4 | Plugin points at the remote endpoint; submit plugin + connector to Claude, plugin to ChatGPT | All | review time |

Only step 1 is being built now.

## Step 1: Claude Code plugin (local MCP)

A separate public repository, `simular-ai/sai-claude-plugin`. `sai-sdk` is private, and the directory
lists a plugin only from a public repository; a plugin folder at the root of its own repository also
avoids the stricter subfolder checks. The repository holds no source: the MCP server stays in
`sai-sdk/mcp` and ships through npm as today.

```text
.claude-plugin/plugin.json   name "sai", userConfig.api_key (sensitive)
.mcp.json                    npx -y @simular-ai/sai-mcp@<exact version>, SAI_API_KEY=${user_config.api_key}
skills/sai/SKILL.md          when to hand a task to Sai and the start/wait/approve loop
README.md                    what it does, what it sends where (>= 40 words, required)
LICENSE                      MIT
```

Directory rules that shape it ([pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist)):

- The `npx` package must be pinned to an exact version; a range or `@latest` blocks. Every sai-mcp release
  needs a plugin release that bumps the pin and `version`.
- A pinned registry package is always held for a human reviewer ("Runs a pinned npx or uvx package").
  That's a review step, not a rejection.
- The API key comes from `userConfig` with `sensitive: true`; reading `$SAI_API_KEY` from the user's
  environment would be held.
- The README must say what the plugin runs and what it sends where, or the security scan can reject it.
- Only an org Owner can submit at [claude.ai/directory/manage](https://claude.ai/directory/manage) (Ang).

## Step 2: OAuth authorization server

Self-hosted on the Sai API service (the `api` surface from unified-ui #3225), not a hosted provider.
Most of what it needs already exists in the API key system:

- keys are looked up by HMAC hash and can be revoked (`revokedAt`);
- short-lived keys already carry `expiresAt` (`cloud-api/src/services/run-keys.ts`), and
  `validateApiKey` enforces it;
- keys carry an optional `scope` (`refuseScopeOffRoute`) and a per-key spend cap.

So OAuth is a protocol layer that issues API keys; request authentication in cloud-api doesn't change.

### Tokens

- **Grant**: one `oauth_grants` document per connected app (user or Organisation, client, created,
  revoked). The platform lists grants under "Connected apps"; disconnecting revokes the grant.
- **Access token**: an `api_keys` document with `expiresAt` = 1 hour and `grantId`. Same permissions as a
  key the user creates by hand (decided 2026-10-20), so no new scope model in v1.
- **Refresh token**: stored hashed on the grant, rotated on every refresh. Reuse of a rotated refresh
  token revokes the grant. An invalid refresh token returns `invalid_grant`.
- Revoking a grant revokes the keys it issued.

### Endpoints

| Endpoint | Host | Behaviour |
| - | - | - |
| `GET /.well-known/oauth-protected-resource` | MCP server | `resource` = the MCP URL exactly; `authorization_servers` = [issuer] |
| `GET /.well-known/oauth-authorization-server` | API service | issuer, endpoints, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `scopes_supported` incl. `offline_access` |
| `POST /oauth/register` | API service | Dynamic Client Registration (RFC 7591, JSON body); stores name + redirect URIs; rate limited |
| `/oauth/authorize` | platform.simular.ai page | Firebase sign-in → phone verification for free accounts → consent (client name, redirect hostname, Organisation to bill) → API mints a code → redirect with `code` + `state` |
| `POST /oauth/token` | API service | `application/x-www-form-urlencoded`; `authorization_code` (PKCE S256, redirect URI must match, code single-use, 60 s TTL) and `refresh_token` |

Client identity: support both CIMD and DCR. Claude prefers CIMD when the metadata advertises it (and
Claude Code always uses its own CIMD), which avoids a registration per connection. Fetching a client
metadata URL is an outbound request from our server: https only, no private or link-local addresses,
short timeout, small response cap, cached.

Redirect URIs: exact match, except `http://localhost/…` and `http://127.0.0.1/…`, which match with any
port (Claude Code's loopback callback). Hosted Claude uses `https://claude.ai/api/mcp/auth_callback`.

Constraints from Claude's client ([connector authentication](https://claude.com/docs/connectors/building/authentication)):
an unauthenticated MCP request must get `401` with `WWW-Authenticate: Bearer resource_metadata="…"`;
discovery, registration and token endpoints answer within 10 s; Anthropic's egress range
`160.79.104.0/21` must reach both the MCP server and the authorization server.

### Open questions

1. **Free accounts and key count.** A free account may hold one API key today (mint-time gate, see
   `auth.ts`). OAuth-issued keys need their own rule. One option: one manual key plus one connected app on
   free, more connected apps on paid, so the second connection is an upgrade prompt. Should the limit be on
   connected apps at all, or only on usage (the daily VM and credit limits free already has)?
2. **Phone verification.** OAuth must not bypass the free tier's phone check; the consent page has to run
   it. Confirm that is acceptable friction on the first connection from a directory.
3. **Organisation billing.** A user in several Organisations picks one at consent, or the grant always
   bills the personal account?

## Step 3: Remote MCP endpoint

`@simular-ai/sai-mcp` runs over stdio only (`StdioServerTransport` in `mcp/src/server.ts`). Add a
Streamable HTTP entry point, stateless per request, that takes the bearer token from the request and uses
it as the API key for its calls. Host it with the API service (e.g. `https://mcp.simular.ai/mcp`).

- Off in the remote build: the `127.0.0.1` local view (`local-view.ts`) and push (`SAI_PUSH`).
- Kept: the MCP Apps view (`app-view.ts`), which renders the live computer inside Claude and ChatGPT.
- ChatGPT requires accurate `readOnlyHint` / `destructiveHint` / `openWorldHint` on every tool.

## Step 4: Publish

- **Claude:** the plugin's `.mcp.json` switches to `type: http` + the fixed URL; submit the plugin and
  the MCP server as a connector.
- **ChatGPT:** domain challenge at `/.well-known/openai-apps-challenge`, a reviewer account without MFA,
  positive/negative test cases, a video walkthrough, and business verification of the OpenAI org (Owner:
  Ang).
