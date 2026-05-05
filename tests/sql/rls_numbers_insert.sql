\set ON_ERROR_STOP on

begin;
set local role anon;

do $$
begin
  begin
    insert into public.numbers (phone_number)
    values ('+15550000001');
    raise exception 'anon insert unexpectedly succeeded';
  exception
    when others then
      if sqlstate <> '42501' or position('row-level security' in sqlerrm) = 0 then
        raise exception 'anon insert failed for an unexpected reason: [%] %', sqlstate, sqlerrm;
      end if;
  end;
end
$$;
rollback;

begin;
set local role authenticated;

do $$
begin
  perform count(*) from public.numbers;

  begin
    insert into public.numbers (phone_number)
    values ('+15550000002');
    raise exception 'authenticated insert unexpectedly succeeded';
  exception
    when others then
      if sqlstate <> '42501' or position('row-level security' in sqlerrm) = 0 then
        raise exception 'authenticated insert failed for an unexpected reason: [%] %', sqlstate, sqlerrm;
      end if;
  end;
end
$$;
rollback;
