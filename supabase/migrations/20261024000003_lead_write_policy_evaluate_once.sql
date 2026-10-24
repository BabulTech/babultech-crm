-- The write policy covers every command, reads included, so its
-- app_can_write_owned("ownerUserId") ran for every row of every lead list.
-- The same test, written out with the per-user parts evaluated once per query.
drop policy if exists lead_internal_write on lead;
create policy lead_internal_write on lead
  using (
    (
      (select app_is_internal())
      and (select app_current_scope()) is not null
      and (
        (select app_current_scope()) = 'ALL'
        or "ownerUserId" is null
        or "ownerUserId" in (select app_visible_owner_ids())
      )
    )
    or ("referredByPartnerId" is not null and (select app_works_partner_records('lead:write')))
  )
  with check (
    (
      (select app_is_internal())
      and (select app_current_scope()) is not null
      and (
        (select app_current_scope()) = 'ALL'
        or "ownerUserId" is null
        or "ownerUserId" in (select app_visible_owner_ids())
      )
    )
    or ("referredByPartnerId" is not null and (select app_works_partner_records('lead:write')))
  );
