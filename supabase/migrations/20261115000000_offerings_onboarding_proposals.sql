-- Offerings, customer onboarding and proposals.
--
--   offering                  what kind of sale: Web development, BabulPOS...
--   opportunity.offeringId    the offering a deal is for
--   onboarding_playbook(_step) the steps a won customer goes through, per offering
--   onboarding(_step)         one customer's run of a playbook, started at Closed won
--   proposal_section          reusable blocks (About us, Terms)
--   proposal_template         an offering's proposal: ordered sections
--   proposal(_event)          a deal's proposal, its versions, and what the customer did
--
-- All new tables are read and written through the service role after the app
-- checks permissions; a customer reaches a proposal only by its link token.

create table if not exists offering (
  id uuid primary key default gen_random_uuid(),
  name varchar(100) not null,
  description text,
  "sortOrder" integer not null default 0,
  active boolean not null default true,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);
create unique index if not exists offering_name_key on offering (lower(name));

alter table opportunity add column if not exists "offeringId" uuid references offering (id) on delete set null;
create index if not exists opportunity_offering_idx on opportunity ("offeringId") where "offeringId" is not null;

-- ---------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------

create table if not exists onboarding_playbook (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null,
  "offeringId" uuid references offering (id) on delete set null,
  description text,
  "targetDays" integer check ("targetDays" is null or "targetDays" between 1 and 730),
  active boolean not null default true,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);

create table if not exists onboarding_playbook_step (
  id uuid primary key default gen_random_uuid(),
  "playbookId" uuid not null references onboarding_playbook (id) on delete cascade,
  phase varchar(12) not null default 'KICKOFF' check (phase in ('KICKOFF', 'COLLECT', 'SETUP', 'TRAIN', 'GO_LIVE', 'FOLLOW_UP')),
  title varchar(200) not null,
  instructions text,
  -- Who does it: the deal owner, the onboarding manager, or a named person.
  "ownerKind" varchar(12) not null default 'DEAL_OWNER' check ("ownerKind" in ('DEAL_OWNER', 'MANAGER', 'USER')),
  "ownerUserId" uuid references app_user (id) on delete set null,
  "dueDays" integer not null default 1 check ("dueDays" between 0 and 730),
  "stepType" varchar(10) not null default 'INTERNAL' check ("stepType" in ('INTERNAL', 'CUSTOMER')),
  "requiresNote" boolean not null default false,
  -- Waits for the step before it in the list.
  "waitsForPrevious" boolean not null default false,
  "isGoLive" boolean not null default false,
  "sortOrder" integer not null default 0,
  "createdAt" timestamp(3) not null default now()
);
create index if not exists onboarding_playbook_step_idx on onboarding_playbook_step ("playbookId", "sortOrder");

create table if not exists onboarding (
  id uuid primary key default gen_random_uuid(),
  "onboardingNumber" varchar(30) not null unique,
  "accountId" uuid not null references account (id) on delete cascade,
  "opportunityId" uuid unique references opportunity (id) on delete set null,
  "playbookId" uuid references onboarding_playbook (id) on delete set null,
  "offeringId" uuid references offering (id) on delete set null,
  name varchar(200) not null,
  status varchar(10) not null default 'ACTIVE' check (status in ('ACTIVE', 'LIVE', 'CANCELLED')),
  "managerUserId" uuid references app_user (id) on delete set null,
  "startDate" date not null default current_date,
  "targetGoLive" date,
  "wentLiveAt" timestamp(3),
  "cancelReason" text,
  "createdById" uuid references app_user (id) on delete set null,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);
create index if not exists onboarding_account_idx on onboarding ("accountId");
create index if not exists onboarding_status_idx on onboarding (status);

create table if not exists onboarding_step (
  id uuid primary key default gen_random_uuid(),
  "onboardingId" uuid not null references onboarding (id) on delete cascade,
  phase varchar(12) not null,
  title varchar(200) not null,
  instructions text,
  "ownerUserId" uuid references app_user (id) on delete set null,
  "dueDate" date,
  "stepType" varchar(10) not null default 'INTERNAL' check ("stepType" in ('INTERNAL', 'CUSTOMER')),
  "requiresNote" boolean not null default false,
  "waitsForPrevious" boolean not null default false,
  "isGoLive" boolean not null default false,
  "sortOrder" integer not null default 0,
  status varchar(8) not null default 'TODO' check (status in ('TODO', 'DONE', 'SKIPPED')),
  "doneById" uuid references app_user (id) on delete set null,
  "doneAt" timestamp(3),
  note text,
  "createdAt" timestamp(3) not null default now()
);
create index if not exists onboarding_step_idx on onboarding_step ("onboardingId", "sortOrder");
create index if not exists onboarding_step_owner_idx on onboarding_step ("ownerUserId") where status = 'TODO';

