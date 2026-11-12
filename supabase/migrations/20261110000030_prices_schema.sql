-- ============================================================================
-- 0030 · Price tracking: schema, the pipeline's login, publishing
--
-- Ported from the PepSpotter price pipeline (its migrations 01–03, 05, 07–10
-- and 12) onto Pepforum's model. See docs/PRICES.md and ADR-0008.
--
--   * Everything lives in the schema `prices`, which PostgREST does not expose.
--     No API role (anon, authenticated, service_role) holds any privilege in
--     it; the site reads through the read-API functions of migration …031.
--   * The pipeline (apps/prices) connects straight to Postgres as the login
--     `pepforum_prices`. It can read the catalogue, write offers, run records
--     and exchange rates, and call the four functions below. It cannot DELETE
--     anything, change the schema or touch any forum table. It is not an API
--     role and never holds the secret key (invariant 4).
--   * `offers` is the pipeline's working table. A run's rows reach the site
--     only after the gate passed that run and `publish_offers` copied them to
--     `published_offers`.
--   * Removal is a move to `offer_quarantine`, never a delete; the price log
--     (`offer_observations`) is append-only.
--
-- private.security_audit() now also covers `prices`.
-- ============================================================================

create schema prices;
comment on schema prices is
  'Price tracking: vendor catalogue, offers, run records. Never exposed through PostgREST; '
  'written by the pepforum_prices login, read by the site through public.get_price_* functions.';

