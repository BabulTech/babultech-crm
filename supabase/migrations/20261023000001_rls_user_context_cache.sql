-- Row security reads who the caller is once per transaction, not once per row.
--
-- Every policy leans on the same few helpers - app_current_scope(),
-- app_current_partner_id(), app_current_user_type(), app_has_permission() - and
-- each of them read app_user (and security_role) afresh on every call. A
-- policy calls several of them per row: app_project_access() alone made about
-- eight such lookups for each project. Counting fifteen projects took 65ms
-- inside the database, and the dashboard's summary 300ms, for data that
-- cannot change between one row and the next.
--
-- app_user_ctx() reads the caller's row once and keeps it in a
-- transaction-local setting; the helpers read from that. Same answers, same
-- signatures, so no policy changes. The setting is keyed by user id, so a
-- transaction that switches identity (a job setting app.user_id) reads afresh,
-- and it is gone when the transaction ends - a role change shows on the very
-- next request.
--
-- Trust is unchanged: these functions already take the caller's identity from
-- request settings (auth.uid(), app.user_id), which only the server and
-- trusted direct connections can set.

create or replace function app_user_ctx()
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := app_current_user_id();
  v_raw text;
  v_ctx text[];
begin
  if v_uid is null then
    return null;
  end if;

  v_raw := current_setting('app.user_ctx', true);
  if v_raw is not null and v_raw <> '' then
    v_ctx := v_raw::text[];
    if v_ctx[1] = v_uid::text then
      return v_ctx;
    end if;
  end if;

  -- [1] user id  [2] scope  [3] partner id  [4] user type - these three only
  -- for an active, undeleted login, as the helpers they replace required -
  -- [5] the role's permissions, which app_has_permission read without that
  -- condition. '' stands for null.
  select array[
      v_uid::text,
      coalesce(case when u.status = 'ACTIVE' and u."deletedAt" is null then r."dataScope"::text end, ''),
      coalesce(case when u.status = 'ACTIVE' and u."deletedAt" is null then u."partnerId"::text end, ''),
      coalesce(case when u.status = 'ACTIVE' and u."deletedAt" is null then u."userType"::text end, ''),
      coalesce(r.permissions::text, '')
    ]
    into v_ctx
    from app_user u
    left join security_role r on r.id = u."roleId"
    where u.id = v_uid;

  v_ctx := coalesce(v_ctx, array[v_uid::text, '', '', '', '']);
  perform set_config('app.user_ctx', v_ctx::text, true);
  return v_ctx;
end;
$$;

revoke all on function app_user_ctx() from public, anon;
grant execute on function app_user_ctx() to authenticated, service_role;

-- The scope needed a role as well as an active login: the old inner join to
-- security_role returned nothing without one, and so does an empty slot here.
create or replace function app_current_scope()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif((app_user_ctx())[2], '');
$$;

create or replace function app_current_partner_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif((app_user_ctx())[3], '')::uuid;
$$;

create or replace function app_current_user_type()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif((app_user_ctx())[4], '');
$$;

-- No role, or a role with no permissions, holds nothing - as the old exists()
-- over the inner join concluded.
create or replace function app_has_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(app_grant_covers(nullif((app_user_ctx())[5], '')::text[], p_permission), false);
$$;
