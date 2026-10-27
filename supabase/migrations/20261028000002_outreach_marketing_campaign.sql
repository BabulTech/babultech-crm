-- An outreach campaign can say which marketing campaign it is part of. Leads
-- qualified from it are then credited to that campaign, so its leads, deals
-- and revenue count towards the marketing campaign's results.

alter table prospect_campaign
  add column if not exists "marketingCampaignId" uuid references campaign(id) on delete set null;

create index if not exists prospect_campaign_marketing_idx on prospect_campaign ("marketingCampaignId");

notify pgrst, 'reload schema';
