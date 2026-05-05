begin;

create type public.company_billing_status as enum ('active', 'inactive');
create type public.employee_status as enum ('active', 'inactive');
create type public.phone_twilio_status as enum ('active', 'inactive', 'missing', 'unknown');
create type public.phone_billing_status as enum ('billable', 'excluded', 'suspended', 'non_billable');
create type public.assignment_status as enum ('active', 'ended');
create type public.record_source as enum ('csv', 'manual', 'twilio', 'lago', 'system');
create type public.import_batch_status as enum ('pending_review', 'committed', 'rejected', 'not_committable');
create type public.import_item_status as enum ('ready', 'validation_error', 'skipped', 'committed');
create type public.import_change_type as enum ('new_number', 'new_company', 'new_employee', 'reassignment', 'unchanged', 'duplicate');
create type public.billing_sync_status as enum ('pending', 'sent', 'failed', 'partial');
create type public.billing_sync_item_status as enum ('pending', 'sent', 'failed', 'skipped');
create type public.audit_actor_type as enum ('admin', 'system');

create table if not exists public.companies (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  billing_email text,
  lago_customer_id text,
  lago_external_customer_id text unique,
  lago_subscription_id text,
  billing_status public.company_billing_status not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint companies_name_not_blank check (btrim(name) <> '')
);

alter table public.companies add column if not exists lago_customer_id text;
alter table public.companies add column if not exists lago_external_customer_id text;
alter table public.companies add column if not exists lago_subscription_id text;
alter table public.companies add column if not exists billing_status public.company_billing_status not null default 'active';
create unique index if not exists companies_lago_external_customer_id_unique_idx
  on public.companies (lago_external_customer_id)
  where lago_external_customer_id is not null;

create table if not exists public.employees (
  id uuid primary key default extensions.gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  full_name text not null,
  email text,
  working_location text,
  department text,
  status public.employee_status not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint employees_full_name_not_blank check (btrim(full_name) <> '')
);
create index if not exists employees_company_id_idx on public.employees (company_id);
create unique index if not exists employees_company_email_unique_idx
  on public.employees (company_id, lower(email))
  where email is not null;

create table if not exists public.phone_numbers (
  id uuid primary key default extensions.gen_random_uuid(),
  e164_number text not null unique,
  twilio_sid text,
  twilio_status public.phone_twilio_status not null default 'unknown',
  billing_status public.phone_billing_status not null default 'billable',
  billing_override_reason text,
  notes text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint phone_numbers_e164_not_blank check (btrim(e164_number) <> '')
);
create index if not exists phone_numbers_twilio_status_idx on public.phone_numbers (twilio_status);
create index if not exists phone_numbers_billing_status_idx on public.phone_numbers (billing_status);

create table if not exists public.number_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  phone_number_id uuid not null references public.phone_numbers (id) on delete cascade,
  employee_id uuid references public.employees (id) on delete set null,
  company_id uuid not null references public.companies (id) on delete restrict,
  assigned_from timestamptz not null,
  assigned_to timestamptz,
  status public.assignment_status not null default 'active',
  source public.record_source not null default 'manual',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint number_assignments_date_order check (assigned_to is null or assigned_to >= assigned_from)
);
create unique index if not exists number_assignments_one_active_number_idx
  on public.number_assignments (phone_number_id)
  where status = 'active' and assigned_to is null;
create index if not exists number_assignments_company_status_idx
  on public.number_assignments (company_id, status);

drop table if exists public.import_items cascade;
drop table if exists public.import_batches cascade;

create table public.import_batches (
  id uuid primary key default extensions.gen_random_uuid(),
  filename text not null,
  source text not null default 'csv',
  status public.import_batch_status not null default 'pending_review',
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  invalid_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  committed_at timestamptz
);

create table public.import_items (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_id uuid not null references public.import_batches (id) on delete cascade,
  row_number integer not null,
  raw_row jsonb not null default '{}'::jsonb,
  normalized_row jsonb not null default '{}'::jsonb,
  status public.import_item_status not null,
  error_messages jsonb not null default '[]'::jsonb,
  detected_change_type public.import_change_type,
  created_at timestamptz not null default timezone('utc', now())
);
create index import_items_batch_status_idx on public.import_items (batch_id, status);

create table if not exists public.billing_sync_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  billing_month text not null,
  idempotency_key text not null unique,
  status public.billing_sync_status not null default 'pending',
  total_companies integer not null default 0,
  total_billable_numbers integer not null default 0,
  total_estimated_amount numeric(12, 2) not null default 0,
  started_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  error_message text,
  constraint billing_sync_runs_month_format check (billing_month ~ '^\d{4}-\d{2}$')
);

create table if not exists public.billing_sync_items (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references public.billing_sync_runs (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete restrict,
  active_billable_number_count integer not null default 0,
  estimated_amount numeric(12, 2) not null default 0,
  lago_customer_id text,
  lago_event_id text,
  status public.billing_sync_item_status not null default 'pending',
  error_message text
);
create index if not exists billing_sync_items_run_id_idx on public.billing_sync_items (run_id);

alter table public.audit_logs drop constraint if exists audit_logs_entity_id_not_blank;
alter table public.audit_logs add column if not exists actor_type public.audit_actor_type not null default 'system';
alter table public.audit_logs add column if not exists actor_id uuid;
alter table public.audit_logs alter column source type text using source::text;
alter table public.audit_logs alter column entity_id drop not null;

grant select, insert, update, delete on table public.companies to authenticated;
grant select, insert, update, delete on table public.employees to authenticated;
grant select, insert, update, delete on table public.phone_numbers to authenticated;
grant select, insert, update, delete on table public.number_assignments to authenticated;
grant select, insert, update, delete on table public.import_batches to authenticated;
grant select, insert, update, delete on table public.import_items to authenticated;
grant select, insert, update, delete on table public.billing_sync_runs to authenticated;
grant select, insert, update, delete on table public.billing_sync_items to authenticated;

alter table public.employees enable row level security;
alter table public.phone_numbers enable row level security;
alter table public.number_assignments enable row level security;
alter table public.billing_sync_runs enable row level security;
alter table public.billing_sync_items enable row level security;

create policy "authenticated users can read employees" on public.employees for select to authenticated using (true);
create policy "authenticated users can read phone numbers" on public.phone_numbers for select to authenticated using (true);
create policy "authenticated users can read number assignments" on public.number_assignments for select to authenticated using (true);
create policy "authenticated users can read billing sync runs" on public.billing_sync_runs for select to authenticated using (true);
create policy "authenticated users can read billing sync items" on public.billing_sync_items for select to authenticated using (true);

commit;
