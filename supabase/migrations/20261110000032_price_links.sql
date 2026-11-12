-- ============================================================================
-- 0032 · Price tracking: links to stores and click counts
--
--   * No store address is ever rendered in a page. A price row links to
--     /prices/go/<kind>/<id>; the web app asks price_link() where that goes
--     and redirects with no referrer (the same pattern as ads, ADR-0007).
--   * Plain links only (ADR-0009): Pepforums earns nothing from a store.
--     There are no affiliate addresses, referral tags or discount codes, so
--     nothing about a link can depend on a business relationship.
--   * Clicks are counted per vendor per day and nothing else: no member, no
--     visitor token, no address.
-- ============================================================================

create table prices.click_daily_stats (
  vendor_id uuid    not null references prices.vendors (id) on delete cascade,
  day       date    not null,
  clicks    integer not null default 0 check (clicks >= 0),
  primary key (vendor_id, day)
);
alter table prices.click_daily_stats enable row level security;

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
-- Clicks per store over the last 7 and 30 days (admins only).
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
