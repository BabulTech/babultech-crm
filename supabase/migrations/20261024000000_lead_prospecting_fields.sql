-- Fields for leads found by prospecting, such as the Ontario ICP list taken
-- from Google Maps: businesses with a phone and a map listing but no contact
-- person yet.
--
--   icpTier            how well they fit the ideal customer: "A - Core" or "B - Broad"
--   googleRating       their Google stars, 0 to 5
--   googleReviewCount  how many Google reviews they have
--   googleMapsUrl      their Google Maps listing
--   phoneClass         "Canadian/US" or "Non-North-American format"
--   phoneType          mobile, landline… filled in by the team after calling
--   region             the area they were found in: GTA, Hamilton/Niagara/…
--   leadList           which list they came from, e.g. "Phone + Website"

alter table lead
  add column if not exists "icpTier" varchar(60),
  add column if not exists "googleRating" numeric(2,1),
  add column if not exists "googleReviewCount" integer,
  add column if not exists "googleMapsUrl" text,
  add column if not exists "phoneClass" varchar(60),
  add column if not exists "phoneType" varchar(60),
  add column if not exists region varchar(120),
  add column if not exists "leadList" varchar(120);

alter table lead drop constraint if exists lead_google_rating_range;
alter table lead add constraint lead_google_rating_range check ("googleRating" is null or ("googleRating" >= 0 and "googleRating" <= 5));
alter table lead drop constraint if exists lead_google_review_count_positive;
alter table lead add constraint lead_google_review_count_positive check ("googleReviewCount" is null or "googleReviewCount" >= 0);

create index if not exists lead_icp_tier_idx on lead ("icpTier") where "deletedAt" is null;
create index if not exists lead_region_idx on lead (region) where "deletedAt" is null;
create index if not exists lead_list_idx on lead ("leadList") where "deletedAt" is null;

notify pgrst, 'reload schema';
