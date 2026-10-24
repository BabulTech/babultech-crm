-- Lead pages failed for CRM Admins with "Could not load eligible sales
-- recipients". handoff_user_allowed checked a role's permissions by hand and
-- did not know the CRM Admin grant, all:except-delete, so it decided they had
-- no lead access and lead_handoff_recipients() raised. It now asks
-- app_grant_covers(), the one check that understands every kind of grant.

create or replace function handoff_user_allowed(p_user uuid, p_permissions text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from app_user u
    join security_role r on r.id = u."roleId"
    where u.id = p_user
      and u.status = 'ACTIVE'
      and u."deletedAt" is null
      and u."partnerId" is null
      and r.active
      and not exists (
        select 1 from unnest(p_permissions) p
        where not app_grant_covers(coalesce(r.permissions, '{}'::text[]), p)
      )
  );
$$;
