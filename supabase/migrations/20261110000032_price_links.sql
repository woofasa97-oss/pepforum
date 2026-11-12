-- ============================================================================
-- 0032 · Price tracking: links to stores, affiliate terms, click counts
--
--   * No store address is ever rendered in a page. A price row links to
--     /prices/go/<kind>/<id>; the web app asks price_link() where that goes
--     and redirects with no referrer (the same pattern as ads, ADR-0007).
--   * Where a vendor has agreed affiliate terms with Pepforum, an admin
--     records them with their evidence. price_link() then sends visitors
--     through the affiliate address, the read API marks the vendor
--     `is_affiliate`, and the site labels every such link and lists the
--     vendor on its disclosure page. An affiliate relationship never changes
--     a price, a ranking or a "lowest" tag: nothing in the read API orders by it.
--   * Clicks are counted per vendor per day and nothing else: no member, no
--     visitor token, no address.
-- ============================================================================

create table prices.vendor_links (
  vendor_id     uuid primary key references prices.vendors (id) on delete cascade,
  -- Where a click on the vendor itself goes (their affiliate landing address).
  affiliate_url text check (affiliate_url is null or (affiliate_url ~ '^https://\S+$' and char_length(affiliate_url) <= 1000)),
  -- Appended to product addresses as a query string, e.g. "ref=pepforum".
  product_param text check (product_param is null
                            or product_param ~ '^[A-Za-z0-9_.~-]+=[A-Za-z0-9_.~-]+(&[A-Za-z0-9_.~-]+=[A-Za-z0-9_.~-]+)*$'),
  -- A discount code the vendor confirmed, shown beside its prices. Never applied to a price.
  code          text check (code is null or code ~ '^[A-Za-z0-9_-]{2,40}$'),
  code_terms    text check (code_terms is null or char_length(code_terms) <= 200),
  -- How we know: the agreement, email or page that confirms the terms.
  evidence      text        not null check (char_length(evidence) between 3 and 500),
  confirmed_at  date        not null default current_date,
  expires_at    date,
  created_by    uuid references public.profiles (id) on delete set null,
  updated_at    timestamptz not null default now(),
  check (affiliate_url is not null or product_param is not null or code is not null)
);
create trigger vendor_links_touch before update on prices.vendor_links
  for each row execute function private.touch_updated_at();
alter table prices.vendor_links enable row level security;

create table prices.click_daily_stats (
  vendor_id uuid    not null references prices.vendors (id) on delete cascade,
  day       date    not null,
  clicks    integer not null default 0 check (clicks >= 0),
  primary key (vendor_id, day)
);
alter table prices.click_daily_stats enable row level security;

-- True while a vendor's recorded affiliate terms are in force.
create function private.price_is_affiliate(p_vendor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from prices.vendor_links l
    where l.vendor_id = p_vendor and (l.expires_at is null or l.expires_at >= current_date)
      and (l.affiliate_url is not null or l.product_param is not null));
$$;

-- Where a link on a price page goes, or null. p_kind: 'offer' (a published
-- offer's id), 'vendor' (a slug) or 'coa' (a published certificate's id).
-- Counts a click for offers and vendors.
create function public.price_link(p_kind text, p_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendor uuid;
  v_url    text;
  v_link   prices.vendor_links%rowtype;
begin
  if not private.cfg_bool('features.prices') or p_id is null then
    return null;
  end if;

  if p_kind = 'coa' then
    if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return null;
    end if;
    select d.url into v_url
    from prices.coa_documents d
    join prices.vendors v on v.id = d.vendor_id and v.status = 'active'
    where d.id = p_id::uuid and d.status = 'published';
    return case when v_url ~ '^https://' then v_url end;
  elsif p_kind = 'offer' then
    if p_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
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

  if v_vendor is null or v_url is null or v_url !~ '^https://' then
    return null;
  end if;

  select * into v_link from prices.vendor_links l
  where l.vendor_id = v_vendor and (l.expires_at is null or l.expires_at >= current_date);
  if v_link.vendor_id is not null then
    if p_kind = 'vendor' and v_link.affiliate_url is not null then
      v_url := v_link.affiliate_url;
    elsif v_link.product_param is not null then
      v_url := regexp_replace(v_url, '#.*$', '');
      v_url := v_url || case when position('?' in v_url) > 0 then '&' else '?' end || v_link.product_param;
    end if;
  end if;

  insert into prices.click_daily_stats (vendor_id, day, clicks)
  values (v_vendor, (now() at time zone 'UTC')::date, 1)
  on conflict (vendor_id, day) do update set clicks = prices.click_daily_stats.clicks + 1;

  return v_url;
end;
$$;
grant execute on function public.price_link(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
create function public.admin_price_links()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
begin
  perform private.require_admin(v_uid);
  return jsonb_build_object(
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
               'vendor', v.slug, 'vendor_name', v.name, 'affiliate_url', l.affiliate_url, 'product_param', l.product_param,
               'code', l.code, 'code_terms', l.code_terms, 'evidence', l.evidence, 'confirmed_at', l.confirmed_at,
               'expires_at', l.expires_at, 'active', (l.expires_at is null or l.expires_at >= current_date))
             order by v.name)
      from prices.vendor_links l join prices.vendors v on v.id = l.vendor_id), '[]'::jsonb),
    'clicks', coalesce((
      select jsonb_agg(jsonb_build_object('vendor', x.slug, 'vendor_name', x.name, 'clicks_7d', x.c7, 'clicks_30d', x.c30)
                       order by x.c30 desc, x.name)
      from (select v.slug, v.name,
                   coalesce(sum(s.clicks) filter (where s.day >= current_date - 6), 0) as c7,
                   coalesce(sum(s.clicks), 0) as c30
            from prices.vendors v
            join prices.click_daily_stats s on s.vendor_id = v.id and s.day >= current_date - 29
            group by v.slug, v.name) x), '[]'::jsonb));
