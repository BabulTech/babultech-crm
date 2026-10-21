-- New tasks and time entries start as not billable.
--
-- The business is mostly logging its own internal work for now, so "billable"
-- is the exception to opt into, not the default to remember to untick.
-- Existing rows keep whatever they were saved with.

alter table project_task alter column billable set default false;
alter table time_log alter column billable set default false;
