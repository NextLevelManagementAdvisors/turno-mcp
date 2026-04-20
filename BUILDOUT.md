# turno-mcp buildout

Sequenced punch list from highest-blast-radius (irreversible-if-broken) to
polish. Tick boxes as items land. Effort: **S** ≤30 min, **M** 1–3 h, **L** >3 h.

## Phase 1 — Irreversible-if-broken (do these first)

- [x] **Back up `TURNO_ENCRYPTION_KEY` off the VPS.** [S, manual]
  Surfaced 2026-04-20 from `/opt/turno-mcp/.env` for the user to stash in their
  vault. Without it, every tenant's stored Secret Key is permanently
  unrecoverable if the VPS is rebuilt.
- [x] **Verify cert auto-renewal end-to-end.** [S — done 2026-04-20]
  Dry-run succeeded for `turno.nlma.io`. While auditing, found that **none** of
  the 20 `*.nlma.io` certs had a per-cert `renew_hook` and
  `/etc/letsencrypt/renewal-hooks/deploy/` was empty — meaning nginx wouldn't
  reload after any renewal across the whole VPS. Installed a global hook at
  `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` (`nginx -t &&
  systemctl reload nginx`) which fires for every renewed cert. Fleet-wide fix.
- [x] **Add a `data/tenants.json.bak` snapshot before each `npm ci` in
      [deploy/push-to-vps.sh](deploy/push-to-vps.sh).** [S — done 2026-04-20]
  Snapshot block runs on the VPS inside the deploy heredoc: `cp -p
  data/tenants.json data/tenants.<UTC-timestamp>.json.bak`, then keeps the 5
  newest and deletes older ones. Seeded a baseline backup
  `data/tenants.20260420T180705Z.json.bak` so there's already a restore point
  before the next deploy.

## Phase 2 — Defense in depth on the edge

- [ ] **Rate-limit `/enroll` and `/token`.** [M]
  `express-rate-limit`, e.g. 5/hour/IP. Otherwise anyone with the URL can spray
  tenant creation and grow `tenants.json` unboundedly.
- [ ] **Validate the credential at enrollment time.** [M]
  After accepting Secret Key + Partner ID, do a single `GET /v2/userinfo` call
  before saving the tenant. Typos and bad partner-IDs surface at enroll, not on
  first MCP call. Persist the returned email/user-id as `tenant.label_meta` so
  `list()` shows the real account.
- [ ] **Tighten `/health` body.** [S]
  Include `version` (from package.json), `cert_expires_at` (read from
  `/etc/letsencrypt/live/turno.nlma.io/cert.pem` if mounted, else skip), and
  `last_outbound_error_at` (in-memory). Useful for monitoring.
- [ ] **Bump HSTS to one year** in nginx once a week of stability is logged. [S]

## Phase 3 — Tenant lifecycle

- [ ] **Admin endpoints, bearer-gated by `TURNO_ADMIN_TOKEN`.** [M]
  - `GET  /admin/tenants` — list (id, label, base_url, last_used_at)
  - `DELETE /admin/tenants/:id` — evict from registry + JSON
  - `POST /admin/tenants/:id/rotate` — issue a new `trn_…`, invalidate old hash
  Lets you stop SSHing in to edit `tenants.json`.
- [ ] **Tenant `last_outbound_status` field.** [S]
  Surface in `/admin/tenants` so a 401 from Turno (e.g. token revoked on their
  side) is visible without grepping logs.

## Phase 4 — Outbound reliability

- [ ] **Retry-with-backoff in [src/turno-client.ts](src/turno-client.ts).** [M]
  Retry on 429 + 5xx, max 3 attempts, exponential 200ms→1s→3s. Honor
  `Retry-After` header when present.
- [ ] **Per-request timeout (default 30s).** [S]
  `AbortController` so a hung Turno request can't pin a Node socket.
- [ ] **Graceful shutdown.** [S]
  `process.on('SIGTERM')` → close the Express listener, wait up to 10s for
  in-flight `StreamableHTTPServerTransport` sessions, then exit. Lets
  systemd `Restart=always` cycles not drop a tool call mid-flight.

## Phase 5 — Tests + CI

- [ ] **Vitest unit tests.** [M]
  - `tenants.test.ts` — encryption round-trip, bearer hash lookup, atomic
    write-and-rename, OAuth-variant deserialize forward-compat
  - `turno-client.test.ts` — URL builder (array `?foo[]=` encoding), header
    composition (Bearer + TBNB-Partner-ID both present), 4xx → `TurnoApiError`
  - `tools/_shared.test.ts` — `shapeToJsonSchema` for the four primitive types
    plus optional/array/enum, asserting `required[]` is correct
- [ ] **Integration smoke test** that boots the server on a random port, enrolls
      via `/token` with mocked fetch, and walks `initialize` → `tools/list` →
      a `tools/call` with the mock returning canned JSON. [M]
- [ ] **GitHub Actions.** [S]
  `.github/workflows/ci.yml` — `npm ci && npm run typecheck && npm test` on
  PRs to `main`. Matches the "private repo, single-developer" reality —
  cheap insurance.

## Phase 6 — Polish

- [ ] **README: concrete client wiring snippets.** [S]
  - Claude Desktop `~/.claude_desktop_config.json` block with `mcp-remote` +
    bearer header
  - claude.ai custom-connector setup (URL + bearer)
- [ ] **prettier + eslint** with the same config the other MCPs use. [S]
- [ ] **OAuth authorization-code flow.** [L]
  Only worth doing if you ever need to onboard partners who can't paste a JWT
  themselves. Hooks for it (`kind: "oauth"` in tenant schema) are already in
  place. New routes: `/oauth/start`, `/oauth/callback`. Refresh logic in
  `TurnoClient` for the 1-year token lifetime. **Skip unless real demand.**

## Out of scope (for now)

- Switching `tenants.json` to SQLite/Postgres — fine until tenant count > 100
  or concurrent writes become a problem
- Per-tenant feature flags / quotas
- Webhook ingestion endpoint (the MCP exposes Turno's webhook *management*
  tools but doesn't host receiver URLs — partners point Turno at their own
  callback)
- Metrics export (Prometheus etc.) — none of the other `*.nlma.io` MCPs have
  this either; revisit if you stand up a fleet-wide dashboard
