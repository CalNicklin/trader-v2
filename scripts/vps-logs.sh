#!/usr/bin/env bash
# View trader-v2 logs from the VPS
# Usage:
#   ./scripts/vps-logs.sh          # last 100 lines
#   ./scripts/vps-logs.sh -f       # follow (live tail)
#   ./scripts/vps-logs.sh -n 500   # last 500 lines
#   ./scripts/vps-logs.sh --since "1 hour ago"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default: last 100 lines
JOURNAL_ARGS="-n 100 --no-pager"

# Parse args
while [[ $# -gt 0 ]]; do
	case "$1" in
		-f|--follow)
			JOURNAL_ARGS="-f"
			shift
			;;
		-n)
			JOURNAL_ARGS="-n $2 --no-pager"
			shift 2
			;;
		--since)
			JOURNAL_ARGS="--since '$2' --no-pager"
			shift 2
			;;
		*)
			JOURNAL_ARGS="$*"
			break
			;;
	esac
done

exec "$SCRIPT_DIR/vps-ssh.sh" "sudo journalctl -u trader-v2 $JOURNAL_ARGS"
