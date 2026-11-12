-- ============================================================================
-- 0035 · The Stores directory and its public-information audit (ADR-0011)
--
-- Pepforums lists every store that sells research peptides online, worldwide,
-- and audits each one against the parts of the Pepforums Standard
-- (docs/QUALITY_ASSURANCE.md §9.1) that can be checked from its public pages.
--
--   * Stores are rows of prices.vendors. Any status but 'delisted' is listed in
--     the directory; only 'active' stores with published offers have prices.
--   * Where a store is based is any ISO 3166-1 country, or unknown when its own
--     site doesn't say. Its currency is any ISO 4217 code.
--   * An audit is a dated record of fourteen checks under one version of the
--     Standard. Each check has a result, and, when the result rests on
--     something the store published, the page and the exact words. Audits are
--     append-only: a correction is a new audit.
--   * A public list of the laboratories named on certificates, with their tier
--     under §3.
--   * Nothing here is a grade (§8.3): the Standard is a draft and no grade is
--     published before v1.0.
--   * `features.stores` gates every read. While it is off, admins still see the
--     directory as a preview.
--   * No store, evidence or lab address is rendered raw: links go through
--     price_link(), as for prices (…032).
--
-- Everything here adds or widens, so the web app deployed before this
-- migration keeps working.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Stores: any country, any currency, store or manufacturer
-- ---------------------------------------------------------------------------
alter table prices.vendors drop constraint vendors_origin_country_check;
alter table prices.vendors alter column origin_country drop not null;
update prices.vendors set origin_country = null where origin_country in ('EU', 'OTHER');
alter table prices.vendors add constraint vendors_origin_country_check
  check (origin_country is null or origin_country ~ '^[A-Z]{2}$');

alter table prices.vendors drop constraint vendors_native_currency_check;
alter table prices.vendors add constraint vendors_native_currency_check
  check (native_currency is null or native_currency ~ '^[A-Z]{3}$');

alter table prices.vendors
  add column kind text not null default 'store' check (kind in ('store', 'manufacturer')),
  add column ships_worldwide boolean not null default false;

comment on column prices.vendors.origin_country is
  'ISO 3166-1 alpha-2 country the store''s own site says it is based in; null when it doesn''t say.';
comment on column prices.vendors.ships_worldwide is
  'The store''s own site says it ships worldwide. ships_to lists the countries we hold specific evidence for.';

-- The admin form: any ISO country, or not stated.
create or replace function public.admin_price_vendor_save(
  p_slug text, p_name text, p_website_url text, p_origin_country text, p_origin_source text, p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := private.require_admin_write(p_reason);
  v_slug    text := lower(btrim(coalesce(p_slug, '')));
  v_name    text := btrim(coalesce(p_name, ''));
  v_url     text := rtrim(btrim(coalesce(p_website_url, '')), '/');
  v_country text := nullif(upper(btrim(coalesce(p_origin_country, ''))), '');
  v_domain  text;
  v_id      uuid;
begin
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) > 60 then
    perform private.raise_error('PF422', 'invalid_vendor_slug');
  end if;
  if char_length(v_name) not between 1 and 120 then
    perform private.raise_error('PF422', 'invalid_vendor_name');
  end if;
  if v_url !~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$' or char_length(v_url) > 300 then
    perform private.raise_error('PF422', 'invalid_vendor_url');
  end if;
  if v_country is not null and v_country !~ '^[A-Z]{2}$' then
    perform private.raise_error('PF422', 'invalid_vendor_country');
  end if;
  v_domain := regexp_replace(regexp_replace(v_url, '^https://(www\.)?', ''), '/.*$', '');

  insert into prices.vendors (slug, name, website_url, canonical_domain, origin_country, origin_source)
  values (v_slug, v_name, v_url, v_domain, v_country, nullif(btrim(coalesce(p_origin_source, '')), ''))
  on conflict (slug) do update set
    name = excluded.name, website_url = excluded.website_url, canonical_domain = excluded.canonical_domain,
    origin_country = excluded.origin_country, origin_source = excluded.origin_source
  returning id into v_id;

  perform private.log_mod_action(v_uid, 'price_vendor_saved', 'price_vendor', v_id, null, null, btrim(p_reason),
                                 jsonb_build_object('slug', v_slug, 'domain', v_domain, 'origin_country', v_country));
  return v_slug;
end;
$$;

