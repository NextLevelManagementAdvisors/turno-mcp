# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # stdio mode with tsx (auto-recompile)
npm run dev:http     # http mode with tsx
npm run typecheck    # tsc --noEmit (run before every commit)
npm run build        # tsc → dist/
npm start            # node dist/src/index.js (stdio)
npm run start:http   # node dist/src/index.js (http)
```

There is no test suite yet — `npm test` runs vitest but no tests are defined. Validation today is typecheck + an end-to-end smoke (boot http mode, `POST /token`, `POST /mcp` with `initialize` then `tools/list`); see history in conversation memory for the curl recipe.

Deploy to the production VPS:

```bash
./deploy/push-to-vps.sh   # tar+scp to root@178.16.141.166:/opt/turno-mcp, npm ci, systemctl restart
```

The service is live at `https://turno.nlma.io/mcp` on port 3009 behind nginx + Let's Encrypt. systemd unit name: `turno-mcp.service`. Config (`.env`, chmod 600) lives at `/opt/turno-mcp/.env`; tenant store at `/opt/turno-mcp/data/tenants.json`.

## Architecture

### Two transports from one entrypoint

[src/index.ts](src/index.ts) branches on `TRANSPORT`:

- `TRANSPORT=stdio` (default) — single-user local mode, credentials from env (`TURNO_API_TOKEN` + `TURNO_PARTNER_ID`). Builds one `TurnoClient`, registers tools on a stdio `Server`. Used by Claude Desktop / local CLI clients.
- `TRANSPORT=http` — multi-tenant Express + StreamableHTTP. Boots [src/http-server.ts](src/http-server.ts), which exposes `/health`, `/enroll` (HTML form), `/token` (programmatic enrollment), and `/mcp` (bearer-authed transport).

In http mode every MCP request gets a fresh `Server` with tools bound to **the requesting tenant's** `ToolContext`. Don't try to share a single MCP `Server` across tenants — the per-tenant `TurnoClient` is what makes data isolation work.

### The auth model is two-layered

1. **MCP edge auth** ([src/auth.ts](src/auth.ts)): clients hit `/mcp` with `Authorization: Bearer trn_<hex>`. Bearer is SHA-256 hashed and looked up in `TenantStore`. The tenant pinned by the bearer is attached to `req.toolCtx`.
2. **Outbound Turno auth** ([src/turno-client.ts](src/turno-client.ts)): every Turno v2 request requires **both** `Authorization: Bearer <jwt>` AND `TBNB-Partner-ID: <uuid>`. Both are required — bearer-only returns `401 "Unable to identify the requesting entity"`. The JWT (Turno's "Secret Key") is stored AES-256-GCM encrypted; the partner UUID is stored plaintext (it's not a secret, it's an account ID).

The Turno Partner ID is shown in the dashboard at the **bottom of the API → Tokens page** as a small "Here is your Partner ID:" line — easy to miss, and required.

Production base URL is `https://api.turnoverbnb.com/v2`. **NOT** `www.turnoverbnb.com/v2` (which 301s to a Cloudflare-protected marketing site). The Postman collection ships stale examples pointing at sandbox/www; don't trust them blindly.

### Tenant schema is forward-compatible

[src/tenants.ts](src/tenants.ts) uses a discriminated-union `TenantCredential`:

```ts
{ kind: "api_token", apiTokenEncrypted, partnerId }
| { kind: "oauth", accessTokenEncrypted, refreshTokenEncrypted, expiresAt, partnerId }
```

The `oauth` variant is scaffolded but not wired through enrollment yet. Adding the OAuth authorization-code flow later won't require migrating existing tenants — just a new `/oauth/callback` route and refresh logic in `TurnoClient`.

Tenants are persisted to a single JSON file (`tenants.json`) with atomic write-and-rename. The encryption root key is `TURNO_ENCRYPTION_KEY` (HKDF-derived per-secret in [src/crypto.ts](src/crypto.ts)). Losing it means losing every tenant's stored Secret Key — back it up before redeploying.

### Tool definition pattern

Tools live in [src/tools/](src/tools/), one file per Turno resource. Each file exports a typed `AnyToolDef[]` array; [src/tools/register.ts](src/tools/register.ts) concatenates them and binds the MCP `tools/list` + `tools/call` handlers.

Use the `tool({...})` helper from [src/tools/_shared.ts](src/tools/_shared.ts) — it preserves narrow Zod typing locally for handler safety while erasing it to `AnyToolDef` at the array boundary (Zod shapes aren't covariant, so this two-step is required to avoid TS variance errors when concatenating heterogeneous tool arrays).

Conventions:

- Tool names: `turno_<verb>_<resource>` (e.g. `turno_list_properties`, `turno_create_booking`).
- Destructive tools (POST/PATCH/DELETE that change Turno state) set `destructive: true` and explicitly mention "DESTRUCTIVE:" in the description so MCP clients can warn users.
- Handlers should return `jsonContent(...)` for normal responses; errors thrown from `TurnoClient` are caught by `register.ts` and formatted via `formatToolError`.
- Path params go in the URL via template literals; body params are passed as `{ body: args }`; query params as `{ query: args }` — `TurnoClient` handles array-style `?foo[]=1&foo[]=2` encoding.

Tool count: 49 — covers all 51 distinct Turno v2 REST endpoints minus `GET /v2/oauth/authorize` (browser-only consent screen, not callable over MCP).

## Operational gotchas

- **Don't trust the Postman docs blindly.** They show `TBNB-Partner-ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` on every request as if it's a placeholder, but that's the actual literal UUID format and the header is genuinely required. The base URL examples (`sandbox.turnoverbnb.com`, `www.turnoverbnb.com`) are also misleading — see Architecture above.
- **JWT transcription errors are the #1 cause of `401 "Unauthenticated"`.** When debugging a token, copy-paste from the Turno UI directly. Capital `I` vs lowercase `l` and `O` vs `0` mistakes from screenshots will look correct visually but break signature validation.
- **Port 3009** on the VPS — pick a fresh port if standing up another service. `ss -tlnp` on the VPS first; ports 3000–3008 are taken.
- **No Docker.** This service runs as a plain systemd-managed Node process, matching the convention of every other `*.nlma.io` MCP server. Don't add Dockerfile/compose deploy paths.
- **Clean up smoke-test tenants.** `data/tenants.json` is the source of truth; edit it directly + `systemctl restart turno-mcp` to evict in-memory state.
