import type { StoreAuditResult } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { BrandTile, HowWeAudit, PreviewBanner, Scorecard, StoresOff } from '@/components/stores/StoreBits';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { countryName } from '@/lib/countries';
import type { MessageKey, Translate } from '@/lib/i18n';
import { STORES_PER_PAGE, filterStores, parseStoreFilters, storeFiltersQuery } from '@/lib/stores';
import { getLocale, getT } from '@/server/context';
import { getStoreDirectory } from '@/server/queries';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('stores.title'), description: t('stores.sub'), alternates: { canonical: '/stores' } };
}

/** One key check on a card, worded as what was found: "Certificates per lot", "Human-use claims"… */
function KeyCheck({ result, check, t }: { result: StoreAuditResult | undefined; check: 'coa' | 'verify' | 'claims'; t: Translate }) {
  const icon = result === 'met' ? 'check' : result === 'partly' ? 'alert' : result === 'not_met' ? 'x' : result === 'not_found' ? 'search' : 'help';
  const said = result === 'met' ? 'met' : result === 'partly' ? 'partly' : result === 'not_met' || result === 'not_found' ? 'no' : 'unknown';
  return (
    <span className={`key-check r-${result ?? 'none'}`} title={`${t(`stores.key.${check}` as MessageKey)}: ${result ? t(`stores.result.${result}` as MessageKey) : t('stores.notAudited')}`}>
      <Icon name={icon} /><span>{t(`stores.keySaid.${check}.${said}` as MessageKey)}</span>
    </span>
  );
}