-- ---------------------------------------------------------------------------
-- Laboratories (§3)
-- ---------------------------------------------------------------------------
create table prices.labs (
  slug                 text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  name                 text not null check (char_length(name) between 1 and 120),
  website_url          text check (website_url ~ '^https://'),
  country              text check (country ~ '^[A-Z]{2}$'),
  tier                 text not null check (tier in ('accredited', 'recognised', 'not_accepted', 'unknown')),
  accreditation_body   text check (char_length(accreditation_body) <= 120),
  accreditation_number text check (char_length(accreditation_number) <= 60),
  verify_how           text check (char_length(verify_how) <= 400),
  evidence_url         text check (evidence_url ~ '^https://'),
  evidence_quote       text check (char_length(evidence_quote) <= 600),
  checked_on           date not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
alter table prices.labs enable row level security;
create trigger labs_touch before update on prices.labs for each row execute function private.touch_updated_at();
comment on table prices.labs is 'Laboratories named on certificates, with their tier under the Standard §3 and how we know.';

-- ---------------------------------------------------------------------------
-- Audits (§9.1): append-only
-- ---------------------------------------------------------------------------
create table prices.store_audits (
  id               uuid primary key default gen_random_uuid(),
  vendor_id        uuid not null references prices.vendors (id),
  standard_version text not null check (standard_version ~ '^[0-9]+\.[0-9]+(\.[0-9]+)?$'),
  method           text not null default 'public_pages' check (method in ('public_pages')),
  audited_on       date not null,
  reachable        boolean not null default true,   -- false: the site could not be read; every check is 'unchecked'
  pages_read       text[] not null default '{}',    -- the store pages read, for staff; never rendered
  recorded_by      uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (vendor_id, standard_version, audited_on)
);
create index store_audits_latest on prices.store_audits (vendor_id, audited_on desc, created_at desc);

create table prices.store_audit_checks (
  id                uuid primary key default gen_random_uuid(),
  audit_id          uuid not null references prices.store_audits (id),
  criterion         text not null check (criterion in (
                      'identity_name', 'identity_country', 'identity_address', 'ships_to',
                      'coa_published', 'coa_lab_named', 'coa_lab_tier', 'coa_verifiable',
                      'coa_identity_ms', 'coa_endotoxin', 'coa_current',
                      'independent_results', 'no_human_use_claims', 'lot_notice_process')),
  result            text not null check (result in ('met', 'partly', 'not_met', 'not_found', 'unchecked')),
  value             text check (char_length(value) <= 300),
  source_url        text check (source_url ~ '^https://' and char_length(source_url) <= 600),
  quote             text check (char_length(quote) <= 600),
  quote_verified_on date,                            -- the quote checker found these words on that page that day
  unique (audit_id, criterion),
  check (quote is null or source_url is not null),
  check (quote_verified_on is null or quote is not null)
);

alter table prices.store_audits enable row level security;
alter table prices.store_audit_checks enable row level security;

create trigger store_audits_append_only before update or delete on prices.store_audits
  for each row execute function private.forbid_mutation();
create trigger store_audits_no_truncate before truncate on prices.store_audits
  for each statement execute function private.forbid_mutation();
create trigger store_audit_checks_append_only before update or delete on prices.store_audit_checks
  for each row execute function private.forbid_mutation();
create trigger store_audit_checks_no_truncate before truncate on prices.store_audit_checks
  for each statement execute function private.forbid_mutation();

comment on table prices.store_audits is
  'Public-information audits of a store under one version of the Standard (§9.1). Append-only; the latest is shown.';
comment on table prices.store_audit_checks is
  'One audit''s fourteen checks: result, and the page and exact words it rests on. Append-only.';

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
insert into public.app_config (key, value, is_public, description) values
  ('features.stores', 'false', true,
   'Show the Stores directory (every store, its public-information audit, and the laboratories). Off: only admins see it, as a preview.');

-- Is the directory visible to the caller? On for everyone, or a preview for admins.
create function private.stores_visible()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.cfg_bool('features.stores') or private.is_admin(auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- Read API
-- ---------------------------------------------------------------------------
-- The directory: every listed store with its latest audit's results, and the
-- labs. Null when not visible to the caller.
create function public.get_store_directory()
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
grant execute on function public.get_store_directory() to anon, authenticated;

-- One store and its latest audit, check by check. Null when not visible or not listed.
create function public.get_store(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v       prices.vendors;
  v_audit prices.store_audits;
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
        from prices.store_audit_checks c where c.audit_id = v_audit.id), '[]'::jsonb)) end);
end;
$$;
grant execute on function public.get_store(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Links: price_link also resolves a store's home page ('store', by slug), an
-- audit check's source ('evidence') and a lab's site ('lab'). Store visits are
-- counted per store per day, like price clicks.
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

  if p_kind in ('store', 'evidence', 'lab') then
    if not private.stores_visible() then
      return null;
    end if;
    if p_kind = 'evidence' then
      if p_id !~ v_uuid then
        return null;
      end if;
      select c.source_url into v_url
      from prices.store_audit_checks c
      join prices.store_audits a on a.id = c.audit_id
      join prices.vendors v on v.id = a.vendor_id and v.status <> 'delisted'
      where c.id = p_id::uuid;
      return case when v_url ~ '^https://' then v_url end;
    elsif p_kind = 'lab' then
      select l.website_url into v_url from prices.labs l where l.slug = p_id;
      return case when v_url ~ '^https://' then v_url end;
    end if;
    select v.id, v.website_url into v_vendor, v_url
    from prices.vendors v
    where v.slug = p_id and v.status <> 'delisted';
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
