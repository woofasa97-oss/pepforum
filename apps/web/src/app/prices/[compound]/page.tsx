import type { PriceCatalog } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CoaTable, GoLink, HistoryChart, PriceNotes, PricesOff, VendorName, purityText } from '@/components/prices/PriceBits';
import { JsonLd } from '@/components/site/JsonLd';
import { EmptyState } from '@/components/ui/Bits';
import { formatDay, relativeTime } from '@/lib/format';
import type { Translate } from '@/lib/i18n';
import {
  QUANTITIES, type Quote, type Variant, compare, formatCad, formatNative, mgText, mixLabel, startingVariant, usdToCad, variantsOf,
} from '@/lib/prices/model';
import { absoluteUrl } from '@/lib/seo';
import { getLocale, getNow, getT } from '@/server/context';
import { getPriceCatalog, getPriceHistory } from '@/server/queries';

interface Props {
  params: Promise<{ compound: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ compound: slug }, catalog, t] = await Promise.all([params, getPriceCatalog(), getT()]);
  const compound = catalog?.compounds.find((c) => c.slug === slug);
  if (!compound) return {};
  return {
    title: t('prices.compare.metaTitle', { name: compound.name }),
    description: t('prices.compare.metaDescription', { name: compound.name }),
    alternates: { canonical: `/prices/${compound.slug}` },
  };
}

function variantLabel(v: Variant, names: ReadonlyMap<string, string>, t: Translate): string {
  if (v.kind === 'size') return `${mgText(v.mg ?? 0)} mg`;
  if (v.kind === 'mix') return mixLabel(v.mix ?? '', names);
  return t('prices.mixUnstated');
}

function stockPill(q: Quote, t: Translate) {
  if (q.offer.availability === 'in_stock') return q.stale ? <span className="pill amber xs">{t('prices.stale')}</span> : <span className="pill green xs">{t('prices.inStock')}</span>;
  if (q.offer.availability === 'out_of_stock' || q.offer.availability === 'discontinued') return <span className="pill xs">{t('prices.outOfStock')}</span>;
  if (q.offer.availability === 'backorder' || q.offer.availability === 'preorder') return <span className="pill xs">{t('prices.backorder')}</span>;
  return <span className="pill xs">{t('prices.stockUnknown')}</span>;
}

