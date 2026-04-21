# turno-mcp

Multi-user MCP server for [Turno](https://turno.com) (formerly TurnoverBnB).
Exposes the full v2 REST API — 49 tools covering properties, bookings, blocked
dates, projects, assignments, cleaners, checklists, problems, reviews, and
webhooks.

Two run modes:

- **stdio** — single user, credentials from `.env`. Good for local use and
  Claude Desktop.
- **http** — many users, StreamableHTTP + bearer auth. **Stateless**: each
  user's bearer is a self-contained signed JWT carrying their (encrypted)
  Turno credentials. No tenant store on disk.

## Quickstart (stdio)

```bash
npm install
npm run build

cat > .env <<EOF
TRANSPORT=stdio
TURNO_BASE_URL=https://api.turnoverbnb.com/v2
TURNO_API_TOKEN=<your-turno-secret-key>
TURNO_PARTNER_ID=<your-tbnb-partner-id-uuid>
EOF

npm start
```

Then wire into Claude Desktop / Claude Code with `node /path/to/turno-mcp/dist/src/index.js`.

## Quickstart (hosted / multi-user)

```bash
TRANSPORT=http \
HOST=0.0.0.0 \
PORT=3009 \
TURNO_PUBLIC_HOST=turno.nlma.io \
TURNO_ENCRYPTION_KEY=$(openssl rand -hex 32) \
TURNO_BASE_URL=https://api.turnoverbnb.com/v2 \
node dist/src/index.js
```

Visit `https://<public-host>/` for a setup walkthrough, or jump straight to
`/enroll`. The form requests:

1. **Label** — any name for this connection
2. **Secret Key** — the long `eyJ…` JWT shown once on Turno → API → Tokens → "Create New Token"
3. **TBNB-Partner-ID** — UUID at the bottom of the Tokens page ("Here is your Partner ID:")
4. **Base URL** — prod or sandbox

On success the browser shows a one-time bearer JWT + the MCP endpoint URL.
Wire it into an MCP client via `mcp-remote`:

```bash
mcp-remote https://turno.nlma.io/mcp \
  --header "Authorization: Bearer eyJhbG…"
```

OAuth-aware clients (claude.ai custom connectors, etc.) can configure OAuth
settings instead of pre-enrolling — no manual visit to `/enroll` needed:

| Field         | Value                                              |
|---------------|----------------------------------------------------|
| Token URL     | `https://turno.nlma.io/token`                      |
| Client ID     | your Turno **Partner ID** (UUID)                   |
| Client Secret | your Turno **Secret Key** (the `eyJ…` JWT)        |
| Grant type    | `client_credentials`                               |

The connector POSTs `client_credentials` to `/token`, the server validates the
credentials by calling Turno's `/userinfo`, then issues a 24h JWT bearer used
for subsequent `/mcp` calls. Refresh is automatic.

Programmatic enrollment (CI/bots, curl):

```bash
curl -X POST https://turno.nlma.io/token \
  -H 'Content-Type: application/json' \
  -d '{
    "grant_type": "client_credentials",
    "client_id":  "<partner-id-uuid>",
    "client_secret": "<turno-secret-key-jwt>"
  }'
# → { "access_token": "eyJhbG…", "token_type": "Bearer", "expires_in": 86400 }
```

## Auth model

**Edge** — clients hit `/mcp` with `Authorization: Bearer <our JWT>`. The
JWT is HMAC-SHA256 signed with a key derived from `TURNO_ENCRYPTION_KEY`,
and carries the user's Turno Secret Key encrypted (AES-256-GCM with a
separate HKDF-derived key) inside the payload. Verification + decryption
happen in memory only — nothing persists.

**Outbound** — every Turno v2 request needs **both** `Authorization: Bearer
<turno-jwt>` AND `TBNB-Partner-ID: <uuid>`. The Turno Partner ID is shown at
the bottom of the API → Tokens page in the Turno dashboard ("Here is your
Partner ID:") — easy to miss, and required.

Production base URL is `https://api.turnoverbnb.com/v2`. **NOT**
`www.turnoverbnb.com/v2` (that 301s to a Cloudflare-protected marketing site).

## Bearer lifetime + revocation

- 24 h TTL by default. After that, the OAuth client refreshes by calling
  `/token` again with the same credentials — gets a fresh JWT.
- No server-side revocation list. To kill a bearer immediately, **delete the
  Turno API token in the Turno dashboard** — the embedded Secret Key becomes
  invalid at the Turno layer, every active bearer for it stops working.
- Rotating `TURNO_ENCRYPTION_KEY` invalidates every active bearer (users
  re-enroll once). Treat the key like the secret it is — back it up off-VPS.

## Deployment (Hostinger VPS)

See [deploy/turno-mcp.service](deploy/turno-mcp.service) (systemd unit) and
[deploy/push-to-vps.sh](deploy/push-to-vps.sh) (tar + scp + restart). Mirrors
the pattern used by the other `*.nlma.io` MCP servers.

## Development

```bash
npm run dev        # stdio mode with tsx watch
npm run dev:http   # http mode with tsx watch
npm run typecheck
npm run build
```
