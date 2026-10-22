-- Indexes for the relationship columns the app reads by.
--
-- 181 foreign keys had no index. Most are bookkeeping - who deleted, created or
-- last updated a row, which currency - and are only ever followed outward from
-- the row, which the referenced table's primary key already serves. Those are
-- left alone: an index costs every write and pays back nothing there.
--
-- These are the ones read the other way: the record pages embed children by
-- them (a project's tasks by milestone and phase, a case's time, an invoice's
-- lines), the lists filter on them, and deleting a parent has to find its
-- children. The tables are small today, so the gain now is modest; without them
-- each of these lookups turns into a full scan as the data grows.

create index if not exists account_parent_idx                   on account ("parentAccountId") where "parentAccountId" is not null;
create index if not exists activity_contact_idx                 on activity ("contactId") where "contactId" is not null;
create index if not exists approval_request_approver_idx        on approval_request ("currentApproverId");
create index if not exists approval_request_requested_by_idx    on approval_request ("requestedById");
create index if not exists approval_step_approver_idx           on approval_step ("approverUserId");
create index if not exists campaign_parent_idx                  on campaign ("parentCampaignId") where "parentCampaignId" is not null;
create index if not exists campaign_interaction_member_idx      on campaign_interaction ("campaignMemberId");
create index if not exists campaign_member_contact_idx          on campaign_member ("contactId") where "contactId" is not null;
create index if not exists campaign_member_lead_idx             on campaign_member ("leadId") where "leadId" is not null;
create index if not exists campaign_member_opportunity_idx      on campaign_member ("opportunityId") where "opportunityId" is not null;
create index if not exists case_comment_author_contact_idx      on case_comment ("authorContactId") where "authorContactId" is not null;
create index if not exists case_comment_author_user_idx         on case_comment ("authorUserId") where "authorUserId" is not null;
create index if not exists contact_first_campaign_idx           on contact ("firstCampaignId") where "firstCampaignId" is not null;
create index if not exists contact_latest_campaign_idx          on contact ("latestCampaignId") where "latestCampaignId" is not null;
create index if not exists contract_opportunity_idx             on contract ("opportunityId") where "opportunityId" is not null;
create index if not exists contract_owner_idx                   on contract ("ownerUserId");
create index if not exists contract_quotation_idx               on contract ("quotationId") where "quotationId" is not null;
create index if not exists deliverable_milestone_idx            on deliverable ("milestoneId") where "milestoneId" is not null;
create index if not exists delivery_handoff_opportunity_idx     on delivery_handoff ("opportunityId");
create index if not exists delivery_handoff_quotation_idx       on delivery_handoff ("quotationId");
create index if not exists delivery_handoff_recipient_idx       on delivery_handoff ("recipientId");
create index if not exists employment_contract_department_idx   on employment_contract ("departmentId");
create index if not exists employment_contract_reports_to_idx   on employment_contract ("reportsToUserId");
create index if not exists expense_category_idx                 on expense ("categoryId");
create index if not exists expense_employee_idx                 on expense ("employeeUserId");
create index if not exists expense_vendor_idx                   on expense ("vendorAccountId") where "vendorAccountId" is not null;
create index if not exists financial_transaction_bank_idx       on financial_transaction ("bankAccountId");
create index if not exists invoice_contact_idx                  on invoice ("contactId") where "contactId" is not null;
create index if not exists invoice_milestone_idx                on invoice ("milestoneId") where "milestoneId" is not null;
create index if not exists invoice_project_idx                  on invoice ("projectId") where "projectId" is not null;
create index if not exists invoice_line_milestone_idx           on invoice_line ("milestoneId") where "milestoneId" is not null;
create index if not exists invoice_line_product_idx             on invoice_line ("productId") where "productId" is not null;
create index if not exists invoice_line_project_idx             on invoice_line ("projectId") where "projectId" is not null;
create index if not exists knowledge_article_author_idx         on knowledge_article ("authorUserId");
create index if not exists lead_converted_account_idx           on lead ("convertedAccountId") where "convertedAccountId" is not null;
create index if not exists lead_converted_contact_idx           on lead ("convertedContactId") where "convertedContactId" is not null;
create index if not exists lead_converted_opportunity_idx       on lead ("convertedOpportunityId") where "convertedOpportunityId" is not null;
create index if not exists milestone_owner_idx                  on milestone ("ownerUserId");
create index if not exists milestone_phase_idx                  on milestone ("phaseId") where "phaseId" is not null;
create index if not exists opportunity_campaign_idx             on opportunity ("campaignId") where "campaignId" is not null;
create index if not exists opportunity_primary_contact_idx      on opportunity ("primaryContactId") where "primaryContactId" is not null;
create index if not exists opportunity_product_product_idx      on opportunity_product ("productId");
create index if not exists partner_contact_contact_idx          on partner_contact ("contactId");
create index if not exists payment_bank_idx                     on payment ("bankAccountId") where "bankAccountId" is not null;
create index if not exists project_contract_idx                 on project ("contractId") where "contractId" is not null;
create index if not exists project_opportunity_idx              on project ("opportunityId") where "opportunityId" is not null;
create index if not exists project_issue_owner_idx              on project_issue ("ownerUserId");
create index if not exists project_phase_owner_idx              on project_phase ("ownerUserId");
create index if not exists project_risk_owner_idx               on project_risk ("ownerUserId");
create index if not exists project_task_milestone_idx           on project_task ("milestoneId") where "milestoneId" is not null;
create index if not exists project_task_parent_idx              on project_task ("parentTaskId") where "parentTaskId" is not null;
create index if not exists project_task_phase_idx               on project_task ("phaseId") where "phaseId" is not null;
create index if not exists quotation_contact_idx                on quotation ("contactId") where "contactId" is not null;
create index if not exists quotation_price_book_idx             on quotation ("priceBookId") where "priceBookId" is not null;
create index if not exists quote_line_product_idx               on quote_line ("productId") where "productId" is not null;
create index if not exists support_case_category_idx            on support_case ("categoryId") where "categoryId" is not null;
create index if not exists support_case_contact_idx             on support_case ("contactId") where "contactId" is not null;
create index if not exists support_case_contract_idx            on support_case ("contractId") where "contractId" is not null;
create index if not exists support_case_project_idx             on support_case ("projectId") where "projectId" is not null;
create index if not exists time_log_case_idx                    on time_log ("caseId") where "caseId" is not null;
create index if not exists time_log_invoice_line_idx            on time_log ("invoiceLineId") where "invoiceLineId" is not null;
create index if not exists time_log_project_task_idx            on time_log ("projectTaskId") where "projectTaskId" is not null;
create index if not exists training_participant_contact_idx     on training_participant ("contactId") where "contactId" is not null;
create index if not exists training_participant_user_idx        on training_participant ("userId") where "userId" is not null;
create index if not exists vendor_bill_project_idx              on vendor_bill ("projectId") where "projectId" is not null;
create index if not exists vendor_bill_line_project_idx         on vendor_bill_line ("projectId") where "projectId" is not null;
create index if not exists vendor_payment_allocation_bill_idx   on vendor_payment_allocation ("vendorBillId");
create index if not exists web_form_submission_contact_idx      on web_form_submission ("contactId") where "contactId" is not null;
create index if not exists web_form_submission_lead_idx         on web_form_submission ("leadId") where "leadId" is not null;
