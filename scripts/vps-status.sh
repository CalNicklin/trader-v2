#!/usr/bin/env bash
# Quick status check for trader-v2 on the VPS
# Usage: ./scripts/vps-status.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "$SCRIPT_DIR/vps-ssh.sh" "sudo systemctl status trader-v2 --no-pager && echo '---' && curl -s http://localhost:3847/health | python3 -m json.tool 2>/dev/null || echo 'Health endpoint not reachable'"
