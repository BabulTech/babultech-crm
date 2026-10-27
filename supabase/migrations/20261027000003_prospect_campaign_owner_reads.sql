-- Creating a campaign failed: the new row is checked against the read
-- policy straight away, and prospect_visible_campaigns() cannot see a row
-- inserted by the same statement. Its owner can now read it from the row
-- itself.

drop policy if exists prospect_campaign_read on prospect_campaign;
create policy prospect_campaign_read on prospect_campaign for select to authenticated
  using ((select app_is_internal()) and (select app_has_permission('prospect:read') or app_has_permission('prospect:write'))
         and ("ownerUserId" = (select app_current_user_id()) or id in (select prospect_visible_campaigns(false))));
