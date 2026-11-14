-- Inventory: everything the company owns, who has it, and what paid for it.
--
--   asset_category   Hardware, Software, Furniture, Electrical, Appliance, Other
--   asset_type       the dropdown (Laptop, LED, Fan, Bulb...), tracked one by
--                    one (INDIVIDUAL) or as a count at a place (QUANTITY)
--   asset_location   rooms and offices; items can be given to a place
--   asset            one item, or one stock line of a counted item at a place.
--                    quantity is 1 for an individual item, the count for a
--                    counted one, and the seats for a software licence.
--   asset_assignment who or where has it, with the full history. A person
--                    confirms receipt (PENDING -> ACCEPTED, or DISPUTED).
--   asset_event      stock in and out, repairs, status changes, notes.
--
-- Money is recorded once, in expenses or vendor bills. An asset points at the
-- expense or bill that paid for it; its purchaseCost is its share of that.
--
-- Read and written only through the service role after the app has checked
-- asset:read / asset:write, or that the reader holds the item. No policies.

create table if not exists asset_category (
  id uuid primary key default gen_random_uuid(),
  name varchar(80) not null unique,
  "sortOrder" integer not null default 0,
  active boolean not null default true,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);

create table if not exists asset_type (
  id uuid primary key default gen_random_uuid(),
  "categoryId" uuid not null references asset_category (id),
  name varchar(80) not null,
  tracking varchar(10) not null default 'INDIVIDUAL' check (tracking in ('INDIVIDUAL', 'QUANTITY')),
  -- Used for "past its useful life" on the Needs attention list.
  "usefulLifeMonths" integer check ("usefulLifeMonths" is null or "usefulLifeMonths" between 1 and 600),
  active boolean not null default true,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);
create unique index if not exists asset_type_name_key on asset_type (lower(name));

create table if not exists asset_location (
  id uuid primary key default gen_random_uuid(),
  name varchar(100) not null,
  active boolean not null default true,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);
create unique index if not exists asset_location_name_key on asset_location (lower(name));

create table if not exists asset (
  id uuid primary key default gen_random_uuid(),
  "assetTag" varchar(30) not null unique,
  name varchar(150) not null,
  "typeId" uuid not null references asset_type (id),
  tracking varchar(10) not null check (tracking in ('INDIVIDUAL', 'QUANTITY')),
  brand varchar(100),
  model varchar(100),
  "serialNumber" varchar(120),
  quantity integer not null default 1 check (quantity >= 0),
  -- Where it lives when it is not with someone.
  "locationId" uuid references asset_location (id) on delete set null,
  condition varchar(12) not null default 'GOOD' check (condition in ('NEW', 'GOOD', 'NEEDS_REPAIR', 'BROKEN')),
  status varchar(10) not null default 'IN_STOCK' check (status in ('IN_STOCK', 'ASSIGNED', 'IN_REPAIR', 'RETIRED', 'LOST', 'DISPOSED')),
  -- How we came to own it. A purchase points at the money; the others carry an estimate.
  acquisition varchar(10) not null default 'PURCHASED' check (acquisition in ('PURCHASED', 'GIFT', 'EXISTING')),
  "purchaseDate" date not null,
  "purchaseCost" numeric(18, 2) not null check ("purchaseCost" >= 0),
  "currencyCode" char(3) not null default 'PKR',
  "supplierName" varchar(150),
  "supplierAccountId" uuid references account (id) on delete set null,
  "invoiceReference" varchar(100),
  "purchaseDetails" text,
  "expenseId" uuid references expense (id) on delete set null,
  "vendorBillId" uuid references vendor_bill (id) on delete set null,
  "warrantyEndsOn" date,
  -- Software: when the licence or subscription has to be renewed.
  "licenceExpiresOn" date,
  notes text,
  "createdById" uuid references app_user (id) on delete set null,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now(),
  "deletedAt" timestamp(3),
  check (tracking = 'QUANTITY' or quantity >= 1),
  check (not ("expenseId" is not null and "vendorBillId" is not null))
);
create index if not exists asset_type_idx on asset ("typeId");
create index if not exists asset_status_idx on asset (status) where "deletedAt" is null;
create index if not exists asset_expense_idx on asset ("expenseId") where "expenseId" is not null;
create index if not exists asset_bill_idx on asset ("vendorBillId") where "vendorBillId" is not null;

