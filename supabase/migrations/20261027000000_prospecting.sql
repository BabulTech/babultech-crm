-- Prospecting: raw businesses marketing works through, before any of them is
-- a sales lead. Brought over from ORMS, where these were called leads.
--
-- A prospect is a business found on a list - a dataset - with any number of
-- phones and emails and the people who work there (decision makers). The few
-- that marketing qualifies become CRM leads; the rest stay here. Built to hold
-- hundreds of thousands of rows: lists page through the database, search is
-- indexed, and the access checks run once per query rather than per row.
--
-- Permissions: prospect:read (see), prospect:write (import, edit, log
-- outreach), prospect:qualify (turn a prospect into a lead).

create extension if not exists pg_trgm with schema extensions;

create table if not exists prospect_dataset (
  id uuid primary key default gen_random_uuid(),
  name varchar(200) not null,
  description text,
  "createdById" uuid references app_user(id) on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "deletedAt" timestamptz
);
create unique index if not exists prospect_dataset_name_key on prospect_dataset (lower(name)) where "deletedAt" is null;

create table if not exists prospect (
  id uuid primary key default gen_random_uuid(),
  "businessName" varchar(300) not null,
  "nameNorm" varchar(300),
  website varchar(500),
  "websiteNorm" varchar(300),
  industry varchar(150),
  street varchar(300),
  city varchar(120),
  region varchar(150),
  country varchar(100),
  "icpTier" varchar(60),
  "googleRating" numeric(2,1) check ("googleRating" is null or ("googleRating" >= 0 and "googleRating" <= 5)),
  "googleReviewCount" integer check ("googleReviewCount" is null or "googleReviewCount" >= 0),
  "googleMapsUrl" text,
  tags text[] not null default '{}',
  -- Whatever else the source sheet carried, by column name.
  "customFields" jsonb not null default '{}'::jsonb,
  "datasetId" uuid references prospect_dataset(id) on delete set null,
  source varchar(300),
  -- ACTIVE while marketing works it; QUALIFIED once it became a lead.
  status varchar(20) not null default 'ACTIVE' check (status in ('ACTIVE', 'QUALIFIED', 'ARCHIVED')),
  "qualifiedLeadId" uuid references lead(id) on delete set null,
  "qualifiedAt" timestamptz,
  "qualifiedById" uuid references app_user(id) on delete set null,
  "ownerUserId" uuid references app_user(id) on delete set null,
  "createdById" uuid references app_user(id) on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "deletedAt" timestamptz
);

create index if not exists prospect_list_idx on prospect ("createdAt" desc) where "deletedAt" is null;
create index if not exists prospect_dataset_idx on prospect ("datasetId") where "deletedAt" is null;
create index if not exists prospect_status_idx on prospect (status) where "deletedAt" is null;
create index if not exists prospect_icp_idx on prospect ("icpTier") where "deletedAt" is null;
create index if not exists prospect_region_idx on prospect (region) where "deletedAt" is null;
create index if not exists prospect_website_norm_idx on prospect ("websiteNorm") where "deletedAt" is null;
create index if not exists prospect_name_norm_idx on prospect ("nameNorm") where "deletedAt" is null;
create index if not exists prospect_tags_idx on prospect using gin (tags);
create index if not exists prospect_name_trgm_idx on prospect using gin ("businessName" extensions.gin_trgm_ops);

create table if not exists prospect_phone (
  id uuid primary key default gen_random_uuid(),
  "prospectId" uuid not null references prospect(id) on delete cascade,
  phone varchar(60) not null,
  "phoneNorm" varchar(30),
  label varchar(60),
  "phoneClass" varchar(60),
  "phoneType" varchar(60),
  "isPrimary" boolean not null default false,
  "createdAt" timestamptz not null default now()
);
create index if not exists prospect_phone_prospect_idx on prospect_phone ("prospectId");
create index if not exists prospect_phone_norm_idx on prospect_phone ("phoneNorm");

create table if not exists prospect_email (
  id uuid primary key default gen_random_uuid(),
  "prospectId" uuid not null references prospect(id) on delete cascade,
  email varchar(320) not null,
  "emailNorm" varchar(320),
  "isPrimary" boolean not null default false,
  "createdAt" timestamptz not null default now()
);
create index if not exists prospect_email_prospect_idx on prospect_email ("prospectId");
create index if not exists prospect_email_norm_idx on prospect_email ("emailNorm");

