-- Hasan Shamsi had two logins. Move the inactive one's project teams and task
-- assignments to the active one. The inactive login itself is kept, switched off.
do $$
declare
  v_old uuid := '37f25e81-37ec-4973-a720-8eeaf96cb639';
  v_new uuid := '9c1c02f1-2116-40d1-bfcf-91bc43462ea7';
begin
  update project_member n set active = true, "updatedAt" = now()
    from project_member o
   where o."userId" = v_old and o.active and n."userId" = v_new and n."projectId" = o."projectId" and not n.active;
  delete from project_member o
   where o."userId" = v_old
     and exists (select 1 from project_member n where n."userId" = v_new and n."projectId" = o."projectId");
  update project_member set "userId" = v_new, "updatedAt" = now() where "userId" = v_old;
  update project_task set "assignedUserId" = v_new, "updatedAt" = now() where "assignedUserId" = v_old;
end $$;
