begin;

-- Staging surface for n8n import batches (one row per source run).
-- Service-role writes only; authenticated users get read-only SELECT via RLS.
-- Live production tables are never touched by this migration.

create table public.import_batches (
  id               uuid        primary key default extensions.gen_random_uuid(),
  source           text        not null default 'n8n',
  source_run_id    text        not null,
  status           text        not null default 'staged',
  payload_version  text,
  received_at      timestamptz not null default timezone('utc', now()),
  row_count        integer     not null default 0,
  valid_row_count  integer     not null default 0,
  invalid_row_count integer    not null default 0,
  raw_payload      jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default timezone('utc', now()),
  updated_at       timestamptz not null default timezone('utc', now()),
  constraint import_batches_source_not_blank      check (btrim(source) <> ''),
  constraint import_batches_source_run_id_not_blank check (btrim(source_run_id) <> ''),
  constraint import_batches_status_valid check (
    status in ('staged', 'committed', 'failed')
  ),
  constraint import_batches_row_count_nonneg       check (row_count >= 0),
  constraint import_batches_valid_row_count_nonneg check (valid_row_count >= 0),
  constraint import_batches_invalid_row_count_nonneg check (invalid_row_count >= 0)
);

-- Idempotency anchor: a second n8n retry for the same run must not create a new batch.
create unique index import_batches_source_run_unique_idx
  on public.import_batches (source, source_run_id);
create index import_batches_created_at_idx on public.import_batches (created_at desc);
create index import_batches_status_idx on public.import_batches (status);

-- Staged item rows — one per incoming logical record in the batch.
create table public.import_items (
  id               uuid        primary key default extensions.gen_random_uuid(),
  batch_id         uuid        not null references public.import_batches (id) on delete cascade,
  row_index        integer     not null,
  status           text        not null default 'valid',
  validation_error text,
  raw_record       jsonb       not null default '{}'::jsonb,
  normalized_record jsonb      not null default '{}'::jsonb,
  company_name     text,
  user_email       text,
  phone_number     text,
  created_at       timestamptz not null default timezone('utc', now()),
  updated_at       timestamptz not null default timezone('utc', now()),
  constraint import_items_row_index_nonneg check (row_index >= 0),
  constraint import_items_status_valid check (
    status in ('valid', 'validation_error', 'committed')
  )
);

create unique index import_items_batch_row_unique_idx
  on public.import_items (batch_id, row_index);
create index import_items_batch_status_idx on public.import_items (batch_id, status);

-- Revoke public privileges then grant DML to role principals.
-- RLS policies below restrict anon/authenticated to SELECT only;
-- service_role bypasses RLS and can INSERT/UPDATE/DELETE for route handlers.
revoke all on table public.import_batches from public;
revoke all on table public.import_items from public;

grant select, insert, update, delete on table public.import_batches to anon, authenticated;
grant select, insert, update, delete on table public.import_items to anon, authenticated;

alter table public.import_batches enable row level security;
alter table public.import_items enable row level security;

create policy "authenticated users can read import batches"
  on public.import_batches
  for select
  to authenticated
  using (true);

create policy "authenticated users can read import items"
  on public.import_items
  for select
  to authenticated
  using (true);

commit;
