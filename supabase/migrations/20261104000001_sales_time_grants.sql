-- time_log is granted column by column; the sales columns were left out, so
-- every timesheet read failed for staff.
grant select ("salesEntityType", "salesEntityId", "salesActivity") on time_log to authenticated;
grant insert ("salesEntityType", "salesEntityId", "salesActivity") on time_log to authenticated;
grant update ("salesActivity") on time_log to authenticated;
notify pgrst, 'reload schema';