create table if not exists asset_assignment (
  id uuid primary key default gen_random_uuid(),
  "assetId" uuid not null references asset (id) on delete cascade,
  "assigneeUserId" uuid references app_user (id) on delete set null,
  "locationId" uuid references asset_location (id) on delete set null,
  quantity integer not null default 1 check (quantity >= 1),
  "assignedById" uuid references app_user (id) on delete set null,
  "assignedAt" timestamp(3) not null default now(),
  "conditionOut" varchar(12) check ("conditionOut" in ('NEW', 'GOOD', 'NEEDS_REPAIR', 'BROKEN')),
  note text,
  -- A person confirms they received it; a place needs nobody to.
  "acceptStatus" varchar(10) not null default 'ACCEPTED' check ("acceptStatus" in ('PENDING', 'ACCEPTED', 'DISPUTED')),
  "acceptedAt" timestamp(3),
  "acceptNote" text,
  "returnedAt" timestamp(3),
  "returnedById" uuid references app_user (id) on delete set null,
  "conditionIn" varchar(12) check ("conditionIn" in ('NEW', 'GOOD', 'NEEDS_REPAIR', 'BROKEN')),
  "returnNote" text,
  check (("assigneeUserId" is null) <> ("locationId" is null))
);
create index if not exists asset_assignment_asset_idx on asset_assignment ("assetId", "assignedAt" desc);
create index if not exists asset_assignment_open_user_idx on asset_assignment ("assigneeUserId") where "returnedAt" is null;

create table if not exists asset_event (
  id uuid primary key default gen_random_uuid(),
  "assetId" uuid not null references asset (id) on delete cascade,
  kind varchar(12) not null check (kind in ('CREATED', 'STOCK_IN', 'STOCK_OUT', 'REPAIR', 'STATUS', 'NOTE', 'EDITED')),
  "quantityChange" integer,
  cost numeric(18, 2),
  "expenseId" uuid references expense (id) on delete set null,
  note text,
  "actorId" uuid references app_user (id) on delete set null,
  "createdAt" timestamp(3) not null default now()
);
create index if not exists asset_event_asset_idx on asset_event ("assetId", "createdAt" desc);

alter table asset_category enable row level security;
alter table asset_type enable row level security;
alter table asset_location enable row level security;
alter table asset enable row level security;
alter table asset_assignment enable row level security;
alter table asset_event enable row level security;
-- No policies: the service role only, after the app's own checks.

insert into number_sequence (id, "entityType", prefix, "nextValue", "paddingLength", "includeYear", "updatedAt")
select gen_random_uuid(), 'Asset', 'BT', 1, 4, false, now()
where not exists (select 1 from number_sequence where "entityType" = 'Asset');

-- The expense category every asset purchase is booked to.
insert into expense_category (id, name, "glCode", "requiresReceipt", active, "createdAt", "updatedAt")
select gen_random_uuid(), 'Asset purchase', null, true, true, now(), now()
where not exists (select 1 from expense_category where lower(name) = 'asset purchase');

-- Starting lists; all editable from Inventory -> Settings.
insert into asset_category (name, "sortOrder") values
  ('Hardware', 1), ('Software', 2), ('Furniture', 3), ('Electrical', 4), ('Appliance', 5), ('Other', 6)
on conflict (name) do nothing;

insert into asset_type ("categoryId", name, tracking, "usefulLifeMonths")
select c.id, v.name, v.tracking, v.life
  from (values
    ('Hardware', 'Laptop', 'INDIVIDUAL', 48),
    ('Hardware', 'Desktop computer', 'INDIVIDUAL', 60),
    ('Hardware', 'Monitor / LED screen', 'INDIVIDUAL', 72),
    ('Hardware', 'Mobile phone', 'INDIVIDUAL', 36),
    ('Hardware', 'Printer', 'INDIVIDUAL', 60),
    ('Hardware', 'Router / network', 'INDIVIDUAL', 60),
    ('Hardware', 'Keyboard / mouse', 'QUANTITY', 24),
    ('Hardware', 'Headset', 'QUANTITY', 24),
    ('Software', 'Software licence', 'QUANTITY', 12),
    ('Software', 'Subscription', 'QUANTITY', 12),
    ('Furniture', 'Chair', 'QUANTITY', 84),
    ('Furniture', 'Desk', 'QUANTITY', 120),
    ('Electrical', 'Ceiling fan', 'QUANTITY', 120),
    ('Electrical', 'Bulb / tube light', 'QUANTITY', 24),
    ('Electrical', 'UPS / inverter', 'INDIVIDUAL', 60),
    ('Electrical', 'Air conditioner', 'INDIVIDUAL', 120),
    ('Appliance', 'Refrigerator', 'INDIVIDUAL', 120),
    ('Appliance', 'Microwave / kettle', 'QUANTITY', 60),
    ('Other', 'Other', 'INDIVIDUAL', null)
  ) as v(cat, name, tracking, life)
  join asset_category c on c.name = v.cat
on conflict do nothing;

insert into asset_location (name) values ('Main office'), ('Store room')
on conflict do nothing;

notify pgrst, 'reload schema';
