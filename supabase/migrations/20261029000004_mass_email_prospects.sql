-- Mass email to prospects: templates can be written for prospects.

alter table email_template drop constraint if exists email_template_audience_check;
alter table email_template add constraint email_template_audience_check
  check (audience in ('ANY', 'Lead', 'Contact', 'CampaignMember', 'Prospect'));

notify pgrst, 'reload schema';
