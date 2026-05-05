\set ON_ERROR_STOP on

-- Regression: duplicate (source, source_run_id) must be blocked by the unique index.
-- This SQL runs against local Supabase and always rolls back — no permanent state.

begin;

-- First insert must succeed.
insert into public.import_batches (source, source_run_id, row_count, valid_row_count, invalid_row_count)
values ('n8n', 'test-idempotency-run-001', 3, 2, 1);

-- Second insert with the same (source, source_run_id) must raise unique_violation.
do $$
begin
  begin
    insert into public.import_batches (source, source_run_id, row_count, valid_row_count, invalid_row_count)
    values ('n8n', 'test-idempotency-run-001', 3, 2, 1);
    raise exception 'duplicate batch insert unexpectedly succeeded — unique index is missing or wrong';
  exception
    when unique_violation then
      null; -- expected path
    when others then
      raise exception 'unexpected error on duplicate insert: [%] %', sqlstate, sqlerrm;
  end;
end
$$;

-- Assert exactly one batch row was created.
do $$
declare
  batch_count integer;
begin
  select count(*) into batch_count
  from public.import_batches
  where source = 'n8n' and source_run_id = 'test-idempotency-run-001';

  if batch_count <> 1 then
    raise exception 'Expected 1 batch row for run-001, found %', batch_count;
  end if;
end
$$;

rollback;

-- Independent source_run_id values are allowed to coexist.
begin;

insert into public.import_batches (source, source_run_id, row_count, valid_row_count, invalid_row_count)
values
  ('n8n', 'test-idempotency-run-A', 1, 1, 0),
  ('n8n', 'test-idempotency-run-B', 2, 1, 1);

do $$
declare
  batch_count integer;
begin
  select count(*) into batch_count
  from public.import_batches
  where source = 'n8n' and source_run_id in ('test-idempotency-run-A', 'test-idempotency-run-B');

  if batch_count <> 2 then
    raise exception 'Expected 2 distinct batch rows for run-A and run-B, found %', batch_count;
  end if;
end
$$;

rollback;

-- Blank source_run_id must be rejected by the check constraint.
begin;

do $$
begin
  begin
    insert into public.import_batches (source, source_run_id, row_count, valid_row_count, invalid_row_count)
    values ('n8n', '   ', 0, 0, 0);
    raise exception 'blank source_run_id unexpectedly inserted — check constraint is missing';
  exception
    when check_violation then
      null; -- expected path
    when others then
      raise exception 'unexpected error for blank source_run_id: [%] %', sqlstate, sqlerrm;
  end;
end
$$;

rollback;

-- Duplicate (batch_id, row_index) in import_items must be blocked.
begin;

do $$
declare
  new_batch_id uuid;
begin
  insert into public.import_batches (source, source_run_id, row_count, valid_row_count, invalid_row_count)
  values ('n8n', 'test-items-idempotency-run', 1, 1, 0)
  returning id into new_batch_id;

  insert into public.import_items (batch_id, row_index, status, raw_record, normalized_record)
  values (new_batch_id, 0, 'valid', '{}'::jsonb, '{}'::jsonb);

  begin
    insert into public.import_items (batch_id, row_index, status, raw_record, normalized_record)
    values (new_batch_id, 0, 'valid', '{}'::jsonb, '{}'::jsonb);
    raise exception 'duplicate (batch_id, row_index) unexpectedly inserted — unique index is missing';
  exception
    when unique_violation then
      null; -- expected path
    when others then
      raise exception 'unexpected error for duplicate row_index: [%] %', sqlstate, sqlerrm;
  end;
end
$$;

rollback;
