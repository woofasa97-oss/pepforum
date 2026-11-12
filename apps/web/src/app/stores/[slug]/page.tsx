import { STORE_AUDIT_GROUPS, type StoreAuditCheck, type StoreAuditResult, type StoreListing } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { GoLink } from '@/components/prices/PriceBits';
import { BrandTile, CheckRow, HowWeAudit, PreviewBanner, ResultPill, Scorecard, StoresOff } from '@/components/stores/StoreBits';
import { Icon } from '@/components/ui/Icon';
import { countryName } from '@/lib/countries';
import { formatDay } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { formatMinor, formatPerMg, sizeText } from '@/lib/stores';
import { getLocale, getT } from '@/server/context';
import { getStore, getStoreDirectory } from '@/server/queries';

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tab?: string; compound?: string }>;
}

const TABS = ['products', 'standards', 'about'] as const;
type Tab = (typeof TABS)[number];

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ slug }, t] = await Promise.all([params, getT()]);
  const store = await getStore(slug);
  if (!store) return {};
  return { title: t('stores.metaTitle', { name: store.name }), description: t('stores.sub'), alternates: { canonical: `/stores/${store.slug}` } };
}

function Tile({ label, children, result, t }: { label: string; children?: React.ReactNode; result?: StoreAuditResult; t: Translate }) {
  return (
    <div className={`sum-tile r-${result ?? 'none'}`}>
      <span className="st-label">{label}</span>
      <span className="st-value">{children ?? <ResultPill result={result} t={t} />}</span>
    </div>
  );
}

