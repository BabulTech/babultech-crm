-- The values in use for the leads list's prospecting filters (ICP tier,
-- region, lead list). Runs as the caller, so row-level security limits it to
-- leads they can see; only a whitelisted column can be asked for.

create or replace function lead_distinct_values(p_column text)
returns table (value text)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_column not in ('icpTier', 'region', 'leadList') then
    raise exception 'Not a filterable lead column: %', p_column using errcode = '22023';
  end if;
  return query execute format(
    'select distinct %1$I::text from lead where %1$I is not null and "deletedAt" is null order by 1',
    p_column
  );
end;
$$;

revoke all on function lead_distinct_values(text) from public, anon;
grant execute on function lead_distinct_values(text) to authenticated;
