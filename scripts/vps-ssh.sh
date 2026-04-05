#!/usr/bin/env bash
# SSH into the trader-v2 VPS
# Usage: ./scripts/vps-ssh.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ ! -f "$ENV_FILE" ]; then
	echo "Error: .env file not found at $ENV_FILE" >&2
	exit 1
fi

# Extract values from .env
VPS_HOST=$(grep '^VPS_HOST=' "$ENV_FILE" | cut -d= -f2-)
VPS_USER=$(grep '^VPS_USER=' "$ENV_FILE" | cut -d= -f2-)

# Extract multi-line SSH key
KEY_FILE=$(mktemp)
trap 'rm -f "$KEY_FILE"' EXIT
python3 -c "
import re
with open('$ENV_FILE') as f:
    content = f.read()
m = re.search(r'VPS_SSH_KEY=\"?(-----BEGIN.*?-----END[^\n]+)\"?', content, re.DOTALL)
if m:
    print(m.group(1))
" > "$KEY_FILE"
chmod 600 "$KEY_FILE"

ssh -o StrictHostKeyChecking=no -i "$KEY_FILE" "$VPS_USER@$VPS_HOST" "$@"
