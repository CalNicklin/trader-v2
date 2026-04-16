#!/usr/bin/env bash
# Integration test for scripts/pull-insight-snapshot.sh
# Requires: .env with VPS credentials. Runs against production DB (read-only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAP_SCRIPT="$SCRIPT_DIR/pull-insight-snapshot.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() { echo "PASS: $*"; }

# ── Run the snapshot ──────────────────────────────────────────────────────

OUT=$("$SNAP_SCRIPT" | tail -n1)

# ── Assertions ────────────────────────────────────────────────────────────

[ -f "$OUT" ] || fail "snapshot file not found at $OUT"
pass "snapshot file exists at $OUT"

SIZE=$(wc -c < "$OUT" | tr -d ' ')
[ "$SIZE" -ge 2048 ] || fail "snapshot size $SIZE < 2048 bytes"
pass "snapshot size $SIZE >= 2048 bytes"

required_sections=(
  "## 1. Population snapshot"
  "## 2. Per-strategy metrics"
  "## 3. Recent paper trades"
  "## 4. Unacted high-confidence insights"
  "## 5. Insights already acted on"
  "## 6. Graduation events"
  "## 7. Strategy mutations"
  "## 8. News classification"
  "## 9. Token spend"
)

for section in "${required_sections[@]}"; do
  grep -qF "$section" "$OUT" || fail "missing section: $section"
  pass "section present: $section"
done

# Ensure the header block is present.
grep -qF "**VPS git SHA:**" "$OUT" || fail "missing VPS git SHA header"
pass "VPS git SHA header present"

# At least a handful of markdown table rows (starts with |) anywhere.
ROWS=$(grep -c '^|' "$OUT" || true)
[ "$ROWS" -ge 20 ] || fail "too few markdown rows in snapshot ($ROWS)"
pass "markdown rows: $ROWS"

echo ""
echo "All integration checks passed for $OUT"
