# turno-mcp buildout

Sequenced punch list from highest-blast-radius (irreversible-if-broken) to
polish. Tick boxes as items land. Effort: **S** ≤30 min, **M** 1–3 h, **L** >3 h.

## Phase 0 — Stateless rearchitecture (replaces Phases 2.2 + 3 wholesale)

- [x] **Drop the tenant store. Bearers become self-contained signed JWTs.** [M — done 2026-04-21]
  Refactored `auth.ts` to verify a JWT (HS256, HMAC-SHA256 key derived from
  `TURNO_ENCRYPTION_KEY`) and decrypt the embedded Turno Secret Key (AES-256-GCM,
  separately-derived key) in memory only. Added `src/bearer.ts` for sign/verify,
  `src/client-cache.ts` for a 60s in-process `TurnoClient` cache. Deleted
  `src/tenants.ts` and `src/tenant-registry.ts`. `/token` now accepts standard
  OAuth `grant_type=client_credentials`, validates credentials with a real
  outbound `/userinfo` call, and returns a 24h JWT. `/enroll` does the same
  flow with the HTML form. Old `tenants.json` archived to
  `/opt/turno-mcp/.legacy-tenant-store/` on the VPS for rollback.
  - Subsumes Phase 2 item 2 (credential validation at enrollment time)
  - Subsumes Phase 3 (tenant lifecycle / admin endpoints — no state to manage)
  - Phase 1 item 3 (tenants.json snapshot in deploy script) is now dead code

## Phase 1 — Irreversible-if-broken (do these first)

- [x] **Back up `TURNO_ENCRYPTION_KEY` off the VPS.** [S, manual]
  Surfaced 2026-04-20 from `/opt/turno-mcp/.env` for the user to stash in their
  vault. With the stateless refactor this is even more critical — the key now
  signs every active bearer; rotating or losing it forces all users to re-enroll.
- [x] **Verify cert auto-renewal end-to-end.** [S — done 2026-04-20]
  Dry-run succeeded for `turno.nlma.io`. While auditing, found that **none** of
  the 20 `*.nlma.io` certs had a per-cert `renew_hook` and
  `/etc/letsencrypt/renewal-hooks/deploy/` was empty — meaning nginx wouldn't
  reload after any renewal across the whole VPS. Installed a global hook at
  `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` (`nginx -t &&
  systemctl reload nginx`) which fires for every renewed cert. Fleet-wide fix.
- [x] ~~Add a `data/tenants.json.bak` snapshot before each `npm ci`.~~ [obsoleted by Phase 0]
  Snapshot block was added 2026-04-20 then removed 2026-04-21 with the stateless
  refactor (no more `tenants.json` to snapshot).

## Phase 2 — Defense in depth on the edge

- [x] **Rate-limit `/enroll` and `/token`.** [M — done 2026-04-20]
  `express-rate-limit` at 5/hour/IP on the two POST endpoints. Returns 429 with
  draft-7 `RateLimit-*` + `Retry-After` headers.
- [x] ~~Validate the credential at enrollment time.~~ [done 2026-04-21 as part of Phase 0]
  Both `/enroll` and `/token` now call `GET /v2/userinfo` against the supplied
  credentials before issuing a bearer; bad creds get a 400 with a useful error.
