# turno-mcp

Multi-tenant MCP server for [Turno](https://turno.com) (formerly TurnoverBnB).
Exposes the full v2 REST API — 49 tools covering properties, bookings, blocked
dates, projects, assignments, cleaners, checklists, problems, reviews, and
webhooks.

Two run modes:

- **stdio** — single user, credentials from `.env`. Good for local use and
  Claude Desktop.
- **http** — multi-tenant, StreamableHTTP + bearer auth. Each tenant enrolls
  once (paste Turno API token + Partner ID), receives a `trn_...` bearer, and
  connects any MCP client from anywhere.

## Quickstart (stdio)

```bash
npm install
npm run build

cat > .env <<EOF
TRANSPORT=stdio
TURNO_BASE_URL=https://www.turnoverbnb.com/v2
TURNO_API_TOKEN=<your-turno-api-token>
TURNO_PARTNER_ID=<your-tbnb-partner-id-uuid>
EOF

npm start
```

Then wire into Claude Desktop / Claude Code with `node /path/to/turno-mcp/dist/src/index.js`.

## Quickstart (hosted / multi-tenant)

```bash
TRANSPORT=http \
HOST=0.0.0.0 \
PORT=3007 \
TURNO_PUBLIC_HOST=turno.nlma.io \
TURNO_ENCRYPTION_KEY=$(openssl rand -hex 32) \
TURNO_DATA_DIR=/opt/turno-mcp/data \
TURNO_TENANTS_FILE=/opt/turno-mcp/data/tenants.json \
TURNO_BASE_URL=https://www.turnoverbnb.com/v2 \
node dist/src/index.js
```

Visit `https://<public-host>/enroll` to enroll. The form requests:

1. **Label** — any name for this tenant
2. **Turno API token** — from your Turno partner dashboard
3. **TBNB-Partner-ID** — UUID issued by Turno
4. **Base URL** — prod or sandbox (per tenant)

On success the browser shows a one-time `trn_...` bearer + the MCP endpoint URL.
Wire it into an MCP client via `mcp-remote`:

```bash
mcp-remote https://turno.nlma.io/mcp \
  --header "Authorization: Bearer trn_…"
```

Programmatic enrollment (for CI/bots, no browser):

```bash
curl -X POST https://turno.nlma.io/token \
  -H 'Content-Type: application/json' \
  -d '{
    "grant_type": "api_token",
    "label": "my-integration",
    "api_token": "<turno-api-token>",
    "partner_id": "<uuid>",
    "base_url": "https://www.turnoverbnb.com/v2"
  }'
# → { "access_token": "trn_…", "token_type": "Bearer", "expires_in": 31536000 }
```

## Auth model

Every Turno API v2 request needs **both** a Bearer token and a
`TBNB-Partner-ID: <uuid>` header. The MCP stores both per-tenant:

- `api_token` — encrypted with AES-256-GCM (HKDF-derived from
  `TURNO_ENCRYPTION_KEY`), decrypted only in-memory when the server makes
  outbound API calls
- `partner_id` — stored as a plain UUID (not a secret — it's an account
  identifier)

The tenant schema uses a discriminated union (`kind: "api_token" | "oauth"`)
so the upcoming OAuth authorization-code flow can store `access_token`,
`refresh_token`, and `expires_at` alongside the partner ID without reshaping
existing tenants.

## Endpoint map

Base path: `/v2/` → `turno_<resource>_<action>` MCP tool.

| Resource       | Tools                                                                 |
|----------------|-----------------------------------------------------------------------|
| assignments    | create, cancel                                                        |
| blocked dates  | list, get, create, update, delete                                     |
| bookings       | list, get, create, update, delete                                     |
| checklists     | list                                                                  |
| cleaners       | list, get-properties, add-to-property, update, remove-from-property   |
| OAuth          | get-userinfo, token-exchange                                          |
| problems       | list, create, update                                                  |
| projects       | list, get, create, update, delete, notify-early-checkout, list-types, get-checklist |
| properties     | list, get, create, update, disconnect, + checklists + contractors     |
| reviews        | list                                                                  |
| webhooks       | list-types, list, get, create, delete                                 |

See Turno's [External API v2 docs](https://apidocs.turnoverbnb.com/) for
per-endpoint field semantics.

## Deployment (Hostinger VPS)

See `deploy/turno-mcp.service` (systemd unit) and `deploy/push-to-vps.sh`
(tar + scp + restart). Mirrors the pattern used by the other `*.nlma.io` MCP
servers.

## Development

```bash
npm run dev        # stdio mode with tsx watch
npm run dev:http   # http mode with tsx watch
npm run typecheck
npm run build
```
