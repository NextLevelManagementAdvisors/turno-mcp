#!/usr/bin/env bash
# Deploy turno-mcp to the Hostinger VPS at /opt/turno-mcp.
# Mirrors the pattern used by baselane-mcp and hospitable-mcp.
#
# Usage:  ./deploy/push-to-vps.sh [host]
# Default host: root@178.16.141.166

set -euo pipefail

HOST="${1:-root@178.16.141.166}"
REMOTE_DIR="/opt/turno-mcp"
SERVICE_NAME="turno-mcp"
PUBLIC_HOST="${TURNO_PUBLIC_HOST:-turno.nlma.io}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "→ building"
(cd "$ROOT_DIR" && npm run build >/dev/null)

echo "→ packaging"
TARBALL="$(mktemp -u).tgz"
tar -czf "$TARBALL" -C "$ROOT_DIR" \
  package.json package-lock.json tsconfig.json \
  dist src deploy README.md

echo "→ pushing to $HOST"
scp -q "$TARBALL" "$HOST:/tmp/turno-mcp-push.tgz"

echo "→ extracting and restarting on $HOST"
ssh "$HOST" bash -s <<EOF
set -euo pipefail
mkdir -p "$REMOTE_DIR"
tar -xzf /tmp/turno-mcp-push.tgz -C "$REMOTE_DIR"
rm -f /tmp/turno-mcp-push.tgz
cd "$REMOTE_DIR"
npm ci --omit=dev --no-audit --no-fund

# Install systemd unit on first push
if [ ! -f /etc/systemd/system/${SERVICE_NAME}.service ]; then
  cp deploy/${SERVICE_NAME}.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable ${SERVICE_NAME}
  echo "   systemd unit installed"
fi

systemctl restart ${SERVICE_NAME}
sleep 1
systemctl --no-pager --lines=5 status ${SERVICE_NAME} || true
EOF

rm -f "$TARBALL"
echo "→ done. hit https://$PUBLIC_HOST/health to verify."