/** Every listed store, worldwide, as cards. Alphabetical: the order carries no preference. */
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
  const listing = all.filter((s) => s.listings > 0).length;
  const version = all.map((s) => s.audit?.standard_version).find(Boolean) ?? '0.9';
  const filtered = storeFiltersQuery(f) !== '';
  const advanced = Boolean(f.kind || f.certificates || f.verifiable || f.noClaims);

  return (
    <div className="page">
      <main id="main" className="stores-main">
        {directory.preview ? <PreviewBanner t={t} /> : null}
        <header className="stores-hero">
          <div>
            <h1 tabIndex={-1}>{t('stores.title')}</h1>
            <p>{t('stores.sub')}</p>
          </div>
          <dl className="hero-stats">
            <div><dt>{t('stores.stat.stores')}</dt><dd>{all.length}</dd></div>
            <div><dt>{t('stores.stat.countries')}</dt><dd>{basedIn.length}</dd></div>
            <div><dt>{t('stores.stat.listing')}</dt><dd>{listing}</dd></div>
            <div><dt>{t('stores.stat.audited')}</dt><dd>{audited}</dd></div>
            <div><dt><Link className="link" href="/stores/labs">{t('stores.stat.labs')}</Link></dt><dd>{directory.labs.length}</dd></div>
          </dl>
        </header>

        <form className="store-filters card" method="get" action="/stores" role="search" aria-label={t('stores.filter.label')}>
          <div className="sf-row">
            <label className="sf-search">
              <Icon name="search" />
              <span className="sr-only">{t('stores.filter.q')}</span>
              <input className="input" type="search" name="q" defaultValue={f.q} maxLength={80} placeholder={t('stores.filter.q')} />
            </label>
            <label className="sf-select">
              <span className="sr-only">{t('stores.filter.sells')}</span>
              <select className="input" name="sells" defaultValue={f.sells ?? ''}>
                <option value="">{t('stores.filter.sellsAny')}</option>
                {directory.compounds.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </label>
            <label className="sf-select">
              <span className="sr-only">{t('stores.filter.country')}</span>
              <select className="input" name="country" defaultValue={f.country ?? ''}>
                <option value="">{t('stores.filter.countryAny')}</option>
                {basedIn.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="sf-select">
              <span className="sr-only">{t('stores.filter.shipsTo')}</span>
              <select className="input" name="ships" defaultValue={f.shipsTo ?? ''}>
                <option value="">{t('stores.filter.shipsAny')}</option>
                {shipsTo.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <button className="btn dark sm" type="submit">{t('stores.filter.apply')}</button>
          </div>
          <details className="sf-more" open={advanced}>
            <summary>{t('stores.filter.more')}<Icon name="chevron" className="i chev" /></summary>
            <div className="sf-more-body">
              <label className="check"><input type="checkbox" name="coa" value="1" defaultChecked={f.certificates} /> {t('stores.filter.certificates')}</label>
              <label className="check"><input type="checkbox" name="verify" value="1" defaultChecked={f.verifiable} /> {t('stores.filter.verifiable')}</label>
              <label className="check"><input type="checkbox" name="claims" value="1" defaultChecked={f.noClaims} /> {t('stores.filter.noClaims')}</label>
              <label className="sf-kind">
                <span>{t('stores.filter.kind')}</span>
                <select className="input" name="kind" defaultValue={f.kind ?? ''}>
                  <option value="">{t('stores.filter.any')}</option>
                  <option value="store">{t('stores.kind.store')}</option>
                  <option value="manufacturer">{t('stores.kind.manufacturer')}</option>
                </select>
              </label>
            </div>
          </details>
        </form>

        <div className="stores-bar">
          <p className="small muted">{filtered ? t('stores.matching', { n: matching.length, total: all.length }) : t('stores.order')}</p>
          {filtered ? <Link className="btn ghost sm" href="/stores">{t('stores.filter.clear')}</Link> : null}
        </div>

        {all.length === 0 ? <div className="card"><EmptyState title={t('stores.empty')} /></div> : shown.length === 0 ? <div className="card"><EmptyState title={t('stores.none')} /></div> : (
          <ul className="store-grid">
            {shown.map((s) => {
              const r = s.audit?.results ?? {};
              return (
                <li key={s.slug}>
                  <Link className="store-card" href={`/stores/${s.slug}${f.sells ? `?compound=${f.sells}` : ''}`}>
                    <BrandTile slug={s.slug} name={s.name} />
                    <span className="sc-body">
                      <span className="sc-title">
                        <b>{s.name}</b>
                        {s.kind === 'manufacturer' ? <span className="pill xs blue">{t('stores.kind.manufacturer')}</span> : null}
                      </span>
                      <span className="sc-meta xs muted">
                        <span><Icon name="globe" />{s.country ? countryName(s.country, locale) : t('stores.notStated')}</span>
                        <span>{s.domain}</span>
                      </span>
                      <span className="sc-facts small">
                        <span><b>{s.listings || '—'}</b> {t('stores.card.peptides')}</span>
                        <span><b>{s.documents || '—'}</b> {t('stores.card.certificates')}</span>
                      </span>
                      {!s.audit ? <span className="pill xs">{t('stores.notAudited')}</span> : !s.audit.reachable ? <span className="pill xs">{t('stores.unreachable')}</span> : (
                        <>
                          <Scorecard results={r} t={t} compact />
                          <span className="key-checks">
                            <KeyCheck result={r.coa_published} check="coa" t={t} />
                            <KeyCheck result={r.coa_verifiable} check="verify" t={t} />
                            <KeyCheck result={r.no_human_use_claims} check="claims" t={t} />
                          </span>
                        </>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {pages > 1 ? (
          <nav className="row wrap pager mb16" aria-label={t('stores.pages')}>
            {page > 1 ? <Link className="btn ghost sm" href={`/stores${storeFiltersQuery(f, page - 1)}`} rel="prev">{t('stores.prev')}</Link> : null}
            <span className="small muted">{t('stores.page', { page, pages })}</span>
            {page < pages ? <Link className="btn ghost sm" href={`/stores${storeFiltersQuery(f, page + 1)}`} rel="next">{t('stores.next')}</Link> : null}
          </nav>
        ) : null}

        <HowWeAudit t={t} version={version} />
      </main>
    </div>
  );
}
