-- Partners work their own prospects in the portal.
--
-- A prospect, dataset or outreach campaign with a partnerId belongs to that
-- partner. The partner's portal admin sees all of them; any other portal user
-- sees only the prospects they own. Staff policies are unchanged: they still
-- require an internal user, so staff see everything and partners see only this.

alter table prospect add column if not exists "partnerId" uuid references partner(id) on delete set null;
alter table prospect_dataset add column if not exists "partnerId" uuid references partner(id) on delete set null;
alter table prospect_campaign add column if not exists "partnerId" uuid references partner(id) on delete set null;
create index if not exists prospect_partner_idx on prospect ("partnerId", "ownerUserId") where "partnerId" is not null;
create index if not exists prospect_dataset_partner_idx on prospect_dataset ("partnerId") where "partnerId" is not null;
create index if not exists prospect_campaign_partner_idx on prospect_campaign ("partnerId") where "partnerId" is not null;

create or replace function app_portal_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select "portalRole" = 'ADMIN' from app_user where id = app_current_user_id()), false);
$$;

-- A prospect the signed-in partner user may work.
create or replace function app_partner_prospect(p_prospect uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select app_current_partner_id() is not null and exists (
    select 1 from prospect p
     where p.id = p_prospect and p."partnerId" = app_current_partner_id()
       and (app_portal_admin() or p."ownerUserId" = app_current_user_id()));
$$;

-- An owner for a partner's prospect: nobody yet, or one of that partner's active logins.
create or replace function app_partner_owner_ok(p_partner uuid, p_owner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_owner is null or exists (
    select 1 from app_user u where u.id = p_owner and u."partnerId" = p_partner and u.status = 'ACTIVE' and u."deletedAt" is null);
$$;

drop policy if exists prospect_partner on prospect;
create policy prospect_partner on prospect for all to authenticated
  using ("partnerId" = app_current_partner_id() and (app_portal_admin() or "ownerUserId" = app_current_user_id()))
  with check ("partnerId" = app_current_partner_id()
              and app_partner_owner_ok("partnerId", "ownerUserId")
              and (app_portal_admin() or "ownerUserId" = app_current_user_id()));

do $$
declare t text;
begin
  foreach t in array array['prospect_phone', 'prospect_email', 'prospect_person', 'prospect_activity', 'prospect_task'] loop
    execute format('drop policy if exists %I on %I', t || '_partner', t);
    execute format('create policy %I on %I for all to authenticated using (app_partner_prospect("prospectId")) with check (app_partner_prospect("prospectId"))', t || '_partner', t);
  end loop;
end $$;

drop policy if exists prospect_dataset_partner on prospect_dataset;
create policy prospect_dataset_partner on prospect_dataset for all to authenticated
  using ("partnerId" = app_current_partner_id()) with check ("partnerId" = app_current_partner_id());

drop policy if exists prospect_campaign_partner on prospect_campaign;
create policy prospect_campaign_partner on prospect_campaign for all to authenticated
  using ("partnerId" = app_current_partner_id()) with check ("partnerId" = app_current_partner_id());

drop policy if exists prospect_campaign_member_partner on prospect_campaign_member;
create policy prospect_campaign_member_partner on prospect_campaign_member for all to authenticated
  using (exists (select 1 from prospect_campaign c where c.id = "campaignId" and c."partnerId" = app_current_partner_id()))
  with check (exists (select 1 from prospect_campaign c where c.id = "campaignId" and c."partnerId" = app_current_partner_id()));

drop policy if exists prospect_campaign_entry_partner on prospect_campaign_entry;
create policy prospect_campaign_entry_partner on prospect_campaign_entry for all to authenticated
  using (app_partner_prospect("prospectId") and exists (select 1 from prospect_campaign c where c.id = "campaignId" and c."partnerId" = app_current_partner_id()))
  with check (app_partner_prospect("prospectId") and exists (select 1 from prospect_campaign c where c.id = "campaignId" and c."partnerId" = app_current_partner_id()));

-- The portal's screens check these, as staff screens do; the rows above decide what they reach.
update security_role
   set permissions = (select array_agg(distinct x) from unnest(coalesce(permissions, '{}') || array['prospect:read', 'prospect:write', 'prospect:qualify']) x)
 where name = 'Partner';

-- Whose prospects these are, for the import duplicate check: any match
-- anywhere in the CRM, without saying whose it is.
create or replace function prospect_partner_conflicts(p_websites text[], p_names text[], p_phones text[], p_emails text[])
returns table (key text, "prospectId" uuid, "partnerId" uuid)
language sql stable security definer set search_path = public as $$
  select 'w:' || "websiteNorm", id, "partnerId" from prospect where "deletedAt" is null and "websiteNorm" = any (p_websites)
  union all select 'n:' || "nameNorm", id, "partnerId" from prospect where "deletedAt" is null and "nameNorm" = any (p_names)
  union all select 'p:' || ph."phoneNorm", p.id, p."partnerId" from prospect_phone ph join prospect p on p.id = ph."prospectId" where p."deletedAt" is null and ph."phoneNorm" = any (p_phones)
  union all select 'e:' || em."emailNorm", p.id, p."partnerId" from prospect_email em join prospect p on p.id = em."prospectId" where p."deletedAt" is null and em."emailNorm" = any (p_emails)
  union all select 'e:' || lower(l.email), null, null from lead l where l."deletedAt" is null and lower(l.email) = any (p_emails)
  union all select 'e:' || lower(c.email), null, null from contact c where c."deletedAt" is null and lower(c.email) = any (p_emails);
$$;
revoke all on function prospect_partner_conflicts(text[], text[], text[], text[]) from public, anon;
grant execute on function prospect_partner_conflicts(text[], text[], text[], text[]) to authenticated, service_role;

-- Staff can list one partner's prospects, any partner's, or ours only.
create or replace function prospect_filtered(p_filters jsonb default '{}'::jsonb)
returns setof prospect language sql stable set search_path = public, extensions as $$
  with f as (
    select
      nullif(p_filters->>'datasetId', '')::uuid as dataset_id,
      nullif(p_filters->>'status', '') as status,
      nullif(p_filters->>'icpTier', '') as icp_tier,
      nullif(p_filters->>'region', '') as region,
      nullif(p_filters->>'tag', '') as tag,
      nullif(p_filters->>'partner', '') as partner,
      nullif(trim(coalesce(p_filters->>'search', '')), '') as search,
      nullif(regexp_replace(coalesce(p_filters->>'search', ''), '\D', '', 'g'), '') as digits
  )
  select p.* from prospect p, f
  where p."deletedAt" is null
    and (f.dataset_id is null or p."datasetId" = f.dataset_id)
    and (case when f.status is null then p.status = 'ACTIVE' else p.status = f.status end)
    and (f.icp_tier is null or p."icpTier" = f.icp_tier)
    and (f.region is null or p.region = f.region)
    and (f.tag is null or f.tag = any (p.tags))
    and (f.partner is null or (f.partner = 'none' and p."partnerId" is null) or (f.partner = 'any' and p."partnerId" is not null)
         or p."partnerId"::text = f.partner)
    and (f.search is null
         or p."businessName" ilike '%' || f.search || '%'
         or p."websiteNorm" like '%' || lower(f.search) || '%'
         or (length(coalesce(f.digits, '')) >= 4 and exists (select 1 from prospect_phone ph where ph."prospectId" = p.id and ph."phoneNorm" like '%' || f.digits || '%'))
         or exists (select 1 from prospect_email em where em."prospectId" = p.id and em."emailNorm" like '%' || lower(f.search) || '%'));
$$;

create or replace function prospect_page(p_filters jsonb default '{}'::jsonb, p_limit integer default 50, p_offset integer default 0)
returns setof prospect language sql stable set search_path = public as $$
  select * from prospect_filtered(p_filters)
  order by "createdAt" desc, id
  limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
$$;

notify pgrst, 'reload schema';
