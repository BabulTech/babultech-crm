-- Onboarding step statuses: Not started, In progress, Waiting on customer,
-- On hold, Completed, Not required. Plus when work started and who last
-- changed the status. doneAt / doneById stay as "completed at / by".

alter table onboarding_step drop constraint if exists onboarding_step_status_check;
update onboarding_step set status = case status when 'TODO' then 'NOT_STARTED' when 'DONE' then 'COMPLETED' when 'SKIPPED' then 'NOT_REQUIRED' else status end;
alter table onboarding_step alter column status type varchar(20);
alter table onboarding_step alter column status set default 'NOT_STARTED';
alter table onboarding_step add constraint onboarding_step_status_check
  check (status in ('NOT_STARTED', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'ON_HOLD', 'COMPLETED', 'NOT_REQUIRED'));

alter table onboarding_step add column if not exists "startedAt" timestamp(3);
alter table onboarding_step add column if not exists "statusChangedAt" timestamp(3);
alter table onboarding_step add column if not exists "statusChangedById" uuid references app_user (id) on delete set null;

drop index if exists onboarding_step_owner_idx;
create index if not exists onboarding_step_owner_open_idx on onboarding_step ("ownerUserId")
  where status not in ('COMPLETED', 'NOT_REQUIRED');

notify pgrst, 'reload schema';
