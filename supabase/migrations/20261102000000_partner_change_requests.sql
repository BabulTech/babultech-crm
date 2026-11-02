-- A partner's profile edits wait here until an administrator decides them.
-- All access goes through src/server/partner-changes.ts with the service role:
-- RLS is on with no policies, so bank details never reach a browser client.

create table if not exists partner_change_request (
  id uuid primary key default gen_random_uuid(),
  "partnerId" uuid not null references partner(id) on delete cascade,
  "requestedById" uuid,
  "requestedByName" text not null,
  changes jsonb not null,
  reason text,
  status varchar(12) not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  "decidedById" uuid,
  "decidedByName" text,
  "decidedAt" timestamptz,
  "decisionNote" text,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists partner_change_one_open on partner_change_request ("partnerId") where status = 'PENDING';
create index if not exists partner_change_partner_idx on partner_change_request ("partnerId", "createdAt" desc);
alter table partner_change_request enable row level security;
grant select, insert, update on partner_change_request to service_role;

-- Field names only: the log must not become a copy of anyone's bank account.
create or replace function activity_from_partner_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name text := (select "displayName" from partner where id = new."partnerId");
  v_fields text := (select string_agg(k, ', ') from jsonb_object_keys(new.changes) k);
  v_bank boolean := new.changes ? 'bankDetails';
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then return null; end if;
  perform log_activity('RECORD', 'PARTNER_CHANGE_' || new.status,
    format('%sPartner profile change %s for %s: %s', case when v_bank then 'BANK DETAILS. ' else '' end, lower(new.status), v_name, v_fields),
    'Partner', new."partnerId", coalesce(new."decidedById", new."requestedById"), 'OK',
    jsonb_build_object('bankChange', v_bank, 'reason', new.reason, 'decisionNote', new."decisionNote", 'requestedBy', new."requestedByName"));
  return null;
end $$;
drop trigger if exists activity_from_partner_change on partner_change_request;
create trigger activity_from_partner_change after insert or update on partner_change_request
  for each row execute function activity_from_partner_change();

notify pgrst, 'reload schema';
