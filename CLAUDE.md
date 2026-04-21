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

There is no test suite yet — `npm test` runs vitest but no tests are defined. Validation today is typecheck + an end-to-end smoke (boot http mode, `POST /token`, `POST /mcp` with `initialize` then `tools/list`).

Deploy to the production VPS:

```bash
./deploy/push-to-vps.sh   # tar+scp to root@178.16.141.166:/opt/turno-mcp, npm ci, systemctl restart
```

The service is live at `https://turno.nlma.io/mcp` on port 3009 behind nginx + Let's Encrypt. systemd unit name: `turno-mcp.service`. Config (`.env`, chmod 600) lives at `/opt/turno-mcp/.env`. **There is no tenant store on disk** — the MCP is fully stateless (see Architecture).

## Architecture

### Two transports from one entrypoint

[src/index.ts](src/index.ts) branches on `TRANSPORT`:

- `TRANSPORT=stdio` (default) — single-user local mode, credentials from env (`TURNO_API_TOKEN` + `TURNO_PARTNER_ID`). Builds one `TurnoClient`, registers tools on a stdio `Server`. Used by Claude Desktop / local CLI clients.
- `TRANSPORT=http` — multi-user Express + StreamableHTTP. Boots [src/http-server.ts](src/http-server.ts), which exposes `/` (landing page), `/health`, `/enroll` (HTML form), `/token` (OAuth client_credentials), and `/mcp` (bearer-authed transport).

In http mode every MCP request gets a fresh `Server` with tools bound to **the requesting user's** `ToolContext`, derived from credentials decrypted from their bearer JWT. A 60s in-memory `TurnoClient` cache ([src/client-cache.ts](src/client-cache.ts)) stops bursts from rebuilding clients per request.

### Stateless auth — no tenant store

The MCP issues self-contained signed JWTs as bearers. Format ([src/bearer.ts](src/bearer.ts)):

```
header.payload.signature   (JWT-compatible, HS256)
payload = { pid, b, ek: { iv, tag, ct }, exp }
  pid = Turno Partner ID UUID (cleartext)
  b   = Turno API base URL (cleartext)
  ek  = AES-256-GCM-encrypted Turno Secret Key
  exp = unix seconds, default 24h TTL
```

Both the HMAC signing key and the AES-GCM encryption key are HKDF-derived from the single root `TURNO_ENCRYPTION_KEY` ([src/crypto.ts](src/crypto.ts) `deriveKey(info)` — distinct `info` strings give independent keys).

What this buys:
- No `tenants.json` to back up or migrate
- "Multi-tenant" scales to N users with zero state per user
- Bearer revocation = rotate the user's Turno Secret Key in the Turno UI (the bearer becomes useless because the embedded credential is now invalid at the Turno layer)

What it costs:
- No server-side bearer revocation list. Lifetime is the JWT `exp` (24h default). Compromised bearer = wait out the TTL or rotate the Turno Secret Key.
- Losing `TURNO_ENCRYPTION_KEY` invalidates every active bearer (users re-enroll once). Back it up off the VPS.

### The Turno-side auth model is two-layered

1. **MCP edge auth** ([src/auth.ts](src/auth.ts)): clients hit `/mcp` with `Authorization: Bearer <our JWT>`. We verify the HMAC signature and decrypt the embedded Secret Key in memory only — never persisted.
2. **Outbound Turno auth** ([src/turno-client.ts](src/turno-client.ts)): every Turno v2 request requires **both** `Authorization: Bearer <secret-key-jwt>` AND `TBNB-Partner-ID: <uuid>`. Bearer-only returns `401 "Unable to identify the requesting entity"`.

The Turno Partner ID is shown in the dashboard at the **bottom of the API → Tokens page** as a small "Here is your Partner ID:" line — easy to miss, and required.

Production base URL is `https://api.turnoverbnb.com/v2`. **NOT** `www.turnoverbnb.com/v2` (which 301s to a Cloudflare-protected marketing site). The Postman collection ships stale examples pointing at sandbox/www; don't trust them blindly.

### `/token` endpoint — OAuth client_credentials

[src/http-server.ts](src/http-server.ts) accepts standard OAuth `grant_type=client_credentials` with `client_id` (Partner ID UUID) + `client_secret` (Secret Key JWT), via either form fields or HTTP Basic auth. On call:

1. Validates credentials with a real outbound `GET /v2/userinfo` to Turno
2. On success, signs and returns a 24h JWT bearer
3. On failure, returns `400 invalid_grant` with a clear reason

The legacy `grant_type=api_token` still works for backward-compatibility with anything wired against the original /token shape.

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

- **`TURNO_ENCRYPTION_KEY` is the single point of failure.** Lose it = every active bearer dies (users re-enroll once). Back it up off the VPS. Rotating it has the same effect — schedule maintenance windows accordingly.
- **Don't trust the Postman docs blindly.** They show `TBNB-Partner-ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` on every request as if it's a placeholder, but that's the actual literal UUID format and the header is genuinely required. The base URL examples (`sandbox.turnoverbnb.com`, `www.turnoverbnb.com`) are also misleading — see Architecture above.
- **JWT transcription errors are the #1 cause of `401 "Unauthenticated"`.** When debugging a Turno Secret Key, copy-paste from the Turno UI directly. Capital `I` vs lowercase `l` and `O` vs `0` mistakes from screenshots will look correct visually but break signature validation.
- **Port 3009** on the VPS — pick a fresh port if standing up another service. `ss -tlnp` on the VPS first; ports 3000–3008 are taken.
- **No Docker.** This service runs as a plain systemd-managed Node process, matching the convention of every other `*.nlma.io` MCP server. Don't add Dockerfile/compose deploy paths.
- **Bearer rotation = re-call /token.** Same credentials yield a fresh JWT on each call (idempotent only at the credential layer, not the bearer string). The previous bearer keeps working until its `exp`.
- **Legacy state**: `/opt/turno-mcp/.legacy-tenant-store/` holds the old `tenants.json` + snapshots from before the stateless refactor. Delete after a stability window if no rollback was needed.