/** One compound: every vendor that can fill the chosen order, cheapest current price first. */
export default async function ComparePage({ params, searchParams }: Props) {
  const [{ compound: slug }, query, t, locale, catalog] = await Promise.all([params, searchParams, getT(), getLocale(), getPriceCatalog()]);
  if (!catalog) return <PricesOff t={t} />;
  const compound = SLUG.test(slug) ? catalog.compounds.find((c) => c.slug === slug) : undefined;
  const offers = catalog.offers.filter((o) => o.compound === slug);
  if (!compound || offers.length === 0) notFound();

  const now = await getNow();
  const rate = usdToCad(catalog.rates);
  const names = new Map(catalog.compounds.map((c) => [c.slug, c.name]));
  const variants = variantsOf(offers, catalog.stale_hours, now);
  const variant = variants.find((v) => v.key === first(query.v)) ?? startingVariant(variants);
  if (!variant) notFound();
  const wanted = Number(first(query.q));
  const lead = (QUANTITIES as readonly number[]).includes(catalog.lead_vials) ? catalog.lead_vials : 10;
  const quantity = (QUANTITIES as readonly number[]).includes(wanted) ? wanted : lead;
  const table = compare(catalog, slug, variant, quantity, now);
  const blend = variant.kind !== 'size';
  const history = blend ? [] : await getPriceHistory(slug);
  const href = (v: string, q: number) => `/prices/${slug}?v=${encodeURIComponent(v)}&q=${q}`;
  const coas = catalog.vendors.flatMap((vendor) => vendor.coas.filter((c) => c.compound === slug).map((c) => ({ vendor, coa: c })));

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="small mb8"><Link className="link" href="/prices">{t('prices.title')}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('prices.compare.title', { name: compound.name })}</h1>
            <p>{t(blend ? 'prices.compare.subBlend' : 'prices.compare.sub')}</p>
          </div>
        </div>

        <nav className="row wrap mb8" style={{ gap: 6 }} aria-label={t(blend ? 'prices.pick.mix' : 'prices.pick.size')}>
          {variants.map((v) => (
            <Link key={v.key} className="chip sm" href={href(v.key, quantity)} aria-current={v.key === variant.key ? 'page' : undefined}>
              {variantLabel(v, names, t)}
            </Link>
          ))}
        </nav>
        <nav className="row wrap mb16" style={{ gap: 6 }} aria-label={t('prices.pick.quantity')}>
          {QUANTITIES.map((q) => (
            <Link key={q} className="chip sm" href={href(variant.key, q)} aria-current={q === quantity ? 'page' : undefined}>
              {t(q === 1 ? 'prices.vial' : 'prices.vials', { n: q })}
            </Link>
          ))}
        </nav>

        <section className="card card-p mb16" aria-labelledby="offers-h">
          <h2 id="offers-h" className="mb8" style={{ fontSize: 16 }}>
            {t('prices.compare.tableTitle', { n: quantity, what: variantLabel(variant, names, t) })}
          </h2>
          {variant.kind === 'unstated' ? <p className="small muted mb12">{t('prices.unstatedHelp')}</p> : null}
          {table.quotes.length === 0 ? <EmptyState title={t('prices.compare.none')} /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t('prices.col.vendor')}</th>
                    <th scope="col" className="num">{t(blend ? 'prices.col.perVial' : 'prices.col.perMg')}</th>
                    <th scope="col" className="num">{t('prices.col.total', { n: quantity })}</th>
                    <th scope="col">{t('prices.col.status')}</th>
                    <th scope="col">{t('prices.col.purity')}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {table.quotes.map((q) => {
                    const coa = q.vendor.coas.find((c) => c.compound === slug);
                    return (
                      <tr key={q.vendor.slug}>
                        <td>
                          <VendorName vendor={q.vendor} t={t} />
                          <span className="muted xs">{q.offer.product_name}{q.offer.variant_label ? ` · ${q.offer.variant_label}` : ''}</span>
                          {q.kit ? <span className="muted xs">{t('prices.kit', { n: quantity })}</span> : null}
                          {q.tier ? <span className="muted xs">{t('prices.tier', { percent: q.tier.percent, n: q.tier.vials })}</span> : null}
                          {q.vendor.code ? <span className="muted xs">{t('prices.code', { code: q.vendor.code.code })}{q.vendor.code.terms ? ` (${q.vendor.code.terms})` : ''}</span> : null}
                        </td>
                        <td className="num">
                          <b>{formatCad(q.perMgCad ?? q.perVialCad, locale)}</b>
                          {table.lowest.has(q.vendor.slug) ? <span className="pill green xs">{t('prices.lowest')}</span> : null}
                        </td>
                        <td className="num">
                          {formatCad(q.totalCad, locale)}
                          {q.currency !== 'CAD' ? <span className="muted xs">{formatNative(q.totalMinor, q.currency, locale)}</span> : null}
                        </td>
                        <td>
                          {stockPill(q, t)}
                          <span className="muted xs">{t('prices.checkedAgo', { when: relativeTime(q.offer.observed_at, t, new Date(now)) })}</span>
                        </td>
                        <td>
                          {coa ? (
                            <>
                              <GoLink kind="coa" id={coa.id}>{purityText(coa.stated_purity_pct, locale)}</GoLink>
                              <span className="muted xs">{coa.lab}{coa.test_date ? ` · ${formatDay(coa.test_date, locale)}` : ''}</span>
                            </>
                          ) : <span className="muted xs">{t('prices.coa.noneShort')}</span>}
                        </td>
                        <td><GoLink kind="offer" id={q.offer.id} className="btn sm" label={t('prices.visitLabel', { vendor: q.vendor.name })}>{t('prices.visit')}</GoLink></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="xs faint mt12">{t('prices.compare.rankNote')}</p>
        </section>

        {blend ? null : (
          <section className="card card-p mb16" aria-labelledby="history-h">
            <h2 id="history-h" className="mb8" style={{ fontSize: 16 }}>{t('prices.history.title')}</h2>
            <HistoryChart points={history} rate={rate} locale={locale} t={t} />
          </section>
        )}

        <section className="card card-p mb16" aria-labelledby="coa-h">
          <h2 id="coa-h" className="mb8" style={{ fontSize: 16 }}>{t('prices.coa.title')}</h2>
          {coas.length === 0 ? <p className="small muted">{t('prices.coa.noneForCompound')}</p> : (
            coas.map(({ vendor, coa }) => (
              <div key={coa.id} className="mb12">
                <p className="small mb8"><VendorName vendor={vendor} t={t} /></p>
                <CoaTable coas={[coa]} compounds={catalog.compounds} locale={locale} t={t} showCompound={false} />
              </div>
            ))
          )}
        </section>

        <PriceNotes rate={rate} publishedAt={catalog.publication?.published_at ?? null} staleHours={catalog.stale_hours} locale={locale} t={t} />
        <JsonLd data={offerListJsonLd(catalog, compound.name, slug, table.quotes)} />
      </main>
    </div>
  );
}

/** schema.org ItemList of Offers: prices and availability only, never a rating or a review. */
function offerListJsonLd(catalog: PriceCatalog, name: string, slug: string, quotes: readonly Quote[]): Record<string, unknown> {
  return {
    '@type': 'ItemList',
    name,
    url: absoluteUrl(`/prices/${slug}`),
    ...(catalog.publication ? { dateModified: catalog.publication.published_at } : {}),
    itemListElement: quotes.filter((q) => q.current).map((q, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Offer',
        name: q.offer.product_name,
        price: (q.totalMinor / 100).toFixed(2),
        priceCurrency: q.currency,
        availability: 'https://schema.org/InStock',
        seller: { '@type': 'Organization', name: q.vendor.name },
        url: absoluteUrl(`/prices/vendor/${q.vendor.slug}`),
      },
    })),
  };
}
