import type { Metadata } from 'next';
import Link from 'next/link';

import { PriceNotes, PricesOff } from '@/components/prices/PriceBits';
import { JsonLd } from '@/components/site/JsonLd';
import { EmptyState } from '@/components/ui/Bits';
import { formatCad, indexRows, usdToCad } from '@/lib/prices/model';
import { absoluteUrl } from '@/lib/seo';
import { getLocale, getNow, getT } from '@/server/context';
import { getPriceCatalog } from '@/server/queries';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('prices.title'), description: t('prices.sub'), alternates: { canonical: '/prices' } };
}

/** Every compound with a published price: how many Canadian vendors list it and the lowest current price. */
export default async function PricesPage() {
  const [t, locale, catalog] = await Promise.all([getT(), getLocale(), getPriceCatalog()]);
  if (!catalog) return <PricesOff t={t} />;
  const rows = indexRows(catalog, await getNow());
  const singles = rows.filter((r) => r.compound.type !== 'Blend');
  const blends = rows.filter((r) => r.compound.type === 'Blend');

  const table = (list: typeof rows, caption: string) => (
    <section className="card card-p mb16" aria-label={caption}>
      <h2 className="mb12" style={{ fontSize: 16 }}>{caption}</h2>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">{t('prices.col.compound')}</th>
              <th scope="col" className="num">{t('prices.col.vendors')}</th>
              <th scope="col" className="num">{t('prices.col.from')}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.compound.slug}>
                <td><Link className="link" href={`/prices/${r.compound.slug}`}><b>{r.compound.name}</b></Link></td>
                <td className="num">{r.vendors}</td>
                <td className="num">
                  {r.fromCad === null ? <span className="muted">{t('prices.noCurrent')}</span>
                    : <>{formatCad(r.fromCad, locale)} <span className="muted xs">{t(r.unit === 'mg' ? 'prices.perMg' : 'prices.perVial')}</span></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('prices.title')}</h1>
            <p>{t('prices.sub')}</p>
          </div>
          <Link className="btn sm" href="/prices/vendors">{t('prices.vendors.title')}</Link>
        </div>
        {rows.length === 0 ? <div className="card mb16"><EmptyState title={t('prices.empty')} /></div> : (
          <>
            {singles.length ? table(singles, t('prices.singles')) : null}
            {blends.length ? table(blends, t('prices.blends')) : null}
          </>
        )}
        <PriceNotes rate={usdToCad(catalog.rates)} publishedAt={catalog.publication?.published_at ?? null} staleHours={catalog.stale_hours} locale={locale} t={t} />
        <JsonLd data={{
          '@type': 'ItemList',
          name: t('prices.title'),
          url: absoluteUrl('/prices'),
          itemListElement: rows.map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: r.compound.name, url: absoluteUrl(`/prices/${r.compound.slug}`) })),
        }} />
      </main>
    </div>
  );
}