/** One store: who it is, what it sells and at what listed price, and what it publishes about quality. */
export default async function StorePage({ params, searchParams }: Props) {
  const [{ slug }, query, t, locale] = await Promise.all([params, searchParams, getT(), getLocale()]);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 60) notFound();
  const store = await getStore(slug);
  if (!store) {
    if (!(await getStoreDirectory())) return <StoresOff t={t} />;
    notFound();
  }

  const tab: Tab = (TABS as readonly string[]).includes(query.tab ?? '') ? (query.tab as Tab) : 'products';
  const focus = typeof query.compound === 'string' && /^[a-z0-9-]{1,60}$/.test(query.compound) ? query.compound : null;
  const audit = store.audit;
  const checks = new Map<string, StoreAuditCheck>((audit?.checks ?? []).map((c) => [c.criterion, c]));
  const results = Object.fromEntries((audit?.checks ?? []).map((c) => [c.criterion, c.result])) as Partial<Record<string, StoreAuditResult>>;
  const valueText = (criterion: string, value: string) => (criterion === 'identity_country' || criterion === 'ships_to')
    ? value.split(/,\s*/).map((v) => (v === 'Worldwide' ? t('stores.shipsWorldwide') : /^[A-Z]{2}$/.test(v) ? countryName(v, locale) : v)).join(', ')
    : value;
  const ships = store.ships_worldwide
    ? t('stores.shipsWorldwide')
    : store.ships_to.length ? store.ships_to.map((c) => countryName(c, locale)).sort((a, b) => a.localeCompare(b, locale)).join(', ') : t('stores.notStated');

  // The listing, grouped by compound, in the order the database gives (name, size, price).
  const listings = store.catalogue?.listings ?? [];
  const groups = new Map<string, { name: string; rows: StoreListing[] }>();
  for (const l of listings) {
    const g = groups.get(l.compound) ?? { name: l.compound_name, rows: [] };
    g.rows.push(l);
    groups.set(l.compound, g);
  }
  const documents = store.documents;
  const docGroups = new Map<string, typeof documents>();
  for (const d of documents) docGroups.set(d.compound_name ?? '', [...(docGroups.get(d.compound_name ?? '') ?? []), d]);
  const tests = checks.get('independent_results');
  const lab = checks.get('coa_lab_named');
  const tabHref = (to: Tab) => `/stores/${store.slug}${to === 'products' ? '' : `?tab=${to}`}`;

  return (
    <div className="page">
      <main id="main" className="stores-main">
        {store.preview ? <PreviewBanner t={t} /> : null}
        <p className="small mb8"><Link className="link" href="/stores">← {t('stores.back')}</Link></p>

        <section className="store-hero card">
          <BrandTile slug={store.slug} name={store.name} size="hero" />
          <div className="sh-main">
            <div className="sh-title">
              <h1 tabIndex={-1}>{store.name}</h1>
              {store.kind === 'manufacturer' ? <span className="pill blue">{t('stores.kind.manufacturer')}</span> : null}
            </div>
            <p className="muted small">{store.domain}</p>
            <ul className="sh-facts">
              <li><Icon name="globe" /><span className="faint">{t('stores.basedIn')}</span> {store.country ? countryName(store.country, locale) : t('stores.notStated')}</li>
              <li><Icon name="external" /><span className="faint">{t('stores.shipsTo')}</span> {ships}</li>
              {store.currency ? <li><Icon name="scale" /><span className="faint">{t('stores.currency')}</span> {store.currency}</li> : null}
            </ul>
          </div>
          <div className="sh-actions">
            <GoLink kind="store" id={store.slug} className="btn dark" label={t('stores.visitLabel', { store: store.name })}>{t('stores.visit')}<Icon name="external" /></GoLink>
            {store.has_prices ? <Link className="btn ghost sm" href={`/prices/vendor/${store.slug}`}>{t('stores.seePrices')}</Link> : null}
            {audit ? <span className="xs muted">{t('stores.audit.meta', { date: formatDay(audit.audited_on, locale), version: audit.standard_version })}</span> : null}
          </div>
        </section>

        <section className="sum-grid" aria-label={t('stores.audit.summary')}>
          <Tile label={t('stores.tile.peptides')} t={t}>
            <b className="st-num">{listings.length || '—'}</b>
            <span className="xs muted">{groups.size ? t('stores.tile.compounds', { n: groups.size }) : t('stores.tile.noListing')}</span>
          </Tile>
          <Tile label={t('stores.key.coa')} result={results.coa_published} t={t}>
            <ResultPill result={results.coa_published} t={t} />
            <span className="xs muted">{t('stores.tile.documents', { n: documents.length })}</span>
          </Tile>
          <Tile label={t('stores.key.verify')} result={results.coa_verifiable} t={t} />
          <Tile label={t('stores.check.independent_results')} result={results.independent_results} t={t}>
            <ResultPill result={results.independent_results} t={t} />
            {tests?.quote ? <span className="xs muted">{tests.quote}</span> : null}
          </Tile>
          <Tile label={t('stores.key.claims')} result={results.no_human_use_claims} t={t} />
        </section>
        {audit ? <div className="card card-p mb16 sum-score"><Scorecard results={results} t={t} /><span className="xs muted">{t('stores.audit.scoreNote')}</span></div> : null}

        <nav className="store-tabs" aria-label={t('stores.tabs')}>
          {TABS.map((x) => (
            <Link key={x} href={tabHref(x)} className={x === tab ? 'active' : undefined} aria-current={x === tab ? 'page' : undefined}>
              {t(`stores.tab.${x}` as MessageKey)}
              <span className="tab-count">{x === 'products' ? listings.length : x === 'standards' ? documents.length : ''}</span>
            </Link>
          ))}
        </nav>

        {tab === 'products' ? (
          <section className="card card-p mb16" aria-labelledby="products-h">
            <h2 id="products-h" className="sr-only">{t('stores.tab.products')}</h2>
            {!store.catalogue || listings.length === 0 ? (
              <div className="empty">
                <b>{t('stores.products.none')}</b>
                <p>{t('stores.products.noneHelp')}</p>
                <GoLink kind="store" id={store.slug} className="btn dark sm mt12" label={t('stores.visitLabel', { store: store.name })}>{t('stores.visit')}</GoLink>
              </div>
            ) : (
              <>
                <p className="xs muted mb12">{t('stores.products.note', { date: formatDay(store.catalogue.observed_on, locale) })}{store.catalogue.complete ? '' : ` ${t('stores.products.partial')}`}</p>
                <div className="compound-chips">
                  {[...groups].map(([c, g]) => (
                    <a key={c} href={`#c-${c}`} className={`chip sm${focus === c ? ' active' : ''}`}>{g.name} <span className="faint">{g.rows.length}</span></a>
                  ))}
                </div>
                {[...groups].map(([c, g]) => (
                  <div key={c} id={`c-${c}`} className={`compound-group${focus === c ? ' focus' : ''}`}>
                    <h3>{g.name}<span className="xs muted"> · {g.rows.length === 1 ? t('stores.products.option') : t('stores.products.options', { n: g.rows.length })}</span></h3>
                    <ul className="listing-list">
                      {g.rows.map((l) => (
                        <li key={l.id} className="listing-row">
                          <span className="lr-name">{l.product_name}{l.variant_label && l.mg_per_vial !== null && !l.product_name.includes(l.variant_label) ? <span className="muted"> · {l.variant_label}</span> : null}</span>
                          <span className="lr-price">
                            <b>{formatMinor(l.price_minor, l.currency, locale)}</b>
                            {l.on_sale && l.list_price_minor ? <s className="xs muted">{formatMinor(l.list_price_minor, l.currency, locale)}</s> : null}
                          </span>
                          <span className="lr-meta">
                            <span className="lr-size">{sizeText(l)}</span>
                            <span className="lr-mg xs muted">{l.per_mg_minor_e4 && !l.is_blend ? t('stores.products.perMg', { price: formatPerMg(l.per_mg_minor_e4, l.currency, locale) }) : ''}</span>
                            <span className="lr-stock"><span className={`pill xs ${l.availability === 'in_stock' ? 'green' : l.availability === 'unknown' ? '' : 'amber'}`.trim()}>{t(`stores.avail.${l.availability}` as MessageKey)}</span></span>
                          </span>
                          <span className="lr-go">{l.has_url ? <GoLink kind="listing" id={l.id} label={t('stores.products.viewLabel', { product: l.product_name })}><Icon name="external" /></GoLink> : null}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </section>
        ) : null}

        {tab === 'standards' ? (
          <section className="mb16" aria-labelledby="standards-h">
            <h2 id="standards-h" className="sr-only">{t('stores.tab.standards')}</h2>
            <div className="grid2 even">
              <div className="card card-p">
                <h3 className="small mb8">{t('stores.group.certificates')}</h3>
                {STORE_AUDIT_GROUPS.certificates.map((c) => <CheckRow key={c} c={checks.get(c)} criterion={c} t={t} locale={locale} valueText={valueText} />)}
                {lab?.value ? <p className="xs muted mt8"><Link className="link" href="/stores/labs">{t('stores.standards.labsLink')}</Link></p> : null}
              </div>
              <div className="card card-p">
                <h3 className="small mb8">{t('stores.group.testing')}</h3>
                {STORE_AUDIT_GROUPS.testing.map((c) => <CheckRow key={c} c={checks.get(c)} criterion={c} t={t} locale={locale} />)}
                <h3 className="small mt16 mb8">{t('stores.group.conduct')}</h3>
                {STORE_AUDIT_GROUPS.conduct.map((c) => <CheckRow key={c} c={checks.get(c)} criterion={c} t={t} locale={locale} />)}
              </div>
            </div>
            <div className="card card-p mt12">
              <h3 className="small mb4">{t('stores.standards.documents', { n: documents.length })}</h3>
              {documents.length === 0 ? <p className="small muted">{t('stores.standards.noDocuments')}</p> : (
                <>
                  <p className="xs muted mb12">{t('stores.standards.documentsNote')}</p>
                  <div className="doc-groups">
                    {[...docGroups].map(([name, docs]) => (
                      <div key={name || '-'} className="doc-group">
                        <span className="dg-name">{name || t('stores.standards.otherDocuments')}</span>
                        <span className="doc-chips">
                          {docs.map((d) => <GoLink key={d.id} kind="document" id={d.id} className="chip sm" label={t('stores.standards.openDocument', { label: d.label })}><Icon name="file" />{d.label}</GoLink>)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>
        ) : null}

        {tab === 'about' ? (
          <section className="grid2 even mb16" aria-labelledby="about-h">
            <h2 id="about-h" className="sr-only">{t('stores.tab.about')}</h2>
            <div className="card card-p">
              <h3 className="small mb8">{t('stores.group.identity')}</h3>
              {STORE_AUDIT_GROUPS.identity.map((c) => <CheckRow key={c} c={checks.get(c)} criterion={c} t={t} locale={locale} valueText={valueText} />)}
              <p className="xs faint mt12">{t('stores.aboutNote')}</p>
            </div>
            <div className="card card-p">
              <h3 className="small mb8">{t('stores.audit.title')}</h3>
              {!audit ? <p className="small muted">{t('stores.audit.none')}</p> : (
                <dl className="facts">
                  <div><dt>{t('stores.audit.when')}</dt><dd>{formatDay(audit.audited_on, locale)}</dd></div>
                  <div><dt>{t('stores.audit.standard')}</dt><dd>{t('stores.audit.standardValue', { version: audit.standard_version })}</dd></div>
                  <div><dt>{t('stores.audit.method')}</dt><dd>{t('stores.audit.methodValue')}</dd></div>
                  {store.catalogue ? <div><dt>{t('stores.audit.catalogue')}</dt><dd>{formatDay(store.catalogue.observed_on, locale)}</dd></div> : null}
                  {store.audits > 1 ? <div><dt>{t('stores.audit.records')}</dt><dd>{store.audits}</dd></div> : null}
                </dl>
              )}
              {audit && !audit.reachable ? <p className="banner mt12">{t('stores.audit.unreachable', { date: formatDay(audit.audited_on, locale) })}</p> : null}
            </div>
          </section>
        ) : null}

        <HowWeAudit t={t} version={audit?.standard_version ?? '0.9'} />
      </main>
    </div>
  );
}