-- The people at the business: owner, manager, receptionist...
create table if not exists prospect_person (
  id uuid primary key default gen_random_uuid(),
  "prospectId" uuid not null references prospect(id) on delete cascade,
  name varchar(200) not null,
  role varchar(120),
  email varchar(320),
  phone varchar(60),
  "personalEmail" varchar(320),
  "personalPhone" varchar(60),
  "linkedinUrl" varchar(500),
  "isPrimary" boolean not null default false,
  notes text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists prospect_person_prospect_idx on prospect_person ("prospectId");

-- Access: by permission, checked once per query.
do $$
declare t text;
begin
  foreach t in array array['prospect_dataset', 'prospect', 'prospect_phone', 'prospect_email', 'prospect_person'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon', t);
    execute format('grant select, insert, update, delete on %I to authenticated', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to authenticated using ((select app_is_internal()) and (select app_has_permission(''prospect:read'')))', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('create policy %I on %I for all to authenticated using ((select app_is_internal()) and (select app_has_permission(''prospect:write''))) with check ((select app_is_internal()) and (select app_has_permission(''prospect:write'')))', t || '_write', t);
  end loop;
end $$;

-- Real figures for the prospects list, with its filters, as the caller.
create or replace function prospect_stats(p_filters jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with f as (
    select
      nullif(p_filters->>'datasetId', '')::uuid as dataset_id,
      nullif(p_filters->>'status', '') as status,
      nullif(p_filters->>'icpTier', '') as icp_tier,
      nullif(p_filters->>'region', '') as region,
      nullif(p_filters->>'tag', '') as tag,
      nullif(trim(coalesce(p_filters->>'search', '')), '') as search
  ),
  listed as (
    select p.* from prospect p, f
    where p."deletedAt" is null
      and (f.dataset_id is null or p."datasetId" = f.dataset_id)
      and (case when f.status is null then p.status = 'ACTIVE' else p.status = f.status end)
      and (f.icp_tier is null or p."icpTier" = f.icp_tier)
      and (f.region is null or p.region = f.region)
      and (f.tag is null or f.tag = any (p.tags))
      and (f.search is null or p."businessName" ilike '%' || f.search || '%'
           or exists (select 1 from prospect_phone ph where ph."prospectId" = p.id and ph."phoneNorm" like '%' || regexp_replace(f.search, '\D', '', 'g') || '%' and length(regexp_replace(f.search, '\D', '', 'g')) >= 4)
           or exists (select 1 from prospect_email em where em."prospectId" = p.id and em."emailNorm" like '%' || lower(f.search) || '%')
           or p."websiteNorm" like '%' || lower(f.search) || '%')
  )
  select jsonb_build_object(
    'total', (select count(*) from listed),
    'byIcpTier', coalesce((select jsonb_agg(jsonb_build_object('value', v, 'count', n) order by n desc) from (select "icpTier" v, count(*) n from listed where "icpTier" is not null group by 1) x), '[]'::jsonb),
    'byRegion', coalesce((select jsonb_agg(jsonb_build_object('value', v, 'count', n) order by n desc) from (select region v, count(*) n from listed where region is not null group by 1) x), '[]'::jsonb),
    'withPhone', (select count(*) from listed l where exists (select 1 from prospect_phone ph where ph."prospectId" = l.id)),
    'withEmail', (select count(*) from listed l where exists (select 1 from prospect_email em where em."prospectId" = l.id)),
    'withWebsite', (select count(*) from listed where website is not null),
    'qualified', (select count(*) from prospect p, f where p."deletedAt" is null and p.status = 'QUALIFIED' and (f.dataset_id is null or p."datasetId" = f.dataset_id))
  );
$$;
revoke all on function prospect_stats(jsonb) from public, anon;
grant execute on function prospect_stats(jsonb) to authenticated;

-- The values in use for the list's filters.
create or replace function prospect_filter_values()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'icpTiers', coalesce((select jsonb_agg(v order by v) from (select distinct "icpTier" v from prospect where "icpTier" is not null and "deletedAt" is null) x), '[]'::jsonb),
    'regions', coalesce((select jsonb_agg(v order by v) from (select distinct region v from prospect where region is not null and "deletedAt" is null) x), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(v order by v) from (select distinct unnest(tags) v from prospect where "deletedAt" is null) x), '[]'::jsonb)
  );
$$;
revoke all on function prospect_filter_values() from public, anon;
grant execute on function prospect_filter_values() to authenticated;

notify pgrst, 'reload schema';
