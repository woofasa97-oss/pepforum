-- ============================================================================
-- 0033 · Price tracking: what the site reads
--
-- Two anonymous-safe projections over the `prices` schema (…030). They are the
-- only way an API role can see price data, and they show only:
--   * published offers (rows a passing run produced and publish_offers copied);
--   * of vendors whose status is 'active' and compounds that are active;
--   * never a store or document URL — links go through price_link (…032), so
--     no vendor address is rendered raw, as with ads (ADR-0007);
--   * published certificates of analysis (…031), labelled as the vendor's claim.
-- Both return null while `features.prices` is off.
--
-- Prices stay in the vendor's own currency as integer minor units; the web app
-- converts for display with the dated rate it is given here and names it.
-- ============================================================================

create function public.get_price_catalog()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.cfg_bool('features.prices') then
    return null;
  end if;

  return jsonb_build_object(
    'stale_hours', private.cfg_int('prices.stale_hours'),
    'lead_vials',  private.cfg_int('prices.lead_vials'),
    'publication', (
      select jsonb_build_object('published_at', p.published_at, 'run_finished_at', r.finished_at)
      from prices.publications p
      join prices.refresh_runs r on r.id = p.run_id
      order by p.published_at desc
      limit 1),
    'rates', coalesce((
      select jsonb_agg(jsonb_build_object('base', f.base_currency, 'quote', f.quote_currency, 'rate', f.rate,
                                          'provider', f.provider, 'rate_date', f.rate_date))
      from (select distinct on (x.base_currency, x.quote_currency) x.*
            from prices.fx_rates x
            order by x.base_currency, x.quote_currency, x.rate_date desc) f), '[]'::jsonb),
    'compounds', coalesce((
      select jsonb_agg(jsonb_build_object('slug', c.slug, 'name', c.name, 'type', c.type, 'aliases', c.aliases,
                                          'formulation', c.formulation, 'blend_components', c.blend_components)
                       order by c.name)
      from prices.compounds c
      where c.is_active), '[]'::jsonb),
    'vendors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', v.slug, 'name', v.name, 'domain', v.canonical_domain, 'origin_country', v.origin_country,
               'ships_to', v.ships_to, 'native_currency', v.native_currency, 'coa_scope', v.coa_scope,
               'last_ingested_at', v.last_ingested_at,
               'coas', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', d.id, 'compound', dc.slug, 'scope', d.scope, 'batch', d.batch, 'lab', d.lab,
                          'lab_accreditation', d.lab_accreditation, 'method', d.method, 'test_date', d.test_date,
                          'stated_purity_pct', d.stated_purity_pct, 'checked', (d.checked_at at time zone 'UTC')::date)
                        order by d.test_date desc nulls last, d.checked_at desc)
                 from prices.coa_documents d
                 left join prices.compounds dc on dc.id = d.compound_id
                 where d.vendor_id = v.id and d.status = 'published'), '[]'::jsonb),
               'quantity_tiers', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'vials', t.threshold, 'percent', t.discount_pct, 'blends', t.applies_to_blends,
                          'any_product', t.mix_and_match, 'checked', (t.observed_at at time zone 'UTC')::date)
                        order by t.threshold)
                 from prices.quantity_tiers t
                 where t.vendor_id = v.id and t.compound_id is null and t.basis = 'vials' and t.scope = 'all_units'
                   and t.discount_pct is not null and t.status = 'verified'
                   and (t.valid_from is null or t.valid_from <= current_date)
                   and (t.valid_to is null or t.valid_to >= current_date)), '[]'::jsonb))
             order by v.name)
      from prices.vendors v
      where v.status = 'active'
        and exists (select 1 from prices.published_offers p where p.vendor_id = v.id)), '[]'::jsonb),
    'offers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.offer_id, 'vendor', v.slug, 'compound', c.slug, 'product_name', p.product_name,
               'variant_label', p.variant_label, 'currency', p.native_currency, 'price_minor', p.price_minor,
               'list_price_minor', p.list_price_minor, 'on_sale', p.on_sale, 'price_kind', p.price_kind,
               'mg_per_vial', p.mg_per_vial, 'vials_per_pack', p.vials_per_pack, 'total_mg', p.total_mg,
               'per_mg_minor_e4', p.per_mg_minor_e4, 'availability', p.availability, 'observed_at', p.observed_at,
               'price_changed_at', p.price_changed_at, 'recipe_key', p.recipe_key, 'is_blend', p.is_blend))
      from prices.published_offers p
      join prices.vendors v on v.id = p.vendor_id and v.status = 'active'
      join prices.compounds c on c.id = p.compound_id and c.is_active), '[]'::jsonb));
end;
$$;
grant execute on function public.get_price_catalog() to anon, authenticated;

-- Each active vendor's lowest in-stock price per mg for one compound, per day,
-- from the append-only price log. Only rows of runs that passed the gate and
-- were not dry runs count, so a held run never shows up in a chart.
create function public.get_price_history(p_compound text, p_days integer default 90)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days integer := least(greatest(coalesce(p_days, 90), 7), 365);
begin
  if not private.cfg_bool('features.prices') then
    return null;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('day', d.day, 'vendor', d.vendor, 'currency', d.currency, 'per_mg_minor_e4', d.per_mg)
                     order by d.day, d.vendor)
    from (
      select (o.observed_at at time zone 'UTC')::date as day, v.slug as vendor, o.native_currency as currency,
             min(o.per_mg_minor_e4) as per_mg
      from prices.offer_observations o
      join prices.compounds c on c.id = o.compound_id and c.is_active
      join prices.vendors v on v.id = o.vendor_id and v.status = 'active'
      join prices.refresh_runs r on r.id = o.run_id
      where c.slug = p_compound
        and o.comparable and o.per_mg_minor_e4 is not null and o.availability = 'in_stock'
        and r.status = 'committed' and r.verdict = 'pass' and not r.dry_run
        and o.observed_at >= now() - make_interval(days => v_days)
      group by 1, 2, 3) d), '[]'::jsonb);
end;
$$;
grant execute on function public.get_price_history(text, integer) to anon, authenticated;
