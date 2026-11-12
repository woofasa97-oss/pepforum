-- ============================================================================
-- 0037 · What each store sells, and the certificates it links (ADR-0011)
--
-- The Stores directory's store page shows, beside the audit (…035):
--   * the store's listing: the peptides it sells and their listed prices, read
--     from its own product feed or product pages with the price pipeline's
--     ladder and offer rules (the price appears in the store's raw text, the
--     currency is stated, the product address is on the store's own brand).
--     Each read is dated and kept; the latest is shown. Prices stay in the
--     store's currency and are never compared or ranked here: comparisons are
--     the Prices section's, from gate-passed runs only (docs/PRICES.md);
--   * the certificate documents the store links on its pages, as found.
--
-- Closed to API roles like the rest of `prices`; read through get_store() and
-- get_store_directory(), behind `features.stores` (admins preview). Addresses
-- are resolved by price_link() ('listing', 'document') and never rendered.
-- Everything here adds or widens: the deployed web app keeps working.
-- ============================================================================

create table prices.store_catalogue_reads (
  id            uuid primary key default gen_random_uuid(),
  vendor_id     uuid not null references prices.vendors (id),
  observed_on   date not null,
  source        text not null check (source in ('woo_store_api', 'woo_embedded_variations', 'shopify_products_json', 'shopify_product_js', 'jsonld')),
  complete      boolean not null,                       -- the read reached the end of the catalogue
  products_seen integer not null check (products_seen >= 0),
  created_at    timestamptz not null default now(),
  unique (vendor_id, observed_on)
);

create table prices.store_listings (
  id               uuid primary key default gen_random_uuid(),
  read_id          uuid not null references prices.store_catalogue_reads (id),
  compound_id      uuid not null references prices.compounds (id),
  product_name     text not null check (char_length(product_name) between 1 and 300),
  variant_label    text check (char_length(variant_label) <= 200),
  form             text not null check (form in ('vial', 'capsule', 'tablet', 'nasal', 'pen', 'topical', 'solution', 'bulk', 'unknown')),
  mg_per_vial      numeric(10, 3) check (mg_per_vial is null or mg_per_vial > 0),
  vials_per_pack   integer check (vials_per_pack is null or vials_per_pack >= 1),
  total_mg         numeric(10, 3) check (total_mg is null or total_mg > 0),
  is_blend         boolean not null default false,
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  price_minor      bigint not null check (price_minor > 0),
  list_price_minor bigint check (list_price_minor is null or list_price_minor >= price_minor),
  on_sale          boolean not null default false,
  per_mg_minor_e4  bigint check (per_mg_minor_e4 is null or per_mg_minor_e4 > 0),
  availability     text not null check (availability in ('in_stock', 'out_of_stock', 'backorder', 'preorder', 'discontinued', 'unknown')),
  product_url      text check (product_url is null or (product_url ~ '^https://' and char_length(product_url) <= 600)),
  raw_price_text   text not null check (char_length(raw_price_text) between 1 and 200)
);
create index store_listings_read on prices.store_listings (read_id);
create index store_catalogue_reads_latest on prices.store_catalogue_reads (vendor_id, observed_on desc);

create table prices.store_documents (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references prices.vendors (id),
  url         text not null check (url ~ '^https://' and char_length(url) <= 600),
  label       text not null check (char_length(label) between 1 and 160),
  compound_id uuid references prices.compounds (id),
  found_on    date not null,
  unique (vendor_id, url)
);

alter table prices.store_catalogue_reads enable row level security;
alter table prices.store_listings enable row level security;
alter table prices.store_documents enable row level security;

create trigger store_catalogue_reads_append_only before update or delete on prices.store_catalogue_reads
  for each row execute function private.forbid_mutation();
create trigger store_catalogue_reads_no_truncate before truncate on prices.store_catalogue_reads
  for each statement execute function private.forbid_mutation();
create trigger store_listings_append_only before update or delete on prices.store_listings
  for each row execute function private.forbid_mutation();
create trigger store_listings_no_truncate before truncate on prices.store_listings
  for each statement execute function private.forbid_mutation();

comment on table prices.store_catalogue_reads is 'One dated read of a store''s catalogue (its feed or product pages). Append-only; the latest is shown.';
comment on table prices.store_listings is 'What a read found: matched peptides and their listed prices, in the store''s currency. Never compared or ranked.';
comment on table prices.store_documents is 'Certificate documents a store links on its own pages, as found by the audit. Shown as the store''s, not checked.';

-- ---------------------------------------------------------------------------
-- Read API
-- ---------------------------------------------------------------------------
-- The latest catalogue read of each vendor.
create function private.latest_catalogue_read(p_vendor uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select r.id from prices.store_catalogue_reads r
  where r.vendor_id = p_vendor
  order by r.observed_on desc, r.created_at desc
  limit 1;
$$;

create or replace function public.get_store_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prices boolean := private.cfg_bool('features.prices');
begin
  if not private.stores_visible() then
    return null;
  end if;

  return jsonb_build_object(
    'preview', not private.cfg_bool('features.stores'),
    'stores', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', v.slug, 'name', v.name, 'domain', v.canonical_domain, 'kind', v.kind,
               'country', v.origin_country, 'ships_to', v.ships_to, 'ships_worldwide', v.ships_worldwide,
               'currency', v.native_currency,
               'has_prices', v_prices and v.status = 'active'
                             and exists (select 1 from prices.published_offers p where p.vendor_id = v.id),
               'listings', (select count(*) from prices.store_listings l where l.read_id = private.latest_catalogue_read(v.id)),
               'compounds', coalesce((select jsonb_agg(distinct c.slug)
                                      from prices.store_listings l join prices.compounds c on c.id = l.compound_id
                                      where l.read_id = private.latest_catalogue_read(v.id)), '[]'::jsonb),
               'documents', (select count(*) from prices.store_documents d where d.vendor_id = v.id),
               'audit', (
                 select jsonb_build_object(
                          'audited_on', a.audited_on, 'standard_version', a.standard_version, 'reachable', a.reachable,
                          'results', coalesce((select jsonb_object_agg(c.criterion, c.result)
                                               from prices.store_audit_checks c where c.audit_id = a.id), '{}'::jsonb))
                 from prices.store_audits a
                 where a.vendor_id = v.id
                 order by a.audited_on desc, a.created_at desc
                 limit 1))
             order by lower(v.name))
      from prices.vendors v
      where v.status <> 'delisted'), '[]'::jsonb),
    'compounds', coalesce((
      select jsonb_agg(jsonb_build_object('slug', c.slug, 'name', c.name) order by lower(c.name))
      from prices.compounds c
      where exists (select 1 from prices.store_listings l
                    join prices.store_catalogue_reads r on r.id = l.read_id
                    join prices.vendors v on v.id = r.vendor_id and v.status <> 'delisted'
                    where l.compound_id = c.id)), '[]'::jsonb),
    'labs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', l.slug, 'name', l.name, 'country', l.country, 'tier', l.tier,
               'accreditation_body', l.accreditation_body, 'accreditation_number', l.accreditation_number,
               'verify_how', l.verify_how, 'has_website', l.website_url is not null,
               'has_evidence', l.evidence_url is not null, 'evidence_quote', l.evidence_quote, 'checked_on', l.checked_on)
             order by lower(l.name))
      from prices.labs l), '[]'::jsonb));
