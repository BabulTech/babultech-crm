-- A booked meeting's time, on its task, so the CRM can offer "Add to
-- calendar" with the right start and end. Null for every other task.

alter table prospect_task
  add column if not exists "meetingAt" timestamptz,
  add column if not exists "durationMinutes" integer check ("durationMinutes" is null or "durationMinutes" between 5 and 600);

notify pgrst, 'reload schema';