-- ---------------------------------------------------------------------------
-- Proposals
-- ---------------------------------------------------------------------------

create table if not exists proposal_section (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null,
  body text not null default '',
  active boolean not null default true,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);

create table if not exists proposal_template (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null,
  "offeringId" uuid references offering (id) on delete set null,
  "validDays" integer not null default 30 check ("validDays" between 1 and 365),
  -- [{ kind: "TEXT" | "LIBRARY" | "PRICING", title, body?, sectionId? }]
  sections jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array'),
  active boolean not null default true,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now()
);

create table if not exists proposal (
  id uuid primary key default gen_random_uuid(),
  "proposalNumber" varchar(30) not null,
  version integer not null default 1,
  "opportunityId" uuid not null references opportunity (id) on delete cascade,
  "templateId" uuid references proposal_template (id) on delete set null,
  "quotationId" uuid references quotation (id) on delete set null,
  title varchar(200) not null,
  -- [{ kind: "TEXT" | "PRICING", title, body }] - filled in, edited, frozen when sent.
  sections jsonb not null default '[]'::jsonb check (jsonb_typeof(sections) = 'array'),
  status varchar(18) not null default 'DRAFT' check (status in (
    'DRAFT', 'SENT', 'VIEWED', 'CHANGES_REQUESTED', 'ACCEPTED', 'DECLINED', 'SUPERSEDED')),
  "validUntil" date,
  "sentAt" timestamp(3),
  "sentTo" text,
  "firstViewedAt" timestamp(3),
  "tokenHash" varchar(64) unique,
  "acceptedName" varchar(150),
  "acceptedSignature" text check ("acceptedSignature" is null or length("acceptedSignature") <= 300000),
  "acceptedAt" timestamp(3),
  "acceptedIp" varchar(64),
  "customerComment" text,
  "createdById" uuid references app_user (id) on delete set null,
  "createdAt" timestamp(3) not null default now(),
  "updatedAt" timestamp(3) not null default now(),
  unique ("proposalNumber", version)
);
create index if not exists proposal_opportunity_idx on proposal ("opportunityId", "createdAt" desc);

create table if not exists proposal_event (
  id uuid primary key default gen_random_uuid(),
  "proposalId" uuid not null references proposal (id) on delete cascade,
  kind varchar(20) not null,
  note text,
  "actorId" uuid references app_user (id) on delete set null,
  "createdAt" timestamp(3) not null default now()
);
create index if not exists proposal_event_idx on proposal_event ("proposalId", "createdAt" desc);

alter table offering enable row level security;
alter table onboarding_playbook enable row level security;
alter table onboarding_playbook_step enable row level security;
alter table onboarding enable row level security;
alter table onboarding_step enable row level security;
alter table proposal_section enable row level security;
alter table proposal_template enable row level security;
alter table proposal enable row level security;
alter table proposal_event enable row level security;
-- Lets the deal screens show the offering name through the user's own client.
drop policy if exists offering_read on offering;
create policy offering_read on offering for select to authenticated using (app_is_internal());
grant select on offering to authenticated;

insert into number_sequence (id, "entityType", prefix, "nextValue", "paddingLength", "includeYear", "updatedAt")
select gen_random_uuid(), 'Onboarding', 'ONB', 1, 4, false, now()
where not exists (select 1 from number_sequence where "entityType" = 'Onboarding');
insert into number_sequence (id, "entityType", prefix, "nextValue", "paddingLength", "includeYear", "updatedAt")
select gen_random_uuid(), 'Proposal', 'PRP', 1, 4, true, now()
where not exists (select 1 from number_sequence where "entityType" = 'Proposal');

-- ---------------------------------------------------------------------------
-- Starting content (all editable)
-- ---------------------------------------------------------------------------

insert into offering (name, description, "sortOrder") values
  ('Web development', 'Websites and web applications built for the customer.', 1),
  ('BabulPOS', 'Our point-of-sale product: licences, installation, training and support.', 2),
  ('Mobile app', 'iOS and Android apps built for the customer.', 3),
  ('Digital marketing', 'SEO, social media and paid campaigns.', 4)
on conflict do nothing;

do $$
declare
  v_pos uuid; v_web uuid; v_pb uuid; v_about uuid; v_terms uuid; v_support uuid;