end;
$$;

create or replace function public.get_store(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v       prices.vendors;
  v_audit prices.store_audits;
  v_read  prices.store_catalogue_reads;
begin
  if not private.stores_visible() or p_slug is null then
    return null;
  end if;
  select * into v from prices.vendors where slug = p_slug and status <> 'delisted';
  if v.id is null then
    return null;
  end if;
  select * into v_audit from prices.store_audits a where a.vendor_id = v.id
  order by a.audited_on desc, a.created_at desc limit 1;
  select * into v_read from prices.store_catalogue_reads r where r.id = private.latest_catalogue_read(v.id);

  return jsonb_build_object(
    'preview', not private.cfg_bool('features.stores'),
    'slug', v.slug, 'name', v.name, 'domain', v.canonical_domain, 'kind', v.kind,
    'country', v.origin_country, 'ships_to', v.ships_to, 'ships_worldwide', v.ships_worldwide,
    'currency', v.native_currency,
    'has_prices', private.cfg_bool('features.prices') and v.status = 'active'
                  and exists (select 1 from prices.published_offers p where p.vendor_id = v.id),
    'audits', (select count(*) from prices.store_audits a where a.vendor_id = v.id),
    'audit', case when v_audit.id is null then null else jsonb_build_object(
      'audited_on', v_audit.audited_on, 'standard_version', v_audit.standard_version,
      'method', v_audit.method, 'reachable', v_audit.reachable,
      'checks', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', c.id, 'criterion', c.criterion, 'result', c.result, 'value', c.value,
                 'quote', c.quote, 'has_source', c.source_url is not null, 'quote_verified_on', c.quote_verified_on))
        from prices.store_audit_checks c where c.audit_id = v_audit.id), '[]'::jsonb)) end,
    'catalogue', case when v_read.id is null then null else jsonb_build_object(
      'observed_on', v_read.observed_on, 'source', v_read.source, 'complete', v_read.complete,
      'products_seen', v_read.products_seen,
      'listings', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', l.id, 'compound', c.slug, 'compound_name', c.name, 'product_name', l.product_name,
                 'variant_label', l.variant_label, 'form', l.form, 'mg_per_vial', l.mg_per_vial,
                 'vials_per_pack', l.vials_per_pack, 'total_mg', l.total_mg, 'is_blend', l.is_blend,
                 'currency', l.currency, 'price_minor', l.price_minor, 'list_price_minor', l.list_price_minor,
                 'on_sale', l.on_sale, 'per_mg_minor_e4', l.per_mg_minor_e4, 'availability', l.availability,
                 'has_url', l.product_url is not null)
               order by lower(c.name), l.mg_per_vial nulls last, l.vials_per_pack nulls first, l.price_minor)
        from prices.store_listings l join prices.compounds c on c.id = l.compound_id
        where l.read_id = v_read.id), '[]'::jsonb)) end,
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label, 'compound', c.slug, 'compound_name', c.name, 'found_on', d.found_on)
                       order by c.name nulls last, d.label)
      from (select * from prices.store_documents x where x.vendor_id = v.id order by x.label limit 300) d
      left join prices.compounds c on c.id = d.compound_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Links: a listing goes to its product page (or the store's home page) and
-- counts a store visit; a document goes to the document.
-- ---------------------------------------------------------------------------
create or replace function public.price_link(p_kind text, p_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
  v_url    text;
  v_uuid   constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_id is null then
    return null;
  end if;

  if p_kind in ('store', 'evidence', 'lab', 'listing', 'document') then
    if not private.stores_visible() then
      return null;
    end if;
    if p_kind in ('evidence', 'listing', 'document') and p_id !~ v_uuid then
      return null;
    end if;
    if p_kind = 'evidence' then
      select c.source_url into v_url
      from prices.store_audit_checks c
      join prices.store_audits a on a.id = c.audit_id
      join prices.vendors v on v.id = a.vendor_id and v.status <> 'delisted'
      where c.id = p_id::uuid;
      return case when v_url ~ '^https://' then v_url end;
    elsif p_kind = 'document' then
      select d.url into v_url
      from prices.store_documents d
      join prices.vendors v on v.id = d.vendor_id and v.status <> 'delisted'
      where d.id = p_id::uuid;
      return case when v_url ~ '^https://' then v_url end;
    elsif p_kind = 'lab' then
      select l.website_url into v_url from prices.labs l where l.slug = p_id;
      return case when v_url ~ '^https://' then v_url end;
    elsif p_kind = 'listing' then
      select v.id, coalesce(l.product_url, v.website_url) into v_vendor, v_url
      from prices.store_listings l
      join prices.store_catalogue_reads r on r.id = l.read_id
      join prices.vendors v on v.id = r.vendor_id and v.status <> 'delisted'
      where l.id = p_id::uuid;
    else
      select v.id, v.website_url into v_vendor, v_url
      from prices.vendors v
      where v.slug = p_id and v.status <> 'delisted';
    end if;
  else
    if not private.cfg_bool('features.prices') then
      return null;
    end if;
    if p_kind = 'coa' then
      if p_id !~ v_uuid then
        return null;
      end if;
      select d.url into v_url
      from prices.coa_documents d
      join prices.vendors v on v.id = d.vendor_id and v.status = 'active'
      where d.id = p_id::uuid and d.status = 'published';
      return case when v_url ~ '^https://' then v_url end;
    elsif p_kind = 'offer' then
      if p_id !~ v_uuid then
        return null;
      end if;
      select v.id, coalesce(p.product_url, v.website_url) into v_vendor, v_url
      from prices.published_offers p
      join prices.vendors v on v.id = p.vendor_id and v.status = 'active'
      where p.offer_id = p_id::uuid;
    elsif p_kind = 'vendor' then
      select v.id, v.website_url into v_vendor, v_url
      from prices.vendors v
      where v.slug = p_id and v.status = 'active'
        and exists (select 1 from prices.published_offers p where p.vendor_id = v.id);
    else
      return null;
    end if;
  end if;

  if v_vendor is null or v_url is null or v_url !~ '^https://' then
    return null;
  end if;

  insert into prices.click_daily_stats (vendor_id, day, clicks)
  values (v_vendor, (now() at time zone 'UTC')::date, 1)
  on conflict (vendor_id, day) do update set clicks = prices.click_daily_stats.clicks + 1;

  return v_url;
end;
$$;
