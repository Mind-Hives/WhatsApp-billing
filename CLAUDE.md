@AGENTS.md

# Project Context

## Snapshot: 2026-05-05

- The app is a Next.js 16.2.4 billing/admin workflow for WhatsApp phone-number billing.
- Dependencies are installed locally in `node_modules/`; this directory is ignored.
- Next.js route-handler docs were checked in `node_modules/next/dist/docs/` before touching API routes, per `AGENTS.md`.

## Current Architecture Work

- `supabase/migrations/20260505000200_simplified_architecture.sql` adds the simplified billing schema:
  - `companies`, `employees`, `phone_numbers`, and `number_assignments`
  - CSV import staging tables `import_batches` and `import_items`
  - Lago sync tracking tables `billing_sync_runs` and `billing_sync_items`
- CSV import is handled by `src/app/api/imports/csv/route.ts` and `src/features/imports/stage-batch.ts`.
- The legacy `src/app/api/imports/n8n/route.ts` remains available for JSON envelopes with `sourceRunId` and `rows`.
- Admin-only Lago sync routes are present:
  - `src/app/api/lago/sync-companies/route.ts`
  - `src/app/api/billing/sync-to-lago/route.ts`

## One-Time Sheet Import

- The cleaned Google Sheet export was staged locally under `tmp/imports/`.
- `tmp/imports/whatsapp-details-clean.csv` contains 230 valid rows.
- `tmp/imports/whatsapp-details-rejects.csv` contains 16 rejected rows.
- These files are intentionally ignored because they are one-time source data.

## Lago Notes

- Lago customer names should come from company/customer names, not location names.
- The local helper `tmp/imports/sync-lago-customers-from-clean-csv.mjs` was prepared for a dry-run-first sync, but no Lago or Supabase writes were executed because the shell did not contain the required credentials.
- Required env vars for that helper are `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `LAGO_API_URL`, and `LAGO_API_KEY`.

## Local Artifacts

- `graphify/` is a nested external clone from setup work and is ignored by this repo.
- `.npm-cache/` is local npm cache data and is ignored.