- [x] **Tighten `/health` body.** [S — done 2026-04-21]
  `/health` now returns `version` (from package.json via
  [src/health-state.ts](src/health-state.ts)), `cert_expires_at` (from
  `TURNO_CERT_PATH`, derived from `PUBLIC_HOST` so it follows the Let's
  Encrypt convention; new [src/cert-info.ts](src/cert-info.ts) reads via
  Node's `X509Certificate` with hourly cache), and `last_outbound_error_at`
  (in-memory record set by `TurnoClient` on any non-ok response). Missing
  cert file = field omitted (dev boxes stay quiet). Verified live:
  `cert_expires_at: 2026-07-19T08:54:07.000Z`.
- [ ] **Bump HSTS to one year** in nginx once a week of stability is logged. [S, manual]
  Nginx config on the VPS — outside the automated skill's scope. When
  ready (~1 week after 2026-04-20 deploy):
  `ssh root@178.16.141.166 "sed -i 's|max-age=300|max-age=31536000|' /etc/nginx/sites-available/turno.nlma.io && nginx -t && systemctl reload nginx"`

## Phase 3 — ~~Tenant lifecycle~~ [obsoleted by Phase 0]

The stateless refactor removed the tenant store entirely, so admin endpoints
for listing/deleting/rotating tenants no longer have state to operate on.
Bearer revocation = delete the Turno API token in the Turno dashboard, OR
rotate `TURNO_ENCRYPTION_KEY` (invalidates everyone's bearer).

## Phase 4 — Outbound reliability

- [x] **Retry-with-backoff in [src/turno-client.ts](src/turno-client.ts).** [M — done 2026-04-21]
  Retry on 429 or 5xx, max 3 attempts (2 retries), delay ladder 200ms→1s.
  Honors `Retry-After` when the server sends it (capped at 30s to protect
  callers). Non-retriable status codes throw on first attempt. Verified via
  a 4-case mock-fetch unit check: 3-attempts-succeed, throws-after-max,
  no-retry-on-4xx, retry-after-honored.
- [x] **Per-request timeout (default 30s).** [S — done 2026-04-21]
  Each fetch attempt in TurnoClient now uses `AbortSignal.timeout(timeoutMs)`
  so a hung Turno socket can't pin a Node handler. Default 30000ms, override
  via `TURNO_REQUEST_TIMEOUT_MS`. Timeouts (and other network errors) are
  caught and fed through the same retry ladder as 429/5xx — after the final
  attempt we throw a new `TurnoNetworkError` (with `timedOut: boolean`).
  Verified via 3-case unit check (timeout-then-throw, timeout-then-recover,
  default-accepts).
- [x] **Graceful shutdown.** [S — done 2026-04-21]
  SIGTERM/SIGINT now stops accepting new connections (`server.close()` +
  `closeIdleConnections()`), then waits for the `transports` map to drain
  up to `TURNO_SHUTDOWN_TIMEOUT_MS` (default 10s) before exiting.
  Re-entrancy-guarded so a double signal is a no-op. Verified live via
  `systemctl restart` — journal shows `graceful shutdown starting` →
  `graceful shutdown complete — all sessions drained` within ~1ms when
  idle; systemd handoff clean.

## Phase 5 — Tests + CI

- [x] **Vitest unit tests.** [M — done 2026-04-21]
  16 tests in `tests/unit/` covering the full Phase 5 spec:
  - `bearer.test.ts` (4) — sign/verify round-trip, tamper rejection,
    expiry rejection, malformed-payload rejection
  - `crypto.test.ts` (4) — `deriveKey` independence + determinism,
    encrypt/decrypt round-trip, fresh-IV-per-encryption guarantee
  - `turno-client.test.ts` (4) — literal `[]=` array encoding,
    Bearer + TBNB-Partner-ID header composition, Partner-ID omitted
    when unset, 4xx → `TurnoApiError`
  - `tools-shared.test.ts` (4) — `shapeToJsonSchema` for primitives,
    optional/default excluded from `required[]`, array item nesting,
    `.describe()` → `description` field
- [x] **Integration smoke test** that boots the server on a random port, calls
      `/token` with mocked outbound fetch, walks `initialize` → `tools/list` →
      a `tools/call` with the mock returning canned JSON. [M — done 2026-04-21]
  `tests/integration/mcp-smoke.test.ts` — 5 cases covering the whole
  auth + MCP flow. Monkey-patches `globalThis.fetch` to intercept
  `api.turnoverbnb.com` only (localhost passes through), then:
  `/token` → bearer JWT → `initialize` → `tools/list` (≥40 tools,
  turno_get_userinfo + turno_list_properties present) →
  `tools/call turno_get_userinfo` (mocked data round-trips) → 401
  on unknown bearer. Cleans up: restores fetch, closes server. Runs
  in ~650ms.
- [ ] **GitHub Actions.** [S]
  `.github/workflows/ci.yml` — `npm ci && npm run typecheck && npm test` on
  PRs to `main`.

## Phase 6 — Polish

- [x] **Public landing page at `GET /` with client wiring snippets.** [S — done 2026-04-21]
  Replaced the bare 404. 4-step setup walkthrough with tabs for claude.ai,
  Claude Desktop, Claude Code, Cursor, and mcp-remote/curl. Live at
  [turno.nlma.io](https://turno.nlma.io/).
- [x] ~~README: client wiring snippets~~ [done 2026-04-21]
  Updated for stateless JWT model + OAuth client_credentials section.
- [ ] **prettier + eslint** with the same config the other MCPs use. [S]
- [ ] **Delete `/opt/turno-mcp/.legacy-tenant-store/`** after a stability
      window (~1 week with no rollback needed). [S, manual]

## Out of scope (for now)

- Per-user feature flags / quotas (would require adding state back)
- Webhook ingestion endpoint (the MCP exposes Turno's webhook *management*
  tools but doesn't host receiver URLs — partners point Turno at their own
  callback)
- Metrics export (Prometheus etc.) — none of the other `*.nlma.io` MCPs have
  this either; revisit if you stand up a fleet-wide dashboard
- OAuth authorization-code flow — only worth doing if onboarding partners who
  can't paste their own Secret Key
