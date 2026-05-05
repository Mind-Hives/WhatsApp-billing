begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create type public.app_user_role as enum ('admin');
create type public.number_twilio_status as enum (
  'unknown',
  'active',
  'inactive',
  'missing',
  'released'
);
create type public.number_assignment_status as enum (
  'unassigned',
  'assigned'
);
create type public.number_billing_status as enum (
  'billable',
  'excluded',
  'inactive'
);
create type public.audit_log_source as enum (
  'admin',
  'import',
  'twilio',
  'n8n',
  'system'
);

create table public.companies (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  billing_email text,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint companies_name_not_blank check (btrim(name) <> '')
);

create unique index companies_name_unique_idx on public.companies (lower(name));

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid references public.companies (id) on delete set null,
  email text not null,
  full_name text,
  role public.app_user_role not null default 'admin',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint users_email_not_blank check (btrim(email) <> '')
);

create unique index users_email_unique_idx on public.users (lower(email));
create index users_company_id_idx on public.users (company_id);

create table public.numbers (
  id uuid primary key default extensions.gen_random_uuid(),
  phone_number text not null,
  twilio_status public.number_twilio_status not null default 'unknown',
  assignment_status public.number_assignment_status not null default 'unassigned',
  billing_status public.number_billing_status not null default 'billable',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint numbers_phone_number_not_blank check (btrim(phone_number) <> '')
);

create unique index numbers_phone_number_unique_idx on public.numbers (phone_number);

create table public.assignment_history (
  id uuid primary key default extensions.gen_random_uuid(),
  number_id uuid not null references public.numbers (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete restrict,
  assigned_from timestamptz not null,
  assigned_to timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  closed_by_user_id uuid references auth.users (id) on delete set null,
  constraint assignment_history_date_order check (
    assigned_to is null or assigned_to >= assigned_from
  )
);

create index assignment_history_number_id_idx on public.assignment_history (number_id);
create index assignment_history_company_id_idx on public.assignment_history (company_id);
create index assignment_history_closed_by_user_id_idx on public.assignment_history (closed_by_user_id);
create unique index assignment_history_open_number_unique_idx
  on public.assignment_history (number_id)
  where assigned_to is null;

create table public.audit_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  entity_type text not null,
  entity_id text not null,
  action text not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  source public.audit_log_source not null default 'system',
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint audit_logs_entity_type_not_blank check (btrim(entity_type) <> ''),
  constraint audit_logs_entity_id_not_blank check (btrim(entity_id) <> ''),
  constraint audit_logs_action_not_blank check (btrim(action) <> '')
);

create index audit_logs_actor_user_id_idx on public.audit_logs (actor_user_id);
create index audit_logs_entity_lookup_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_created_at_idx on public.audit_logs (created_at desc);

revoke all on table public.companies from public;
revoke all on table public.users from public;
revoke all on table public.numbers from public;
revoke all on table public.assignment_history from public;
revoke all on table public.audit_logs from public;

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.companies to anon, authenticated;
grant select, insert, update, delete on table public.users to anon, authenticated;
grant select, insert, update, delete on table public.numbers to anon, authenticated;
grant select, insert, update, delete on table public.assignment_history to anon, authenticated;
grant select, insert, update, delete on table public.audit_logs to anon, authenticated;

alter table public.companies enable row level security;
alter table public.users enable row level security;
alter table public.numbers enable row level security;
alter table public.assignment_history enable row level security;
alter table public.audit_logs enable row level security;

create policy "authenticated users can read companies"
  on public.companies
  for select
  to authenticated
  using (true);

create policy "authenticated users can read users"
  on public.users
  for select
  to authenticated
  using (true);

create policy "authenticated users can read numbers"
  on public.numbers
  for select
  to authenticated
  using (true);

create policy "authenticated users can read assignment history"
  on public.assignment_history
  for select
  to authenticated
  using (true);

create policy "authenticated users can read audit logs"
  on public.audit_logs
  for select
  to authenticated
  using (true);

commit;