end;
$$;
grant execute on function public.admin_price_links() to authenticated;

create function public.admin_price_link_save(
  p_vendor text, p_affiliate_url text, p_product_param text, p_code text, p_code_terms text,
  p_evidence text, p_expires_at date, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_admin_write(p_reason);
  v_vendor uuid;
  v_url    text := nullif(btrim(coalesce(p_affiliate_url, '')), '');
  v_param  text := nullif(ltrim(btrim(coalesce(p_product_param, '')), '?&'), '');
  v_code   text := nullif(btrim(coalesce(p_code, '')), '');
  v_terms  text := nullif(btrim(coalesce(p_code_terms, '')), '');
  v_proof  text := btrim(coalesce(p_evidence, ''));
begin
  select v.id into v_vendor from prices.vendors v where v.slug = p_vendor;
  if v_vendor is null then
    perform private.raise_error('PF404', 'vendor_not_found');
  end if;
  if v_url is not null and (v_url !~ '^https://\S+$' or char_length(v_url) > 1000) then
    perform private.raise_error('PF422', 'invalid_url');
  end if;
  if v_param is not null and v_param !~ '^[A-Za-z0-9_.~-]+=[A-Za-z0-9_.~-]+(&[A-Za-z0-9_.~-]+=[A-Za-z0-9_.~-]+)*$' then
    perform private.raise_error('PF422', 'invalid_link_param');
  end if;
  if v_code is not null and v_code !~ '^[A-Za-z0-9_-]{2,40}$' then
    perform private.raise_error('PF422', 'invalid_link_code');
  end if;
  if v_terms is not null and char_length(v_terms) > 200 then
    perform private.raise_error('PF422', 'invalid_link_code');
  end if;
  if v_url is null and v_param is null and v_code is null then
    perform private.raise_error('PF422', 'link_empty');
  end if;
  if char_length(v_proof) not between 3 and 500 then
    perform private.raise_error('PF422', 'link_evidence_required');
  end if;

  insert into prices.vendor_links (vendor_id, affiliate_url, product_param, code, code_terms, evidence, expires_at, created_by)
  values (v_vendor, v_url, v_param, v_code, v_terms, v_proof, p_expires_at, v_uid)
  on conflict (vendor_id) do update set
    affiliate_url = excluded.affiliate_url, product_param = excluded.product_param, code = excluded.code,
    code_terms = excluded.code_terms, evidence = excluded.evidence, expires_at = excluded.expires_at,
    confirmed_at = current_date, created_by = excluded.created_by;

  perform private.log_mod_action(v_uid, 'price_link_saved', 'price_vendor', v_vendor, null, null, btrim(p_reason),
                                 jsonb_build_object('vendor', p_vendor, 'affiliate', v_url is not null or v_param is not null,
                                                    'code', v_code is not null));
end;
$$;
grant execute on function public.admin_price_link_save(text, text, text, text, text, text, date, text) to authenticated;

create function public.admin_price_link_remove(p_vendor text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := private.require_admin_write(p_reason);
  v_vendor uuid;
begin
  delete from prices.vendor_links l using prices.vendors v
  where v.id = l.vendor_id and v.slug = p_vendor
  returning l.vendor_id into v_vendor;
  if v_vendor is null then
    perform private.raise_error('PF404', 'link_not_found');
  end if;
  perform private.log_mod_action(v_uid, 'price_link_removed', 'price_vendor', v_vendor, null, null, btrim(p_reason),
                                 jsonb_build_object('vendor', p_vendor));
end;
$$;
grant execute on function public.admin_price_link_remove(text, text) to authenticated;
