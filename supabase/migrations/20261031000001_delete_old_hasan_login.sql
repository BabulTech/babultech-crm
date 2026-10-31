-- Remove Hasan Shamsi's old login, after pointing the records that name it at
-- the active one. The sign-in record is removed separately.
do $$
declare
  v_old uuid := '37f25e81-37ec-4973-a720-8eeaf96cb639';
  v_new uuid := '9c1c02f1-2116-40d1-bfcf-91bc43462ea7';
begin
  update app_user set "managerUserId" = case when id = v_new then null else v_new end where "managerUserId" = v_old;
  update expense set "employeeUserId" = v_new where "employeeUserId" = v_old;
  update employment_contract set "reportsToUserId" = v_new where "reportsToUserId" = v_old;
  delete from app_user where id = v_old and status = 'INACTIVE';
end $$;
