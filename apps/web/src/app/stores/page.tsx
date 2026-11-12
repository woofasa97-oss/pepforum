import { STORE_AUDIT_CRITERIA } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { HowWeAudit, PreviewBanner, ResultPill, StoresOff } from '@/components/stores/StoreBits';
import { EmptyState } from '@/components/ui/Bits';
import { countryName } from '@/lib/countries';
import { formatDay } from '@/lib/format';
import { STORES_PER_PAGE, filterStores, parseStoreFilters, resultCounts, storeFiltersQuery } from '@/lib/stores';
import { getLocale, getT } from '@/server/context';
import { getStoreDirectory } from '@/server/queries';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('stores.title'), description: t('stores.sub'), alternates: { canonical: '/stores' } };
}

/** Every listed store, worldwide, with what its latest audit found. Alphabetical: the order carries no preference. */
export default async function StoresPage({ searchParams }: Props) {
  const [t, locale, directory, params] = await Promise.all([getT(), getLocale(), getStoreDirectory(), searchParams]);
  if (!directory) return <StoresOff t={t} />;

  const f = parseStoreFilters(params);
  const all = directory.stores;
  const matching = filterStores(all, f);
  const pages = Math.max(1, Math.ceil(matching.length / STORES_PER_PAGE));
  const page = Math.min(f.page, pages);
  const shown = matching.slice((page - 1) * STORES_PER_PAGE, page * STORES_PER_PAGE);

  const byName = (codes: Iterable<string>) => [...new Set(codes)].map((id) => ({ id, name: countryName(id, locale) })).sort((a, b) => a.name.localeCompare(b.name, locale));
  const basedIn = byName(all.flatMap((s) => (s.country ? [s.country] : [])));
  const shipsTo = byName(all.flatMap((s) => s.ships_to));
  const audited = all.filter((s) => s.audit?.reachable).length;
  const version = all.map((s) => s.audit?.standard_version).find(Boolean) ?? '0.9';
  const filtered = storeFiltersQuery(f) !== '';

  return (
    <div className="page">
      <main id="main" className="stores-main">
        {directory.preview ? <PreviewBanner t={t} /> : null}
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('stores.title')}</h1>
            <p>{t('stores.sub')}</p>
          </div>
        </div>

        <div className="stats mb16">
          <div className="stat"><div className="v">{all.length}</div><div className="l">{t('stores.stat.stores')}</div></div>
          <div className="stat"><div className="v">{basedIn.length}</div><div className="l">{t('stores.stat.countries')}</div></div>
          <div className="stat"><div className="v">{audited}</div><div className="l">{t('stores.stat.audited')}</div></div>
          <div className="stat"><div className="v">{directory.labs.length}</div><div className="l"><Link className="link" href="/stores/labs">{t('stores.stat.labs')}</Link></div></div>
        </div>

        <form className="card card-p mb16 store-filters" method="get" action="/stores" role="search" aria-label={t('stores.filter.label')}>
          <div className="field sf-q">
            <label htmlFor="sf-q">{t('stores.filter.q')}</label>
            <input id="sf-q" className="input" type="search" name="q" defaultValue={f.q} maxLength={80} />
          </div>
          <div className="field">
            <label htmlFor="sf-country">{t('stores.filter.country')}</label>
            <select id="sf-country" className="input" name="country" defaultValue={f.country ?? ''}>
              <option value="">{t('stores.filter.any')}</option>
              {basedIn.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sf-ships">{t('stores.filter.shipsTo')}</label>
            <select id="sf-ships" className="input" name="ships" defaultValue={f.shipsTo ?? ''}>
              <option value="">{t('stores.filter.any')}</option>
              {shipsTo.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="sf-kind">{t('stores.filter.kind')}</label>
            <select id="sf-kind" className="input" name="kind" defaultValue={f.kind ?? ''}>
              <option value="">{t('stores.filter.any')}</option>
              <option value="store">{t('stores.kind.store')}</option>
              <option value="manufacturer">{t('stores.kind.manufacturer')}</option>
            </select>
          </div>
          <fieldset className="sf-checks">
            <legend className="sr-only">{t('stores.filter.evidence')}</legend>
            <label className="check"><input type="checkbox" name="coa" value="1" defaultChecked={f.certificates} /> {t('stores.filter.certificates')}</label>
            <label className="check"><input type="checkbox" name="verify" value="1" defaultChecked={f.verifiable} /> {t('stores.filter.verifiable')}</label>
            <label className="check"><input type="checkbox" name="claims" value="1" defaultChecked={f.noClaims} /> {t('stores.filter.noClaims')}</label>
          </fieldset>
          <div className="row wrap sf-act">
            <button className="btn dark sm" type="submit">{t('stores.filter.apply')}</button>
            {filtered ? <Link className="btn ghost sm" href="/stores">{t('stores.filter.clear')}</Link> : null}
          </div>
        </form>

        <section className="card mb16" aria-labelledby="list-h">
          <h2 id="list-h" className="sr-only">{t('stores.listTitle')}</h2>
          <p className="small muted card-p store-count">
            {filtered ? t('stores.matching', { n: matching.length, total: all.length }) : t('stores.order')}
          </p>
          {all.length === 0 ? <EmptyState title={t('stores.empty')} /> : shown.length === 0 ? <EmptyState title={t('stores.none')} /> : (
            <ul className="store-list">
              {shown.map((s) => {
                const r = s.audit?.results ?? {};
                const met = resultCounts(r).met;
                return (
                  <li key={s.slug} className="store-row">
                    <div className="sr-name">
                      <Link className="link" href={`/stores/${s.slug}`}><b>{s.name}</b></Link>
                      <span className="muted xs">{s.domain}{s.kind === 'manufacturer' ? ` · ${t('stores.kind.manufacturer')}` : ''}</span>
                    </div>
                    <div className="sr-where small">
                      <span className="faint xs">{t('stores.basedIn')}</span>
                      <span>{s.country ? countryName(s.country, locale) : <span className="muted">{t('stores.notStated')}</span>}</span>
                    </div>
                    <div className="sr-checks">
                      {!s.audit ? <span className="pill xs">{t('stores.notAudited')}</span> : !s.audit.reachable ? <span className="pill xs">{t('stores.unreachable')}</span> : (
                        <>
                          <span className="sr-check"><span className="faint xs">{t('stores.check.coa_published')}</span><ResultPill result={r.coa_published} t={t} /></span>
                          <span className="sr-check"><span className="faint xs">{t('stores.check.coa_verifiable')}</span><ResultPill result={r.coa_verifiable} t={t} /></span>
                          <span className="sr-check"><span className="faint xs">{t('stores.check.no_human_use_claims')}</span><ResultPill result={r.no_human_use_claims} t={t} /></span>
                        </>
                      )}
                    </div>
                    <div className="sr-audit xs muted">
                      {s.audit ? (
                        <>
                          <span>{t('stores.metCount', { met, total: STORE_AUDIT_CRITERIA.length })}</span>
                          <span>{formatDay(s.audit.audited_on, locale)}</span>
                        </>
                      ) : null}
                      {s.has_prices ? <Link className="link" href={`/prices/vendor/${s.slug}`}>{t('stores.seePrices')}</Link> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {pages > 1 ? (
            <nav className="row wrap card-p pager" aria-label={t('stores.pages')}>
              {page > 1 ? <Link className="btn ghost sm" href={`/stores${storeFiltersQuery(f, page - 1)}`} rel="prev">{t('stores.prev')}</Link> : null}
              <span className="small muted">{t('stores.page', { page, pages })}</span>
              {page < pages ? <Link className="btn ghost sm" href={`/stores${storeFiltersQuery(f, page + 1)}`} rel="next">{t('stores.next')}</Link> : null}
            </nav>
          ) : null}
        </section>

        <HowWeAudit t={t} version={version} />
      </main>
    </div>
  );
}
