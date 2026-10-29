-- Email from more record pages: campaign members, customer accounts, deals,
-- quotations, invoices, projects and HR people. On for each, open to anyone
-- who can work on that kind of record; Settings -> Email on screens changes it.

insert into email_screen_setting ("entityType", enabled)
values ('CampaignMember', true), ('Account', true), ('Opportunity', true), ('Quotation', true),
       ('Invoice', true), ('Project', true), ('Person', true)
on conflict ("entityType") do nothing;
