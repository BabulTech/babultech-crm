-- Favourite screens and actions: each person's own shortcuts, beside the
-- favourite records they already have. A screen keeps the filters it was
-- starred with (its link includes the query string), so a filtered list can
-- be a shortcut too. Shown at the top of the sidebar and in the Favourites
-- menu, in the order the person arranges.

create table if not exists favorite_link (
  id uuid primary key default gen_random_uuid(),
  "userId" uuid not null default app_current_user_id() references app_user (id) on delete cascade,
  kind varchar(10) not null check (kind in ('SCREEN', 'ACTION')),
  href varchar(1000) not null check (href like '/%'),
  label varchar(120) not null,
  position integer not null default 0,
  "createdAt" timestamp(3) not null default now(),
  unique ("userId", href)
);
create index if not exists favorite_link_user_idx on favorite_link ("userId", position);

alter table favorite_link enable row level security;
drop policy if exists favorite_link_own on favorite_link;
create policy favorite_link_own on favorite_link for all to authenticated
  using (app_is_internal() and "userId" = app_current_user_id())
  with check (app_is_internal() and "userId" = app_current_user_id());
revoke all on favorite_link from anon;
grant select, insert, update, delete on favorite_link to authenticated;

notify pgrst, 'reload schema';
