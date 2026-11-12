import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CoaTable, GoLink, PriceNotes, PricesOff } from '@/components/prices/PriceBits';
import { formatDate, formatDay } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { formatCad, isCurrent, mgText, toCad, usdToCad } from '@/lib/prices/model';
import { getLocale, getNow, getT } from '@/server/context';
import { getPriceCatalog } from '@/server/queries';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ slug }, catalog, t] = await Promise.all([params, getPriceCatalog(), getT()]);
  const vendor = catalog?.vendors.find((v) => v.slug === slug);
  if (!vendor) return {};
  return { title: t('prices.vendor.metaTitle', { name: vendor.name }), alternates: { canonical: `/prices/vendor/${vendor.slug}` } };
}

/** One vendor: what we know about it and why, its certificates, and its current single-vial prices. */
export default async function PriceVendorPage({ params }: Props) {
  const [{ slug }, t, locale, catalog] = await Promise.all([params, getT(), getLocale(), getPriceCatalog()]);
  if (!catalog) return <PricesOff t={t} />;
  const vendor = catalog.vendors.find((v) => v.slug === slug);
  if (!vendor) notFound();

  const now = await getNow();
  const rate = usdToCad(catalog.rates);
  const names = new Map(catalog.compounds.map((c) => [c.slug, c.name]));
  // The cheapest current single vial of each compound and strength.
  const best = new Map<string, { compound: string; mg: number | null; cad: number; id: string; blend: boolean }>();
  for (const o of catalog.offers) {
    if (o.vendor !== slug || o.vials_per_pack !== 1 || !isCurrent(o, catalog.stale_hours, now)) continue;
    const cad = toCad(o.price_minor, o.currency, rate);
    if (cad === null) continue;
    const key = `${o.compound}|${o.is_blend ? (o.recipe_key ?? 'unstated') : o.mg_per_vial}`;
    if (cad < (best.get(key)?.cad ?? Infinity)) best.set(key, { compound: o.compound, mg: o.mg_per_vial === null ? null : Number(o.mg_per_vial), cad, id: o.id, blend: o.is_blend });
  }
  const rows = [...best.values()].sort((a, b) => (names.get(a.compound) ?? a.compound).localeCompare(names.get(b.compound) ?? b.compound) || (a.mg ?? 0) - (b.mg ?? 0));

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="small mb8"><Link className="link" href="/prices/vendors">{t('prices.vendors.title')}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{vendor.name}</h1>
            <p>{vendor.domain}</p>
          </div>
          <div className="row wrap">
            <GoLink kind="vendor" id={vendor.slug} className="btn sm dark" label={t('prices.visitLabel', { vendor: vendor.name })}>{t('prices.visit')}</GoLink>
          </div>
        </div>

        <section className="card card-p mb16" aria-labelledby="facts-h">
          <h2 id="facts-h" className="mb12" style={{ fontSize: 16 }}>{t('prices.vendor.about')}</h2>
          <dl className="facts">
            <div><dt>{t('prices.vendor.basedIn')}</dt><dd>{t(`prices.country.${vendor.origin_country}` as MessageKey)}</dd></div>
            <div><dt>{t('prices.vendor.shipsTo')}</dt><dd>{vendor.ships_to.length ? vendor.ships_to.map((c) => t(`prices.country.${c}` as MessageKey)).join(', ') : t('prices.vendor.shipsUnknown')}</dd></div>
            <div><dt>{t('prices.vendor.currency')}</dt><dd>{vendor.native_currency ?? '—'}</dd></div>
            <div><dt>{t('prices.vendor.lastRead')}</dt><dd>{vendor.last_ingested_at ? formatDate(vendor.last_ingested_at, locale) : '—'}</dd></div>
            {vendor.quantity_tiers.length ? (
              <div>
                <dt>{t('prices.vendor.discounts')}</dt>
                <dd>{vendor.quantity_tiers.map((tier) => t('prices.tier', { percent: tier.percent, n: tier.vials })).join(' · ')}
                  <span className="muted xs"> {t('prices.coa.checked', { date: formatDay(vendor.quantity_tiers[0]?.checked ?? '', locale) })}</span></dd>
              </div>
            ) : null}
          </dl>
        </section>

        <section className="card card-p mb16" aria-labelledby="coa-h">
          <h2 id="coa-h" className="mb8" style={{ fontSize: 16 }}>{t('prices.coa.title')}</h2>
          <CoaTable coas={vendor.coas} compounds={catalog.compounds} locale={locale} t={t} />
        </section>

        <section className="card card-p mb16" aria-labelledby="prices-h">
          <h2 id="prices-h" className="mb8" style={{ fontSize: 16 }}>{t('prices.vendor.prices')}</h2>
          {rows.length === 0 ? <p className="small muted">{t('prices.vendor.noCurrent')}</p> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t('prices.col.compound')}</th>
                    <th scope="col" className="num">{t('prices.col.size')}</th>
                    <th scope="col" className="num">{t('prices.col.vialPrice')}</th>
                    <th scope="col" className="num">{t('prices.col.perMg')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><Link className="link" href={`/prices/${r.compound}`}>{names.get(r.compound) ?? r.compound}</Link></td>
                      <td className="num">{r.mg === null ? '—' : `${mgText(r.mg)} mg`}</td>
                      <td className="num">{formatCad(r.cad, locale)}</td>
                      <td className="num">{r.blend || !r.mg ? '—' : formatCad(r.cad / r.mg, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <PriceNotes rate={rate} publishedAt={catalog.publication?.published_at ?? null} staleHours={catalog.stale_hours} locale={locale} t={t} />
      </main>
    </div>
  );
}
