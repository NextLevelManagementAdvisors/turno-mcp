"""
Browser-fingerprinted egress for the Turno External API.

Why this exists
---------------
As of 2026-08-19 api.turnoverbnb.com sits behind Cloudflare Bot Management
that classifies on the TLS/HTTP2 fingerprint, not on credentials or on IP
reputation. Node's built-in fetch (undici) and stock curl both get

    HTTP 403 + `cf-mitigated: challenge` + a "Just a moment..." HTML body

for EVERY request, including unauthenticated ones. The same request from the
same host with a Chrome fingerprint (curl_cffi impersonate) gets a normal
`401 {"error":"Unauthenticated."}`. The block is purely the fingerprint.

This sidecar is the smallest thing that fixes it: a pinned, single-upstream
passthrough that re-issues each request with a browser fingerprint and hands
the upstream response back verbatim. turno-mcp keeps its own retry ladder and
error surfacing intact because status codes and bodies are not rewritten.

Deliberately NOT a general forward proxy: the upstream is pinned by env, so a
compromised container on the docker network cannot use this to reach arbitrary
hosts (SSRF pivot). It binds inside the compose network only, no published
port.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from curl_cffi import requests as cffi_requests

# Pinned upstream origin. Only the path+query of an inbound request is used;
# the host is never taken from the caller.
UPSTREAM = os.environ.get("EGRESS_UPSTREAM", "https://api.turnoverbnb.com").rstrip("/")

# curl_cffi impersonation target. Cloudflare eventually flags stale
# fingerprints, so this is env-tunable without a rebuild.
IMPERSONATE = os.environ.get("EGRESS_IMPERSONATE", "chrome131")

# Kept just under turno-mcp's own 30s per-attempt budget so the caller's
# timeout is the one that fires, not a half-written response.
TIMEOUT_S = float(os.environ.get("EGRESS_TIMEOUT_S", "25"))

BIND_HOST = os.environ.get("EGRESS_HOST", "0.0.0.0")
BIND_PORT = int(os.environ.get("EGRESS_PORT", "8000"))

MAX_BODY_BYTES = int(os.environ.get("EGRESS_MAX_BODY_BYTES", str(8 * 1024 * 1024)))

# Only these travel upstream. An allowlist rather than a denylist so a future
# caller cannot smuggle hop-by-hop or fingerprint-revealing headers (notably
# User-Agent, which curl_cffi sets to match the impersonated browser).
FORWARD_REQUEST_HEADERS = (
    "authorization",
    "tbnb-partner-id",
    "accept",
    "content-type",
)

# Hop-by-hop and transport-framing headers must not be copied back: the
# framing of OUR response is ours to set.
SKIP_RESPONSE_HEADERS = {
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "upgrade",
}

logging.basicConfig(
    level=os.environ.get("EGRESS_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("turno-egress")


def _is_challenge(status: int, body: bytes) -> bool:
    """A Cloudflare interstitial that slipped through despite impersonation."""
    return status == 403 and b"Just a moment" in body[:2048]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "turno-egress"
    sys_version = ""

    # BaseHTTPRequestHandler logs to stderr in its own format; route it
    # through logging so container logs stay uniform.
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes | None:
        """Return the request body, or None if it was rejected as too large."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY_BYTES:
            return None
        return self.rfile.read(length) if length > 0 else b""

    def _handle(self, method: str) -> None:
        # /_health is answered locally: it must stay green even when the
        # upstream is down, so container health never depends on Turno.
        if self.path == "/_health":
            self._send_json(
                200,
                {"ok": True, "upstream": UPSTREAM, "impersonate": IMPERSONATE},
            )
            return

        # Reject an absolute-form request-target. Accepting one would turn
        # this into an open forward proxy.
        if urlsplit(self.path).netloc or not self.path.startswith("/"):
            self._send_json(400, {"error": "egress: only origin-form paths are proxied"})
            return

        body = self._read_body()
        if body is None:
            self._send_json(413, {"error": "egress: request body too large"})
            return

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() in FORWARD_REQUEST_HEADERS
        }

        url = UPSTREAM + self.path
        try:
            upstream = cffi_requests.request(
                method,
                url,
                headers=headers,
                data=body or None,
                impersonate=IMPERSONATE,
                timeout=TIMEOUT_S,
                allow_redirects=False,
            )
        except Exception as exc:  # noqa: BLE001 - any transport failure is a 502
            log.warning(
                "upstream %s %s failed: %s: %s",
                method,
                self.path,
                type(exc).__name__,
                exc,
            )
            self._send_json(
                502,
                {
                    "error": "egress: upstream request failed",
                    "detail": f"{type(exc).__name__}: {exc}",
                },
            )
            return

        payload = upstream.content or b""

        # Surface a surviving challenge loudly. The caller still gets the
        # verbatim 403 so its own error handling is unchanged, but this line
        # is the signal that IMPERSONATE needs bumping.
        if _is_challenge(upstream.status_code, payload):
            log.warning(
                "cloudflare challenge SURVIVED impersonate=%s on %s %s"
                " - bump EGRESS_IMPERSONATE",
                IMPERSONATE,
                method,
                self.path,
            )
        else:
            log.info("%s %s -> %s", method, self.path, upstream.status_code)

        self.send_response(upstream.status_code)
        for key, value in upstream.headers.items():
            if key.lower() in SKIP_RESPONSE_HEADERS:
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle("PATCH")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")


def main() -> None:
    log.info(
        "turno-egress listening on %s:%s -> %s (impersonate=%s, timeout=%ss)",
        BIND_HOST,
        BIND_PORT,
        UPSTREAM,
        IMPERSONATE,
        TIMEOUT_S,
    )
    ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
