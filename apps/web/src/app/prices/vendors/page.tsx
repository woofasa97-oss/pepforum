import type { Metadata } from 'next';
import Link from 'next/link';

import { PriceNotes, PricesOff, VendorName } from '@/components/prices/PriceBits';
import { EmptyState } from '@/components/ui/Bits';
import { countryName } from '@/lib/countries';
import { formatDate } from '@/lib/format';
import { usdToCad } from '@/lib/prices/model';
import { getLocale, getT } from '@/server/context';
import { getPriceCatalog } from '@/server/queries';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('prices.vendors.title'), description: t('prices.vendors.sub'), alternates: { canonical: '/prices/vendors' } };
}

/** Every vendor whose prices are tracked, in alphabetical order: listing order carries no preference. */
export default async function PriceVendorsPage() {
  const [t, locale, catalog] = await Promise.all([getT(), getLocale(), getPriceCatalog()]);
  if (!catalog) return <PricesOff t={t} />;
  const counts = new Map<string, Set<string>>();
  for (const o of catalog.offers) counts.set(o.vendor, (counts.get(o.vendor) ?? new Set<string>()).add(o.compound));
  const vendors = [...catalog.vendors].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="small mb8"><Link className="link" href="/prices">{t('prices.title')}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('prices.vendors.title')}</h1>
            <p>{t('prices.vendors.sub')}</p>
          </div>
        </div>
        <section className="card card-p mb16">
          {vendors.length === 0 ? <EmptyState title={t('prices.empty')} /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col">{t('prices.col.vendor')}</th>
                    <th scope="col">{t('prices.vendor.basedIn')}</th>
                    <th scope="col" className="num">{t('prices.vendor.compounds')}</th>
                    <th scope="col">{t('prices.vendor.certificates')}</th>
                    <th scope="col">{t('prices.vendor.lastRead')}</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((v) => (
                    <tr key={v.slug}>
                      <td><VendorName vendor={v} t={t} /><span className="muted xs">{v.domain}</span></td>
                      <td>{v.origin_country ? countryName(v.origin_country, locale) : '—'}</td>
                      <td className="num">{counts.get(v.slug)?.size ?? 0}</td>
                      <td>{v.coas.length > 0 ? t('prices.vendor.coaCount', { n: v.coas.length }) : <span className="muted">{t('prices.coa.noneShort')}</span>}</td>
                      <td>{v.last_ingested_at ? formatDate(v.last_ingested_at, locale) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <PriceNotes rate={usdToCad(catalog.rates)} publishedAt={catalog.publication?.published_at ?? null} staleHours={catalog.stale_hours} locale={locale} t={t} />
      </main>
    </div>
  );
}