revoke all on schema prices from public;
alter default privileges in schema prices revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges in schema prices revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema prices revoke all on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table prices.compounds (
  id               uuid primary key default gen_random_uuid(),
  slug             text        not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name             text        not null,
  type             text        not null check (type in ('Single compound', 'Copper complex', 'Blend')),
  aliases          text[]      not null default '{}',
  formulation      text        not null default 'Lyophilized powder',
  salt_or_variant  text,
  blend_components jsonb,                          -- [{ "name": "BPC-157", "mg": 5 }, ...] for blends
  known_sizes_mg   numeric[]   not null default '{}',
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table prices.compounds is 'Canonical research compounds. Aliases drive product matching; ambiguity never matches.';

create table prices.vendors (
  id                 uuid primary key default gen_random_uuid(),
  slug               text        not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name               text        not null check (char_length(name) between 1 and 120),
  website_url        text        not null check (website_url ~ '^https://'),
  canonical_domain   text        not null,
  origin_country     text        not null check (origin_country in ('US', 'CA', 'GB', 'AU', 'NZ', 'EU', 'OTHER')),
  origin_source      text,                         -- where the "based in" evidence came from
  ships_to           text[]      not null default '{}',   -- ISO country codes we hold evidence for
  ships_to_source    text,
  native_currency    text check (native_currency in ('USD', 'CAD', 'GBP', 'AUD', 'NZD', 'EUR')),
  detected_platform  text check (detected_platform in ('woocommerce', 'shopify', 'jsonld', 'custom', 'woocommerce_closed_api',
                                                        'shopify_closed_api', 'bigcommerce', 'squarespace', 'wix', 'blocked', 'unreachable')),
  platform_probed_at timestamptz,
  status             text        not null default 'pending' check (status in ('pending', 'active', 'paused', 'delisted')),
  status_note        text,
  -- The store refuses our reader (401/403/406…). It stays listed with its last
  -- checked prices but no longer counts towards the gate's "vendors gone silent".
  unreadable         boolean     not null default false,
  coa_scope          text        not null default 'unknown' check (coa_scope in ('none', 'vendor', 'product', 'batch', 'unknown')),
  last_ingested_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table prices.vendors is 'Stores we read. status = active means its published offers may be shown; ships_to is evidence-based, never assumed.';

create trigger compounds_touch before update on prices.compounds for each row execute function private.touch_updated_at();
create trigger vendors_touch   before update on prices.vendors   for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Offers, the price log, quarantine, candidates, run records
-- ---------------------------------------------------------------------------
create table prices.offers (
  id                      uuid primary key default gen_random_uuid(),
  vendor_id               uuid        not null references prices.vendors (id) on delete cascade,
  compound_id             uuid        not null references prices.compounds (id) on delete cascade,
  product_key             text        not null,             -- vendor:compound:<host/path> or vendor:compound:fallback:<hash>
  variant_key             text        not null default '',  -- platform variation id, '' for a simple product
  product_url             text check (product_url is null or (product_url ~ '^https?://'
                                      and product_url !~* '\.(png|jpe?g|webp|gif|svg)(\?|$)' and product_url !~ '/wp-content/uploads/')),
  product_name            text        not null,
  variant_label           text,
  source_system           text        not null check (source_system in ('woocommerce', 'shopify', 'jsonld')),
  source_product_id       text,
  source_variant_id       text,
  price_source            text        not null check (price_source in ('woo_store_api', 'woo_embedded_variations', 'shopify_products_json', 'shopify_product_js', 'jsonld')),
  native_currency         text        not null check (native_currency in ('USD', 'CAD', 'GBP', 'AUD', 'NZD', 'EUR')),
  price_minor             bigint      not null check (price_minor > 0),
  list_price_minor        bigint check (list_price_minor is null or list_price_minor >= price_minor),
  on_sale                 boolean     not null default false,
  price_kind              text        not null default 'per_pack' check (price_kind in ('per_pack', 'fixed_kit')),
  mg_per_vial             numeric(10, 3) check (mg_per_vial is null or mg_per_vial > 0),
  vials_per_pack          integer check (vials_per_pack is null or vials_per_pack >= 1),
  total_mg                numeric(10, 3) check (total_mg is null or total_mg > 0),
  form                    text        not null default 'vial' check (form in ('vial', 'capsule', 'tablet', 'nasal', 'pen', 'topical', 'solution', 'bulk', 'unknown')),
  is_blend                boolean     not null default false,
  comparable              boolean     not null default false,
  quantity_reason         text,                             -- blend | non_vial_form | bulk_over_max | no_mg | pack_ambiguous | multi_size
  per_mg_minor_e4         bigint,                           -- minor units per mg × 10^4, only when comparable
  availability            text        not null default 'unknown' check (availability in ('in_stock', 'out_of_stock', 'backorder', 'preorder', 'discontinued', 'unknown')),
  availability_checked_at timestamptz,
  raw_price_text          text        not null,
  extraction_confidence   text        not null check (extraction_confidence in ('high', 'low')),
  observed_at             timestamptz not null,             -- when the vendor was read
  price_changed_at        timestamptz not null,             -- moves only when price, list price or availability change
  run_id                  uuid,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  recipe_key              text,                             -- a blend's exact mix, e.g. bpc-157:10+tb-500:10; null when not stated
  unique (vendor_id, compound_id, product_key, variant_key),
  check (comparable = false or (per_mg_minor_e4 is not null and total_mg is not null and mg_per_vial is not null))
);
create unique index offers_platform_sku on prices.offers (vendor_id, source_product_id, coalesce(source_variant_id, ''))
  where source_product_id is not null;
create index offers_compound_idx on prices.offers (compound_id, comparable, availability, observed_at desc);
create trigger offers_touch before update on prices.offers for each row execute function private.touch_updated_at();
comment on table prices.offers is 'The pipeline''s working table: one row per vendor SKU that matched a compound. The site never reads it.';

-- Append-only price log: one row per SKU per run.
create table prices.offer_observations (like prices.offers including defaults);
alter table prices.offer_observations add column offer_id uuid, add column run_label text;
alter table prices.offer_observations add primary key (id);
create index offer_observations_offer_idx    on prices.offer_observations (vendor_id, product_key, variant_key, observed_at desc);
create index offer_observations_compound_idx on prices.offer_observations (compound_id, observed_at desc);
create trigger offer_observations_append_only before update or delete on prices.offer_observations
  for each row execute function private.forbid_mutation();

-- Lossless soft delete.
create table prices.offer_quarantine (like prices.offers including defaults);
alter table prices.offer_quarantine
  add column original_id uuid not null,
  add column reason text not null,
  add column quarantine_run_id uuid,
  add column quarantined_at timestamptz not null default now(),
  add column restored_at timestamptz;
alter table prices.offer_quarantine add primary key (id);
create index offer_quarantine_run_idx on prices.offer_quarantine (quarantine_run_id);

-- Products the pipeline saw but would not write: unmatched, ambiguous, unresolved currency, bad URL.
create table prices.offer_candidates (
  id               uuid primary key default gen_random_uuid(),
  run_label        text        not null,
  vendor_id        uuid        not null references prices.vendors (id) on delete cascade,
  product_url      text        not null,
  product_name     text        not null,
  reject_reason    text        not null,
  match_candidates text[]      not null default '{}',
  raw              jsonb       not null,
  created_at       timestamptz not null default now(),
  unique (run_label, vendor_id, product_url)
);

create table prices.refresh_runs (
  id              uuid primary key default gen_random_uuid(),
  run_label       text        not null unique,
  mode            text        not null check (mode in ('feeds', 'pages', 'probe', 'fx')),
  dry_run         boolean     not null default true,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text        not null default 'running' check (status in ('running', 'committed', 'held', 'error')),
  verdict         text check (verdict in ('pass', 'hold')),
  baseline_run_id uuid references prices.refresh_runs (id),
  metrics         jsonb       not null default '{}',
  checks          jsonb       not null default '{}',
  notes           text
);

create table prices.refresh_attempts (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid        not null references prices.refresh_runs (id) on delete cascade,
  vendor_id          uuid        not null references prices.vendors (id) on delete cascade,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  outcome            text check (outcome in ('hit', 'miss', 'unknown', 'held', 'blocked')),
  run_complete       boolean     not null default false,
  rung               text,
  http_status        integer,
  products_seen      integer,
  matched            integer,
  rows_written       integer,
  counts             jsonb       not null default '{}',
  raw_capture_uri    text,
  raw_capture_sha256 text,
  raw_capture_bytes  integer,
  error              text
);
create index refresh_attempts_vendor_idx on prices.refresh_attempts (vendor_id, finished_at desc);

-- ---------------------------------------------------------------------------
-- Terms no storefront feed carries. Every row carries its evidence.
-- ---------------------------------------------------------------------------
create table prices.fx_rates (
  id             uuid primary key default gen_random_uuid(),
  base_currency  text           not null check (base_currency in ('USD', 'CAD', 'GBP', 'AUD', 'NZD', 'EUR')),
  quote_currency text           not null check (quote_currency in ('USD', 'CAD', 'GBP', 'AUD', 'NZD', 'EUR')),
  rate           numeric(14, 8) not null check (rate > 0),   -- 1 base = rate quote
  provider       text           not null,
  rate_date      date           not null,                    -- the provider's reference date
  fetched_at     timestamptz    not null default now(),
  unique (base_currency, quote_currency, rate_date)
);

create table prices.quantity_tiers (
  id                uuid primary key default gen_random_uuid(),
  vendor_id         uuid        not null references prices.vendors (id) on delete cascade,
  compound_id       uuid references prices.compounds (id) on delete cascade,   -- null = vendor-wide
  threshold         integer     not null check (threshold >= 1),
  basis             text        not null check (basis in ('vials', 'packs', 'spend_minor')),
  scope             text        not null default 'all_units' check (scope in ('all_units', 'marginal')),
  discount_pct      numeric(6, 3) check (discount_pct is null or (discount_pct > 0 and discount_pct < 100)),
  tier_price_minor  bigint check (tier_price_minor is null or tier_price_minor > 0),
  currency          text check (currency in ('USD', 'CAD', 'GBP', 'AUD', 'NZD', 'EUR')),
  valid_from        date,
  valid_to          date,
  exclusions        text,
  evidence_url      text        not null check (evidence_url ~ '^https://'),
  evidence_text     text,
  observed_at       timestamptz not null,
  status            text        not null default 'unverified' check (status in ('verified', 'unverified', 'expired')),
  applies_to_blends boolean     not null default false,
  mix_and_match     boolean     not null default false,
  created_at        timestamptz not null default now(),
  check ((discount_pct is not null) <> (tier_price_minor is not null))
);
create unique index quantity_tiers_vendor_wide_vials on prices.quantity_tiers (vendor_id, threshold)
  where compound_id is null and basis = 'vials';

create table prices.shipping_terms (
  id                   uuid primary key default gen_random_uuid(),
  vendor_id            uuid        not null references prices.vendors (id) on delete cascade,
  destination          text        not null check (destination in ('US', 'CA')),
  service              text        not null default '',
  amount_minor         bigint check (amount_minor is null or amount_minor >= 0),   -- null = unknown (never zero)
  currency             text check (currency in ('USD', 'CAD', 'GBP', 'AUD', 'NZD', 'EUR')),
  free_threshold_minor bigint,
  threshold_basis      text check (threshold_basis in ('before_discounts', 'after_discounts')),
  exclusions           text,
  evidence_url         text        not null check (evidence_url ~ '^https://'),
  observed_at          timestamptz not null,
  created_at           timestamptz not null default now(),
  unique (vendor_id, destination, service)
);

-- ---------------------------------------------------------------------------
-- What the site may show
-- ---------------------------------------------------------------------------
create table prices.publications (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid        not null references prices.refresh_runs (id),
  published_at  timestamptz not null default now(),
  offers        integer     not null default 0,
  vendors       integer     not null default 0,
  compounds     integer     not null default 0,
  changed       integer     not null default 0,
  removed       integer     not null default 0,
  waiting       integer     not null default 0,   -- publishable rows whose own run has not passed
  unconvertible integer     not null default 0    -- publishable rows in a currency with no rate to USD
);
create index publications_published_at_idx on prices.publications (published_at desc);

create table prices.published_offers (
  offer_id         uuid primary key,              -- offers.id; no FK: a set-aside offer stays published until the next publish
  vendor_id        uuid        not null references prices.vendors (id) on delete cascade,
  compound_id      uuid        not null references prices.compounds (id) on delete cascade,
  product_url      text,
  product_name     text        not null,
  variant_label    text,
  native_currency  text        not null,
  price_minor      bigint      not null check (price_minor > 0),
  list_price_minor bigint,
  on_sale          boolean     not null default false,
  price_kind       text        not null,
  mg_per_vial      numeric(10, 3),
  vials_per_pack   integer     not null check (vials_per_pack >= 1),
  total_mg         numeric(10, 3),
  per_mg_minor_e4  bigint,
  availability     text        not null,
  observed_at      timestamptz not null,
  price_changed_at timestamptz not null,
  source_run_id    uuid        not null,
  publication_id   uuid references prices.publications (id) on delete set null,
  recipe_key       text,
  is_blend         boolean     not null default false,
  constraint published_offers_per_mg_or_blend
    check (is_blend or (mg_per_vial is not null and total_mg is not null and per_mg_minor_e4 is not null))
);
create index published_offers_compound_idx on prices.published_offers (compound_id);
create index published_offers_vendor_idx   on prices.published_offers (vendor_id);
comment on table prices.published_offers is 'The checked offers the site may show. Written only by prices.publish_offers().';

-- ---------------------------------------------------------------------------
-- RLS: enabled everywhere, no policies. Nothing here is reachable by an API role.
-- ---------------------------------------------------------------------------
alter table prices.compounds          enable row level security;
alter table prices.vendors            enable row level security;
alter table prices.offers             enable row level security;
alter table prices.offer_observations enable row level security;
alter table prices.offer_quarantine   enable row level security;
alter table prices.offer_candidates   enable row level security;
alter table prices.refresh_runs       enable row level security;
alter table prices.refresh_attempts   enable row level security;
alter table prices.fx_rates           enable row level security;
alter table prices.quantity_tiers     enable row level security;
alter table prices.shipping_terms     enable row level security;
alter table prices.publications       enable row level security;
alter table prices.published_offers   enable row level security;

-- ---------------------------------------------------------------------------
-- Quarantine: a move in one transaction, and its undo
-- ---------------------------------------------------------------------------
create function prices.quarantine_offers(p_ids uuid[], p_reason text, p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  with moved as (delete from prices.offers o where o.id = any (p_ids) returning o.*)
  insert into prices.offer_quarantine (
    original_id, reason, quarantine_run_id,
    vendor_id, compound_id, product_key, variant_key, product_url, product_name, variant_label, source_system,
    source_product_id, source_variant_id, price_source, native_currency, price_minor, list_price_minor, on_sale, price_kind,
    mg_per_vial, vials_per_pack, total_mg, form, is_blend, comparable, quantity_reason, per_mg_minor_e4, availability,
    availability_checked_at, raw_price_text, extraction_confidence, observed_at, price_changed_at, run_id, created_at, updated_at, recipe_key)
  select
    m.id, p_reason, p_run_id,
    m.vendor_id, m.compound_id, m.product_key, m.variant_key, m.product_url, m.product_name, m.variant_label, m.source_system,
    m.source_product_id, m.source_variant_id, m.price_source, m.native_currency, m.price_minor, m.list_price_minor, m.on_sale, m.price_kind,
    m.mg_per_vial, m.vials_per_pack, m.total_mg, m.form, m.is_blend, m.comparable, m.quantity_reason, m.per_mg_minor_e4, m.availability,
    m.availability_checked_at, m.raw_price_text, m.extraction_confidence, m.observed_at, m.price_changed_at, m.run_id, m.created_at, m.updated_at, m.recipe_key
  from moved m;
  get diagnostics n = row_count;
  return n;
end;
$$;

create function prices.restore_quarantine_run(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer;
begin
  with candidate as (
    select distinct on (q.original_id) q.*
    from prices.offer_quarantine q
    where q.quarantine_run_id = p_run_id and q.restored_at is null
    order by q.original_id, q.quarantined_at desc
  ), landed as (
    insert into prices.offers (
      id, vendor_id, compound_id, product_key, variant_key, product_url, product_name, variant_label, source_system,
      source_product_id, source_variant_id, price_source, native_currency, price_minor, list_price_minor, on_sale, price_kind,
      mg_per_vial, vials_per_pack, total_mg, form, is_blend, comparable, quantity_reason, per_mg_minor_e4, availability,
      availability_checked_at, raw_price_text, extraction_confidence, observed_at, price_changed_at, run_id, created_at, updated_at, recipe_key)
    select
      c.original_id, c.vendor_id, c.compound_id, c.product_key, c.variant_key, c.product_url, c.product_name, c.variant_label, c.source_system,
      c.source_product_id, c.source_variant_id, c.price_source, c.native_currency, c.price_minor, c.list_price_minor, c.on_sale, c.price_kind,
      c.mg_per_vial, c.vials_per_pack, c.total_mg, c.form, c.is_blend, c.comparable, c.quantity_reason, c.per_mg_minor_e4, c.availability,
      c.availability_checked_at, c.raw_price_text, c.extraction_confidence, c.observed_at, c.price_changed_at, c.run_id, c.created_at, pg_catalog.now(), c.recipe_key
    from candidate c
    on conflict do nothing
    returning id
  )
  update prices.offer_quarantine q set restored_at = pg_catalog.now()
  where q.quarantine_run_id = p_run_id and q.restored_at is null and q.original_id in (select l.id from landed l);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Age out rows a passing run did not confirm. Only the gate's prune calls it.
create function prices.soft_delete_stale_offers(p_run_id uuid, p_days integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids uuid[];
begin
  if p_days is null or p_days < 30 then
    raise exception 'soft_delete_stale_offers: the window must be at least 30 days (got %)', p_days;
  end if;
  if not exists (
    select 1 from prices.refresh_runs r
    where r.id = p_run_id and r.status = 'committed' and r.verdict = 'pass' and not r.dry_run
  ) then
    raise exception 'soft_delete_stale_offers: run % is not a committed PASS run', p_run_id;
  end if;
  select coalesce(pg_catalog.array_agg(o.id), '{}') into ids from prices.offers o
   where o.run_id is distinct from p_run_id and o.observed_at < pg_catalog.now() - pg_catalog.make_interval(days => p_days);
  return prices.quarantine_offers(ids, 'stale_aged_out', p_run_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish: copy what the gate passed
--
-- "Publishable" is always: (comparable, or a vial-form blend row under a Blend
-- compound) and a known pack count. A row is published when its OWN run is a
-- committed, non-dry PASS and its currency can be converted. A row whose
-- latest run was held keeps its last published values (and ages into "stale").
-- A row that left `offers`, or that a passing run found unpublishable, is
-- taken down.
-- ---------------------------------------------------------------------------
create function prices.publish_offers(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pub           uuid := pg_catalog.gen_random_uuid();
  v_changed       integer;
  v_removed       integer;
  v_waiting       integer;
  v_unconvertible integer;
  v_offers        integer;
  v_vendors       integer;
  v_compounds     integer;
begin
  if not exists (
    select 1 from prices.refresh_runs r
    where r.id = p_run_id and r.status = 'committed' and r.verdict = 'pass' and not r.dry_run
  ) then
    raise exception 'publish_offers: run % is not a committed PASS run', p_run_id;
  end if;
  -- One publish at a time.
  perform pg_catalog.pg_advisory_xact_lock(820261110);

  insert into prices.publications (id, run_id) values (v_pub, p_run_id);

  with eligible as (
    select o.* from prices.offers o
    join prices.refresh_runs r on r.id = o.run_id
    join prices.compounds c on c.id = o.compound_id
    where (o.comparable or (c.type = 'Blend' and o.is_blend and o.form = 'vial')) and o.vials_per_pack is not null
      and r.status = 'committed' and r.verdict = 'pass' and not r.dry_run
      and (o.native_currency = 'USD' or exists (
        select 1 from prices.fx_rates f where f.base_currency = o.native_currency and f.quote_currency = 'USD'))
  ), written as (
    insert into prices.published_offers as p (
      offer_id, vendor_id, compound_id, product_url, product_name, variant_label, native_currency, price_minor,
      list_price_minor, on_sale, price_kind, mg_per_vial, vials_per_pack, total_mg, per_mg_minor_e4, availability,
      observed_at, price_changed_at, source_run_id, publication_id, recipe_key, is_blend)
    select e.id, e.vendor_id, e.compound_id, e.product_url, e.product_name, e.variant_label, e.native_currency, e.price_minor,
      e.list_price_minor, e.on_sale, e.price_kind, e.mg_per_vial, e.vials_per_pack, e.total_mg, e.per_mg_minor_e4, e.availability,
      e.observed_at, e.price_changed_at, e.run_id, v_pub, e.recipe_key, not e.comparable
    from eligible e
    on conflict (offer_id) do update set
      vendor_id = excluded.vendor_id, compound_id = excluded.compound_id, product_url = excluded.product_url,
      product_name = excluded.product_name, variant_label = excluded.variant_label, native_currency = excluded.native_currency,
      price_minor = excluded.price_minor, list_price_minor = excluded.list_price_minor, on_sale = excluded.on_sale,
      price_kind = excluded.price_kind, mg_per_vial = excluded.mg_per_vial, vials_per_pack = excluded.vials_per_pack,
      total_mg = excluded.total_mg, per_mg_minor_e4 = excluded.per_mg_minor_e4, availability = excluded.availability,
      observed_at = excluded.observed_at, price_changed_at = excluded.price_changed_at,
      source_run_id = excluded.source_run_id, publication_id = excluded.publication_id,
      recipe_key = excluded.recipe_key, is_blend = excluded.is_blend
    where (p.vendor_id, p.compound_id, p.product_url, p.product_name, p.variant_label, p.native_currency, p.price_minor,
           p.list_price_minor, p.on_sale, p.price_kind, p.mg_per_vial, p.vials_per_pack, p.total_mg, p.per_mg_minor_e4,
           p.availability, p.observed_at, p.price_changed_at, p.source_run_id, p.recipe_key, p.is_blend)
      is distinct from
          (excluded.vendor_id, excluded.compound_id, excluded.product_url, excluded.product_name, excluded.variant_label,
           excluded.native_currency, excluded.price_minor, excluded.list_price_minor, excluded.on_sale, excluded.price_kind,
           excluded.mg_per_vial, excluded.vials_per_pack, excluded.total_mg, excluded.per_mg_minor_e4, excluded.availability,
           excluded.observed_at, excluded.price_changed_at, excluded.source_run_id, excluded.recipe_key, excluded.is_blend)
    returning 1
  )
  select pg_catalog.count(*) into v_changed from written;

  delete from prices.published_offers p
  where not exists (select 1 from prices.offers o where o.id = p.offer_id)
     or exists (
       select 1 from prices.offers o
       join prices.refresh_runs r on r.id = o.run_id
       join prices.compounds c on c.id = o.compound_id
       where o.id = p.offer_id
         and not ((o.comparable or (c.type = 'Blend' and o.is_blend and o.form = 'vial')) and o.vials_per_pack is not null)
         and r.status = 'committed' and r.verdict = 'pass' and not r.dry_run);
  get diagnostics v_removed = row_count;

  select pg_catalog.count(*) into v_waiting
  from prices.offers o
  join prices.compounds c on c.id = o.compound_id
  left join prices.refresh_runs r on r.id = o.run_id
  where (o.comparable or (c.type = 'Blend' and o.is_blend and o.form = 'vial')) and o.vials_per_pack is not null
    and not coalesce(r.status = 'committed' and r.verdict = 'pass' and not r.dry_run, false);

  select pg_catalog.count(*) into v_unconvertible
  from prices.offers o
  join prices.compounds c on c.id = o.compound_id
  where (o.comparable or (c.type = 'Blend' and o.is_blend and o.form = 'vial')) and o.vials_per_pack is not null
    and o.native_currency <> 'USD'
    and not exists (select 1 from prices.fx_rates f where f.base_currency = o.native_currency and f.quote_currency = 'USD');

  select pg_catalog.count(*), pg_catalog.count(distinct p.vendor_id), pg_catalog.count(distinct p.compound_id)
    into v_offers, v_vendors, v_compounds
  from prices.published_offers p;

  update prices.publications
     set offers = v_offers, vendors = v_vendors, compounds = v_compounds, changed = v_changed,
         removed = v_removed, waiting = v_waiting, unconvertible = v_unconvertible
   where id = v_pub;

  return pg_catalog.jsonb_build_object(
    'publication_id', v_pub, 'offers', v_offers, 'vendors', v_vendors, 'compounds', v_compounds,
    'changed', v_changed, 'removed', v_removed, 'waiting', v_waiting, 'unconvertible', v_unconvertible);
end;
$$;

-- ---------------------------------------------------------------------------
-- The pipeline's login
--
-- No password here: the role cannot log in until the owner sets one out of
-- band (docs/DEPLOYMENT.md). bypassrls because every table above has RLS with
-- no policies; what it may do is fixed by the grants below.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'pepforum_prices') then
    create role pepforum_prices login bypassrls noinherit nocreatedb nocreaterole;
  end if;
end;
$$;
alter role pepforum_prices login bypassrls noinherit nocreatedb nocreaterole;
alter role pepforum_prices set search_path = prices, pg_catalog;
alter role pepforum_prices set statement_timeout = '120s';

grant usage on schema prices to pepforum_prices;

grant select on prices.compounds, prices.vendors, prices.quantity_tiers, prices.shipping_terms,
                prices.publications, prices.published_offers to pepforum_prices;
grant update (last_ingested_at, detected_platform, platform_probed_at) on prices.vendors to pepforum_prices;

grant select, insert on prices.offers to pepforum_prices;
grant update (
  product_url, product_name, variant_label, source_system, source_product_id, source_variant_id, price_source,
  native_currency, price_minor, list_price_minor, on_sale, price_kind, mg_per_vial, vials_per_pack, total_mg, form,
  is_blend, comparable, quantity_reason, per_mg_minor_e4, availability, availability_checked_at, raw_price_text,
  extraction_confidence, observed_at, price_changed_at, run_id, recipe_key
) on prices.offers to pepforum_prices;

grant select, insert, update on prices.refresh_runs, prices.refresh_attempts, prices.fx_rates to pepforum_prices;
grant select, insert on prices.offer_observations, prices.offer_candidates to pepforum_prices;
grant select on prices.offer_quarantine to pepforum_prices;

grant execute on function prices.quarantine_offers(uuid[], text, uuid)      to pepforum_prices;
grant execute on function prices.restore_quarantine_run(uuid)               to pepforum_prices;
grant execute on function prices.soft_delete_stale_offers(uuid, integer)    to pepforum_prices;
grant execute on function prices.publish_offers(uuid)                       to pepforum_prices;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public, description) values
  ('features.prices', 'false', true,
   'Show the Prices section (price comparison across vendors). Off: the pages, the header link and the read functions return nothing.'),
  ('prices.stale_hours', '48', true,
   'A published price older than this many hours is shown as stale and no longer ranked.'),
  ('prices.lead_vials', '10', true,
   'How many vials the headline comparison prices ("best price for N vials").');

update public.app_config c set bounds = b.bounds
from (values ('prices.stale_hours', '{"min": 12, "max": 720}'::jsonb),
             ('prices.lead_vials',  '{"min": 1, "max": 100}'::jsonb)) as b (key, bounds)
where c.key = b.key;

-- ---------------------------------------------------------------------------
-- Security self-audit: the same checks, now also over `prices`, plus one more:
-- no API role may hold anything in that schema.
-- ---------------------------------------------------------------------------
create or replace function private.security_audit()
returns table (check_name text, object_name text, detail text)
language sql
stable
security definer
set search_path = ''
as $$
  -- 1 · Every table in an app schema has RLS enabled.
  select 'rls_disabled', n.nspname || '.' || c.relname, 'row level security is not enabled'
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p') and n.nspname in ('public', 'private', 'prices') and not c.relrowsecurity

  union all
  -- 2 · No API role can write any table directly (all writes go through RPCs).
  --     Column-level UPDATE grants (profiles' descriptive fields) are reported
  --     separately by information_schema.column_privileges and are allowed.
  select 'direct_write_grant', g.table_schema || '.' || g.table_name, g.grantee || ' has ' || g.privilege_type
  from information_schema.role_table_grants g
  where g.table_schema in ('public', 'private')
    and g.grantee in ('anon', 'authenticated', 'public')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES')

  union all
  -- 3 · Nothing in the private schema is readable by API roles.
  select 'private_table_grant', g.table_schema || '.' || g.table_name, g.grantee || ' has ' || g.privilege_type
  from information_schema.role_table_grants g
  where g.table_schema = 'private' and g.grantee in ('anon', 'authenticated', 'public', 'service_role')

  union all
  -- 4 · SECURITY DEFINER functions pin search_path (prevents object hijacking).
  select 'definer_without_search_path', n.nspname || '.' || p.proname, 'security definer function without search_path'
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'prices') and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')

  union all
  -- 5 · No function is executable by PUBLIC (the Postgres default we revoke).
  select 'function_executable_by_public', n.nspname || '.' || p.proname, 'EXECUTE granted to PUBLIC'
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'prices')
    and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE')

  union all
  -- 6 · Votes, ratings and reports are never broadcast over Realtime.
  select 'realtime_publication', pt.schemaname || '.' || pt.tablename, 'table is in supabase_realtime'
  from pg_catalog.pg_publication_tables pt
  where pt.pubname = 'supabase_realtime' and pt.schemaname in ('public', 'private', 'prices')

  union all
  -- 7 · The prices schema is closed to every API role: no schema usage, no
  --     table privilege (including column grants), no function.
  select 'prices_schema_usage', 'prices', r.rolname || ' has USAGE'
  from pg_catalog.pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role')
    and pg_catalog.has_schema_privilege(r.rolname, 'prices', 'USAGE')

  union all
  select 'prices_table_grant', g.table_schema || '.' || g.table_name, g.grantee || ' has ' || g.privilege_type
  from information_schema.role_table_grants g
  where g.table_schema = 'prices' and g.grantee in ('anon', 'authenticated', 'public', 'service_role')

  union all
  select 'prices_column_grant', g.table_schema || '.' || g.table_name || '.' || g.column_name, g.grantee || ' has ' || g.privilege_type
  from information_schema.column_privileges g
  where g.table_schema = 'prices' and g.grantee in ('anon', 'authenticated', 'public', 'service_role')

  union all
  select 'prices_function_grant', 'prices.' || p.proname, r.rolname || ' may execute'
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join pg_catalog.pg_roles r
  where n.nspname = 'prices' and r.rolname in ('anon', 'authenticated', 'service_role')
    and pg_catalog.has_function_privilege(r.rolname, p.oid, 'EXECUTE');
$$;
