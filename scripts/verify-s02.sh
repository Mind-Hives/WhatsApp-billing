#!/usr/bin/env bash
# verify-s02.sh — Repeatable verification sequence for S02 (n8n Import API & Staging).
# Runs: unit tests → SQL idempotency regression → e2e HTTP tests.
# Exit code 0 means all checks passed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

echo "=== S02 verification ==="

# Ensure a bearer secret is available for both the dev server and e2e tests.
# If N8N_IMPORT_SECRET is already exported, use it. Otherwise set a local test value.
if [ -z "${N8N_IMPORT_SECRET:-}" ]; then
  export N8N_IMPORT_SECRET="test-import-secret-local"
  echo "[verify-s02] N8N_IMPORT_SECRET not set — using fallback: test-import-secret-local"

  # Write to .env.local so the Next.js dev server started by Playwright picks it up.
  ENV_LOCAL="$PROJECT_ROOT/.env.local"
  if [ -f "$ENV_LOCAL" ] && grep -q "N8N_IMPORT_SECRET" "$ENV_LOCAL"; then
    echo "[verify-s02] N8N_IMPORT_SECRET already in .env.local — skipping write"
  else
    echo "" >> "$ENV_LOCAL"
    echo "N8N_IMPORT_SECRET=test-import-secret-local" >> "$ENV_LOCAL"
    echo "[verify-s02] Appended N8N_IMPORT_SECRET to .env.local"
  fi
fi

# ── Step 1: Unit tests ──────────────────────────────────────────────────────
echo ""
echo "--- [1/3] Unit tests: n8n route handler ---"
npm run test -- --run tests/unit/imports/n8n-route.test.ts

# ── Step 2: SQL idempotency regression ─────────────────────────────────────
echo ""
echo "--- [2/3] SQL idempotency regression ---"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
psql "$DB_URL" -f tests/sql/import_batches_idempotency.sql

# ── Step 3: E2E HTTP tests ──────────────────────────────────────────────────
echo ""
echo "--- [3/3] E2E HTTP tests: imports-n8n ---"
npx playwright test tests/e2e/imports-n8n.spec.ts --project=chromium

echo ""
echo "=== S02 verification PASSED ==="
