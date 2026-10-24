-- The leads list timed out once the table grew past a few thousand rows.
--
-- The read policies called app_is_internal(), app_current_scope() and
-- app_current_partner_id() bare, so Postgres ran each of them once per row.
-- Wrapped in (select ...) they are evaluated once per query instead. Who can
-- see which lead is exactly as before.

drop policy if exists lead_internal_read on lead;
create policy lead_internal_read on lead for select
  using (
    (select app_is_internal())
    and (
      (select app_current_scope()) = 'ALL'
      or "ownerUserId" in (select app_visible_owner_ids())
      or ("referredByPartnerId" is not null and (select app_sees_partner_records('lead:read')))
    )
  );

drop policy if exists lead_partner_read on lead;
create policy lead_partner_read on lead for select to authenticated
  using (
    (select app_current_partner_id()) is not null
    and "referredByPartnerId" = (select app_current_partner_id())
  );

