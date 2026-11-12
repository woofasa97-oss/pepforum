import { STORE_AUDIT_GROUPS, STORE_AUDIT_RESULTS, type StoreAuditCheck } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { GoLink } from '@/components/prices/PriceBits';
import { CHECK_SECTION, HowWeAudit, PreviewBanner, ResultPill, StoresOff } from '@/components/stores/StoreBits';
import { countryName } from '@/lib/countries';
import { formatDay } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { resultCounts } from '@/lib/stores';
import { getLocale, getT } from '@/server/context';
import { getStore, getStoreDirectory } from '@/server/queries';

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ slug }, t] = await Promise.all([params, getT()]);
  const store = await getStore(slug);
  if (!store) return {};
  return { title: t('stores.metaTitle', { name: store.name }), description: t('stores.sub'), alternates: { canonical: `/stores/${store.slug}` } };
}

/** One store: what it says about itself, and its latest public-information audit, check by check, with the words each finding rests on. */
export default async function StorePage({ params }: Props) {
  const [{ slug }, t, locale] = await Promise.all([params, getT(), getLocale()]);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 60) notFound();
  const store = await getStore(slug);
  if (!store) {
    // Off for this viewer, or no such store.
    if (!(await getStoreDirectory())) return <StoresOff t={t} />;
    notFound();
  }

  const audit = store.audit;
  // Country checks hold ISO codes ("CA, US") or "Worldwide": show names in the reader's language.
  const valueText = (criterion: string, value: string) => (criterion === 'identity_country' || criterion === 'ships_to')
    ? value.split(/,\s*/).map((v) => (v === 'Worldwide' ? t('stores.shipsWorldwide') : /^[A-Z]{2}$/.test(v) ? countryName(v, locale) : v)).join(', ')
    : value;
  const checks = new Map<string, StoreAuditCheck>((audit?.checks ?? []).map((c) => [c.criterion, c]));
  const counts = resultCounts(Object.fromEntries((audit?.checks ?? []).map((c) => [c.criterion, c.result])));
  const ships = store.ships_worldwide
    ? t('stores.shipsWorldwide')
    : store.ships_to.length ? store.ships_to.map((c) => countryName(c, locale)).sort((a, b) => a.localeCompare(b, locale)).join(', ') : t('stores.notStated');

  return (
    <div className="page">
      <main id="main" className="narrow">
        {store.preview ? <PreviewBanner t={t} /> : null}
        <p className="small mb8"><Link className="link" href="/stores">{t('stores.back')}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{store.name}</h1>
            <p>{store.domain} · {t(`stores.kind.${store.kind}` as MessageKey)}</p>
          </div>
          <div className="row wrap">
            {store.has_prices ? <Link className="btn sm ghost" href={`/prices/vendor/${store.slug}`}>{t('stores.seePrices')}</Link> : null}
            <GoLink kind="store" id={store.slug} className="btn sm dark" label={t('stores.visitLabel', { store: store.name })}>{t('stores.visit')}</GoLink>
          </div>
        </div>

        <section className="card card-p mb16" aria-labelledby="about-h">
          <h2 id="about-h" className="mb12" style={{ fontSize: 16 }}>{t('stores.about')}</h2>
          <dl className="facts">
            <div><dt>{t('stores.basedIn')}</dt><dd>{store.country ? countryName(store.country, locale) : t('stores.notStated')}</dd></div>
            <div><dt>{t('stores.shipsTo')}</dt><dd>{ships}</dd></div>
            <div><dt>{t('stores.currency')}</dt><dd>{store.currency ?? '—'}</dd></div>
          </dl>
          <p className="xs faint mt12">{t('stores.aboutNote')}</p>
        </section>

        <section className="card card-p mb16" aria-labelledby="audit-h">
          <h2 id="audit-h" className="mb8" style={{ fontSize: 16 }}>{t('stores.audit.title')}</h2>
          {!audit ? <p className="small muted">{t('stores.audit.none')}</p> : (
            <>
              <p className="small muted mb8">{t('stores.audit.meta', { date: formatDay(audit.audited_on, locale), version: audit.standard_version })}</p>
              {!audit.reachable ? <p className="banner mb8">{t('stores.audit.unreachable', { date: formatDay(audit.audited_on, locale) })}</p> : null}
              <div className="audit-summary" aria-label={t('stores.audit.summary')}>
                {STORE_AUDIT_RESULTS.filter((r) => counts[r] > 0).map((r) => (
                  <span key={r} className="row" style={{ gap: 4 }}><ResultPill result={r} t={t} /><span className="small">× {counts[r]}</span></span>
                ))}
              </div>
              {(Object.keys(STORE_AUDIT_GROUPS) as Array<keyof typeof STORE_AUDIT_GROUPS>).map((group) => (
                <div key={group} className="audit-group">
                  <h3 className="small">{t(`stores.group.${group}` as MessageKey)}</h3>
                  {STORE_AUDIT_GROUPS[group].map((criterion) => {
                    const c = checks.get(criterion);
                    return (
                      <div key={criterion} className="audit-check">
                        <b className="small">{t(`stores.check.${criterion}` as MessageKey)} <span className="faint xs">§{CHECK_SECTION[criterion]}</span></b>
                        <ResultPill result={c?.result} t={t} />
                        <span className="ac-help xs muted">{t(`stores.checkHelp.${criterion}` as MessageKey)}</span>
                        {c && (c.value || c.quote) ? (
                          <div className="ac-evidence">
                            {c.value ? <span className="small">{valueText(criterion, c.value)}</span> : null}
                            {c.quote ? <blockquote lang="und">“{c.quote}”</blockquote> : null}
                            {c.has_source ? (
                              <span className="xs muted">
                                <GoLink kind="evidence" id={c.id} label={t('stores.sourceLabel')}>{t('stores.source')}</GoLink>
                                {c.quote ? ` · ${c.quote_verified_on ? t('stores.quoteVerified', { date: formatDay(c.quote_verified_on, locale) }) : t('stores.quoteUnverified')}` : ''}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
              {store.audits > 1 ? <p className="xs faint mt12">{t('stores.audit.history', { n: store.audits })}</p> : null}
            </>
          )}
        </section>

        <HowWeAudit t={t} version={audit?.standard_version ?? '0.9'} />
      </main>
    </div>
  );
}
