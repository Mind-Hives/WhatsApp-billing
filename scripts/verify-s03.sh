#!/usr/bin/env bash
# verify-s03.sh — Repeatable verification for S03 (Import Review UI & Commit).
# Runs: unit tests → e2e browser tests.
# Exit code 0 means all checks passed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Export local env values for the Playwright test runner as well as the Next.js dev server.
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env.local"
  set +a
fi

echo "=== S03 verification ==="

# Ensure a bearer secret is available for both the dev server and e2e tests.
# If N8N_IMPORT_SECRET is already exported, use it. Otherwise set a local test value.
if [ -z "${N8N_IMPORT_SECRET:-}" ]; then
  export N8N_IMPORT_SECRET="test-import-secret-local"
  echo "[verify-s03] N8N_IMPORT_SECRET not set — using fallback: test-import-secret-local"

  # Write to .env.local so the Next.js dev server started by Playwright picks it up.
  ENV_LOCAL="$PROJECT_ROOT/.env.local"
  if [ -f "$ENV_LOCAL" ] && grep -q "N8N_IMPORT_SECRET" "$ENV_LOCAL"; then
    echo "[verify-s03] N8N_IMPORT_SECRET already in .env.local — skipping write"
  else
    echo "" >> "$ENV_LOCAL"
    echo "N8N_IMPORT_SECRET=test-import-secret-local" >> "$ENV_LOCAL"
    echo "[verify-s03] Appended N8N_IMPORT_SECRET to .env.local"
  fi
fi

# ── Step 1: Unit tests ──────────────────────────────────────────────────────
echo ""
echo "--- [1/2] Unit tests: commit-batch ---"
npm run test -- --run tests/unit/imports/commit-batch.test.ts

# ── Step 2: E2E browser tests ───────────────────────────────────────────────
echo ""
echo "--- [2/2] E2E browser tests: imports-review ---"
npx playwright test tests/e2e/imports-review.spec.ts --project=chromium

echo ""
echo "=== S03 verification PASSED ==="