begin
  select id into v_pos from offering where lower(name) = 'babulpos';
  select id into v_web from offering where lower(name) = 'web development';

  if not exists (select 1 from onboarding_playbook) then
    insert into onboarding_playbook (name, "offeringId", description, "targetDays")
    values ('BabulPOS onboarding', v_pos, 'From a signed deal to a store selling on BabulPOS.', 14) returning id into v_pb;
    insert into onboarding_playbook_step ("playbookId", phase, title, instructions, "ownerKind", "dueDays", "stepType", "requiresNote", "waitsForPrevious", "isGoLive", "sortOrder") values
      (v_pb, 'KICKOFF', 'Welcome call', 'Introduce the onboarding manager, confirm branches, go-live date and who the customer''s main contact is.', 'DEAL_OWNER', 1, 'INTERNAL', true, false, false, 1),
      (v_pb, 'COLLECT', 'Business details, branches and tax information', 'Legal name, NTN/STRN, branch addresses, receipt header.', 'MANAGER', 3, 'CUSTOMER', false, false, false, 2),
      (v_pb, 'COLLECT', 'Product or menu list with prices', 'Ask for the list in Excel using our import sheet.', 'MANAGER', 4, 'CUSTOMER', false, false, false, 3),
      (v_pb, 'SETUP', 'Create licences and accounts', 'One licence per terminal; record licence numbers in the note.', 'MANAGER', 4, 'INTERNAL', true, false, false, 4),
      (v_pb, 'SETUP', 'Install hardware and software', 'Terminals, printers, cash drawer, scanner. Test a sale and a receipt.', 'MANAGER', 7, 'INTERNAL', true, true, false, 5),
      (v_pb, 'SETUP', 'Import products and users', 'Import the product list, set up cashiers and permissions.', 'MANAGER', 8, 'INTERNAL', false, false, false, 6),
      (v_pb, 'TRAIN', 'Train staff', 'Cashiers: sales, returns, day close. Managers: reports and stock.', 'MANAGER', 10, 'INTERNAL', true, true, false, 7),
      (v_pb, 'GO_LIVE', 'Go live', 'First trading day on BabulPOS. Be reachable all day.', 'MANAGER', 12, 'INTERNAL', false, true, true, 8),
      (v_pb, 'FOLLOW_UP', 'Day-3 check', 'Call the store: any issues with sales, printing or stock?', 'MANAGER', 15, 'INTERNAL', true, true, false, 9),
      (v_pb, 'FOLLOW_UP', 'Day-14 review', 'Review usage, answer questions, confirm support contacts.', 'DEAL_OWNER', 26, 'INTERNAL', true, false, false, 10);

    insert into onboarding_playbook (name, "offeringId", description, "targetDays")
    values ('Web development onboarding', v_web, 'From a signed deal to a launched website. The build itself runs as the project.', 42) returning id into v_pb;
    insert into onboarding_playbook_step ("playbookId", phase, title, instructions, "ownerKind", "dueDays", "stepType", "requiresNote", "waitsForPrevious", "isGoLive", "sortOrder") values
      (v_pb, 'KICKOFF', 'Kickoff meeting', 'Walk through scope, timeline and who approves what. Share the project plan.', 'MANAGER', 2, 'INTERNAL', true, false, false, 1),
      (v_pb, 'COLLECT', 'Brand assets (logo, colours, fonts)', null, 'MANAGER', 5, 'CUSTOMER', false, false, false, 2),
      (v_pb, 'COLLECT', 'Content: text, images, product details', null, 'MANAGER', 10, 'CUSTOMER', false, false, false, 3),
      (v_pb, 'COLLECT', 'Domain and hosting access', 'Registrar and hosting logins, or DNS access. Store credentials in the Vault, not in notes.', 'MANAGER', 7, 'CUSTOMER', false, false, false, 4),
      (v_pb, 'SETUP', 'Sitemap signed off by the customer', null, 'MANAGER', 7, 'INTERNAL', true, false, false, 5),
      (v_pb, 'SETUP', 'Design approved by the customer', null, 'MANAGER', 14, 'INTERNAL', true, true, false, 6),
      (v_pb, 'SETUP', 'Build and testing complete', 'Tracked in the project; tick when the site passes testing.', 'MANAGER', 35, 'INTERNAL', false, true, false, 7),
      (v_pb, 'GO_LIVE', 'Launch', 'DNS switched, SSL working, forms tested, analytics on.', 'MANAGER', 40, 'INTERNAL', true, true, true, 8),
      (v_pb, 'FOLLOW_UP', 'Training and handover', 'How to edit content; hand over logins and documentation.', 'MANAGER', 42, 'INTERNAL', false, false, false, 9),
      (v_pb, 'FOLLOW_UP', '30-day support check', null, 'DEAL_OWNER', 70, 'INTERNAL', true, false, false, 10);
  end if;

  if not exists (select 1 from proposal_section) then
    insert into proposal_section (name, body) values
      ('About BabulTech', '<p>BabulTech builds software and digital products for growing businesses in Pakistan and abroad. Our team designs, builds and supports what we sell, so you deal with one partner from the first meeting to long after launch.</p>')
      returning id into v_about;
    insert into proposal_section (name, body) values
      ('Terms and conditions', '<ul><li>This proposal is valid until {{proposal.validUntil}}.</li><li>Prices are in {{opportunity.currency}} and exclude taxes unless stated.</li><li>Work starts once the proposal is accepted and the first payment is received.</li><li>Changes to the agreed scope are quoted separately.</li></ul>')
      returning id into v_terms;
    insert into proposal_section (name, body) values
      ('Support', '<p>Support is available Monday to Saturday, 10am to 7pm, by phone, WhatsApp and email. Urgent issues are answered within 4 working hours.</p>')
      returning id into v_support;

    insert into proposal_template (name, "offeringId", "validDays", sections) values
      ('Web development proposal', v_web, 30, jsonb_build_array(
        jsonb_build_object('kind', 'TEXT', 'title', 'Introduction', 'body', '<p>Dear {{contact.firstName}},</p><p>Thank you for considering BabulTech for {{opportunity.name}}. This proposal sets out what we will build for {{account.name}}, how we will work together, and what it costs.</p>'),
        jsonb_build_object('kind', 'LIBRARY', 'title', 'About us', 'sectionId', v_about),
        jsonb_build_object('kind', 'TEXT', 'title', 'Your requirements', 'body', '<p>[Summarise what the customer told us they need, in their words.]</p>'),
        jsonb_build_object('kind', 'TEXT', 'title', 'Scope of work', 'body', '<ul><li>Pages: [list]</li><li>Features: [list]</li><li>Integrations: [list]</li></ul><p>Not included: [list anything we will not do].</p>'),
        jsonb_build_object('kind', 'TEXT', 'title', 'Timeline', 'body', '<ol><li>Kickoff and content collection - week 1</li><li>Design - weeks 2-3</li><li>Build and testing - weeks 4-5</li><li>Launch and training - week 6</li></ol>'),
        jsonb_build_object('kind', 'TEXT', 'title', 'What we need from you', 'body', '<ul><li>Logo and brand guidelines</li><li>Text and images for each page</li><li>Domain and hosting access</li><li>One person who can approve designs</li></ul>'),
        jsonb_build_object('kind', 'PRICING', 'title', 'Investment'),
        jsonb_build_object('kind', 'TEXT', 'title', 'Payment schedule', 'body', '<ul><li>40% on acceptance</li><li>40% on design approval</li><li>20% on launch</li></ul>'),
        jsonb_build_object('kind', 'LIBRARY', 'title', 'Terms', 'sectionId', v_terms)
      )),
      ('BabulPOS proposal', v_pos, 15, jsonb_build_array(
        jsonb_build_object('kind', 'TEXT', 'title', 'Introduction', 'body', '<p>Dear {{contact.firstName}},</p><p>Thank you for your interest in BabulPOS for {{account.name}}. This proposal covers the plan, hardware, installation and training to get your business selling on BabulPOS.</p>'),
        jsonb_build_object('kind', 'LIBRARY', 'title', 'About us', 'sectionId', v_about),
        jsonb_build_object('kind', 'TEXT', 'title', 'Your business', 'body', '<p>Business type: [restaurant / retail / pharmacy]<br>Branches: [number and cities]<br>Terminals per branch: [number]</p>'),
        jsonb_build_object('kind', 'TEXT', 'title', 'What you get', 'body', '<ul><li>BabulPOS licences for each terminal</li><li>Installation and setup at your premises</li><li>Product or menu import</li><li>Staff training</li><li>Go-live support</li></ul>'),
        jsonb_build_object('kind', 'PRICING', 'title', 'Pricing'),
        jsonb_build_object('kind', 'TEXT', 'title', 'Go-live plan', 'body', '<p>We aim to have you selling on BabulPOS within two weeks of acceptance.</p>'),
        jsonb_build_object('kind', 'LIBRARY', 'title', 'Support', 'sectionId', v_support),
        jsonb_build_object('kind', 'TEXT', 'title', 'Subscription and renewal', 'body', '<p>Subscriptions renew automatically each period unless cancelled 30 days before renewal.</p>'),
        jsonb_build_object('kind', 'LIBRARY', 'title', 'Terms', 'sectionId', v_terms)
      ));
  end if;
end $$;

notify pgrst, 'reload schema';
