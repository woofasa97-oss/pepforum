import { COA_METHODS, COA_SCOPES, PRICE_ORIGINS, PRICE_VENDOR_STATUSES, type AdminPriceCoa } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState } from '@/components/ui/Bits';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import {
  priceCoaSaveAction, priceCoaStatusAction, priceVendorSaveAction, priceVendorStatusAction,
} from '@/server/actions/admin';
import { adminPriceCoas, adminPriceLinks, adminPriceOverview } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Prices' };

const STATUS_TONE = { active: 'green', pending: 'amber', paused: '', delisted: 'red' } as const;

/**
 * Price tracking: which stores are read and shown, the certificates of
 * analysis recorded for them, clicks per store, and how the last runs went.
 * Prices themselves are never edited here: they come only from the pipeline.
 */
export default async function AdminPricesPage() {
  const [t, locale, overview, coas, links] = await Promise.all([getT(), getLocale(), adminPriceOverview(), adminPriceCoas(), adminPriceLinks()]);
  const header = <PageHeader title={t('admin.prices.title')} sub={t('admin.prices.sub')} />;
  if (!overview.ok) return <>{header}<DataUnavailable result={overview} t={t} /></>;
  if (!coas.ok) return <>{header}<DataUnavailable result={coas} t={t} /></>;
  if (!links.ok) return <>{header}<DataUnavailable result={links} t={t} /></>;
  const o = overview.data;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const vendorOptions = o.vendors.map((v) => <option key={v.slug} value={v.slug}>{v.name}</option>);
  const candidates = coas.data.filter((c) => c.status === 'candidate');
  const recorded = coas.data.filter((c) => c.status !== 'candidate');

  const coaFields = (c: AdminPriceCoa | null) => {
    const id = c?.id ?? 'new';
    return (
      <>
        {c ? <input type="hidden" name="id" value={c.id} /> : null}
        <div className="field">
          <label htmlFor={`coa-vendor-${id}`}>{t('admin.prices.vendor')}</label>
          <select id={`coa-vendor-${id}`} name="vendor" className="input" defaultValue={c?.vendor} required>{vendorOptions}</select>
        </div>
        <div className="field">
          <label htmlFor={`coa-compound-${id}`}>{t('admin.prices.compound')}</label>
          <select id={`coa-compound-${id}`} name="compound" className="input" defaultValue={c?.compound ?? ''}>
            <option value="">{t('admin.prices.anyCompound')}</option>
            {o.compounds.map((x) => <option key={x.slug} value={x.slug}>{x.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`coa-url-${id}`}>{t('admin.prices.coaUrl')}</label>
          <input id={`coa-url-${id}`} name="url" type="url" className="input" defaultValue={c?.url} maxLength={1000} pattern="https://.+" required />
        </div>
        <div className="field">
          <label htmlFor={`coa-scope-${id}`}>{t('prices.coa.covers')}</label>
          <select id={`coa-scope-${id}`} name="scope" className="input" defaultValue={c?.scope ?? 'product'}>
            {COA_SCOPES.map((s) => <option key={s} value={s}>{t(`prices.coa.scope.${s}` as MessageKey)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`coa-batch-${id}`}>{t('admin.prices.batch')}</label>
          <input id={`coa-batch-${id}`} name="batch" className="input" defaultValue={c?.batch ?? ''} maxLength={80} />
        </div>
        <div className="field">
          <label htmlFor={`coa-lab-${id}`}>{t('prices.coa.lab')}</label>
          <input id={`coa-lab-${id}`} name="lab" className="input" defaultValue={c?.lab ?? ''} maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor={`coa-acc-${id}`}>{t('admin.prices.accreditation')}</label>
          <input id={`coa-acc-${id}`} name="labAccreditation" className="input" defaultValue={c?.lab_accreditation ?? ''} maxLength={120} aria-describedby={`coa-acc-hint-${id}`} />
          <span id={`coa-acc-hint-${id}`} className="hint">{t('admin.prices.accreditationHint')}</span>
        </div>
        <div className="field">
          <label htmlFor={`coa-method-${id}`}>{t('prices.coa.method')}</label>
          <select id={`coa-method-${id}`} name="method" className="input" defaultValue={c?.method ?? ''}>
            <option value="">—</option>
            {COA_METHODS.map((m) => <option key={m} value={m}>{t(`prices.coa.method.${m}` as MessageKey)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`coa-date-${id}`}>{t('prices.coa.tested')}</label>
          <input id={`coa-date-${id}`} name="testDate" type="date" className="input" defaultValue={c?.test_date ?? ''} />
        </div>
        <div className="field">
          <label htmlFor={`coa-purity-${id}`}>{t('admin.prices.purity')}</label>
          <input id={`coa-purity-${id}`} name="purity" type="number" step="0.001" min="0.001" max="100" className="input" defaultValue={c?.stated_purity_pct ?? ''} aria-describedby={`coa-purity-hint-${id}`} />
          <span id={`coa-purity-hint-${id}`} className="hint">{t('admin.prices.purityHint')}</span>
        </div>
        <div className="field">
          <label htmlFor={`coa-quote-${id}`}>{t('admin.prices.quote')}</label>
          <input id={`coa-quote-${id}`} name="quote" className="input" defaultValue={c?.evidence_quote ?? ''} maxLength={500} />
        </div>
      </>
    );
  };

  const coaRow = (c: AdminPriceCoa) => (
    <tr key={c.id}>
      <td>
        <b>{c.vendor_name}</b>
        <span className="muted">{c.compound_name ?? t('admin.prices.anyCompound')}</span>
        <a className="link xs cell-path" href={c.url} target="_blank" rel="nofollow noopener noreferrer">{c.url}</a>
      </td>
      <td>
        {c.stated_purity_pct === null ? '—' : `${c.stated_purity_pct}%`}
        <span className="muted">{[c.lab, c.method ? t(`prices.coa.method.${c.method}` as MessageKey) : null, c.batch, c.test_date].filter(Boolean).join(' · ') || t('admin.prices.notRecorded')}</span>
      </td>
      <td>
        <span className={`pill ${c.status === 'published' ? 'green' : c.status === 'withdrawn' ? 'red' : 'amber'}`}>{t(`admin.prices.coaStatus.${c.status}` as MessageKey)}</span>
        {c.checked_at ? <span className="muted">{t('admin.prices.checkedBy', { who: c.checked_by ?? '—', when: formatDate(c.checked_at, locale) })}</span> : null}
      </td>
      <td>
        <div className="row wrap">
          <ActionForm action={priceCoaSaveAction} label={t('admin.prices.record')} submit={t('admin.prices.save')}
            consequence={t('admin.prices.recordHelp')} labels={labels}>
            {coaFields(c)}
          </ActionForm>
          {c.status !== 'published' ? (
            <ActionForm action={priceCoaStatusAction} label={t('admin.prices.publish')} submit={t('admin.prices.publish')} tone="primary"
              consequence={t('admin.prices.publishHelp')} hidden={{ id: c.id, status: 'published' }} labels={labels} />
          ) : null}
          {c.status !== 'withdrawn' ? (
            <ActionForm action={priceCoaStatusAction} label={t('admin.prices.withdraw')} submit={t('admin.prices.withdraw')} tone="danger"
              consequence={t('admin.prices.withdrawHelp')} hidden={{ id: c.id, status: 'withdrawn' }} labels={labels} />
          ) : null}
        </div>
      </td>
    </tr>
  );

  const coaTable = (rows: AdminPriceCoa[]) => (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th scope="col">{t('admin.prices.document')}</th><th scope="col">{t('admin.prices.states')}</th><th scope="col">{t('admin.prices.status')}</th><th scope="col" /></tr></thead>
        <tbody>{rows.map(coaRow)}</tbody>
      </table>
    </div>
  );

  return (
    <>
      {header}

      {o.enabled ? null : (
        <div className="banner warn mb16" role="status">
          <div>{t('admin.prices.offBanner')} <Link className="link" href="/admin/settings">{t('admin.nav.settings')}</Link></div>
        </div>
      )}

      <div className="stats mb16">
        <div className="stat"><div className="l">{t('admin.prices.published')}</div><div className="v">{(o.publication?.offers ?? 0).toLocaleString()}</div></div>
        <div className="stat"><div className="l">{t('admin.prices.vendorsShown')}</div><div className="v">{o.publication?.vendors ?? 0}</div></div>
        <div className="stat"><div className="l">{t('admin.prices.compoundsShown')}</div><div className="v">{o.publication?.compounds ?? 0}</div></div>
        <div className="stat">
          <div className="l">{t('admin.prices.lastPublish')}</div>
          <div className="v" style={{ fontSize: 16 }}>{o.publication ? relativeTime(o.publication.published_at, t) : t('admin.prices.never')}</div>
        </div>
      </div>

      <section className="card card-p mb16" aria-labelledby="vendors-h">
        <div className="row between wrap mb8">
          <h2 id="vendors-h" style={{ fontSize: 16 }}>{t('admin.prices.vendors')}</h2>
          <ActionForm action={priceVendorSaveAction} label={t('admin.prices.addVendor')} submit={t('admin.prices.save')}
            consequence={t('admin.prices.addVendorHelp')} labels={labels}>
            <div className="field"><label htmlFor="pv-name">{t('admin.prices.name')}</label><input id="pv-name" name="name" className="input" maxLength={120} required /></div>
            <div className="field">
              <label htmlFor="pv-slug">{t('admin.prices.slug')}</label>
              <input id="pv-slug" name="slug" className="input" maxLength={60} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="maple-labs" required />
            </div>
            <div className="field"><label htmlFor="pv-url">{t('admin.prices.website')}</label><input id="pv-url" name="websiteUrl" type="url" className="input" pattern="https://.+" maxLength={300} placeholder="https://" required /></div>
            <div className="field">
              <label htmlFor="pv-country">{t('prices.vendor.basedIn')}</label>
              <select id="pv-country" name="originCountry" className="input" defaultValue="CA">
                {PRICE_ORIGINS.map((c) => <option key={c} value={c}>{t(`prices.country.${c}` as MessageKey)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pv-source">{t('admin.prices.originSource')}</label>
              <input id="pv-source" name="originSource" className="input" maxLength={500} aria-describedby="pv-source-hint" />
              <span id="pv-source-hint" className="hint">{t('admin.prices.originSourceHint')}</span>
            </div>
          </ActionForm>
        </div>
        <p className="small muted mb12">{t('admin.prices.vendorsHelp')}</p>
        {o.vendors.length === 0 ? <EmptyState title={t('admin.prices.noVendors')} /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t('admin.prices.vendor')}</th>
                  <th scope="col">{t('admin.prices.status')}</th>
                  <th scope="col">{t('admin.prices.lastRead')}</th>
                  <th scope="col" className="num">{t('admin.prices.offers')}</th>
                  <th scope="col" className="num">{t('admin.prices.coas')}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {o.vendors.map((v) => (
                  <tr key={v.slug}>
                    <td>
                      <b>{v.name}</b>
                      <span className="muted">{v.slug} · {t(`prices.country.${v.origin_country}` as MessageKey)} · {v.platform ?? t('admin.prices.notProbed')}</span>
                    </td>
                    <td>
                      <span className={`pill ${STATUS_TONE[v.status]}`}>{t(`admin.prices.vendorStatus.${v.status}` as MessageKey)}</span>
                      {v.unreadable ? <span className="pill amber xs">{t('admin.prices.unreadable')}</span> : null}
                      {v.status_note ? <span className="muted">{v.status_note}</span> : null}
                    </td>
                    <td>
                      {v.last_ingested_at ? relativeTime(v.last_ingested_at, t) : t('admin.prices.never')}
                      {v.last_outcome ? <span className="muted">{v.last_outcome}{v.last_http_status ? ` · HTTP ${v.last_http_status}` : ''}</span> : null}
                    </td>
                    <td className="num">{v.offers}</td>
                    <td className="num">{v.coas}{v.coa_candidates ? <span className="muted">{t('admin.prices.candidatesN', { n: v.coa_candidates })}</span> : null}</td>
                    <td>
                      <ActionForm action={priceVendorStatusAction} label={t('admin.prices.changeStatus')} submit={t('admin.prices.save')}
                        consequence={t('admin.prices.statusHelp')} hidden={{ slug: v.slug }} labels={labels}
                        reasons={[t('admin.prices.reason.cleanDryRun'), t('admin.prices.reason.vendorAsked'), t('admin.prices.reason.refusesReader')]}>
                        <div className="field">
                          <label htmlFor={`st-${v.slug}`}>{t('admin.prices.status')}</label>
                          <select id={`st-${v.slug}`} name="status" className="input" defaultValue={v.status}>
                            {PRICE_VENDOR_STATUSES.map((s) => <option key={s} value={s}>{t(`admin.prices.vendorStatus.${s}` as MessageKey)}</option>)}
                          </select>
                        </div>
                        <label className="check"><input type="checkbox" name="unreadable" defaultChecked={v.unreadable} /> <span>{t('admin.prices.unreadableLabel')}</span></label>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-p mb16" aria-labelledby="coa-h">
        <div className="row between wrap mb8">
          <h2 id="coa-h" style={{ fontSize: 16 }}>{t('admin.prices.coaTitle')}</h2>
          {o.vendors.length ? (
            <ActionForm action={priceCoaSaveAction} label={t('admin.prices.addCoa')} submit={t('admin.prices.save')}
              consequence={t('admin.prices.recordHelp')} labels={labels}>
              {coaFields(null)}
            </ActionForm>
          ) : null}
        </div>
        <p className="small muted mb12">{t('admin.prices.coaHelp')}</p>
        <h3 className="mb8" style={{ fontSize: 14 }}>{t('admin.prices.candidates', { n: candidates.length })}</h3>
        {candidates.length === 0 ? <p className="small muted mb12">{t('admin.prices.noCandidates')}</p> : coaTable(candidates)}
        <h3 className="mb8 mt16" style={{ fontSize: 14 }}>{t('admin.prices.recorded', { n: recorded.length })}</h3>
        {recorded.length === 0 ? <p className="small muted">{t('admin.prices.noRecorded')}</p> : coaTable(recorded)}
      </section>

      <section className="card card-p mb16" aria-labelledby="links-h">
        <h2 id="links-h" className="mb8" style={{ fontSize: 16 }}>{t('admin.prices.clicks')}</h2>
        <p className="small muted mb12">{t('admin.prices.linksHelp')}</p>
        {links.data.clicks.length ? (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th scope="col">{t('admin.prices.vendor')}</th><th scope="col" className="num">{t('admin.prices.clicks7')}</th><th scope="col" className="num">{t('admin.prices.clicks30')}</th></tr></thead>
                <tbody>{links.data.clicks.map((c) => <tr key={c.vendor}><td>{c.vendor_name}</td><td className="num">{c.clicks_7d}</td><td className="num">{c.clicks_30d}</td></tr>)}</tbody>
              </table>
            </div>
          </>
        ) : <p className="small muted">{t('admin.prices.noClicks')}</p>}
      </section>

      <section className="card card-p" aria-labelledby="runs-h">
        <h2 id="runs-h" className="mb8" style={{ fontSize: 16 }}>{t('admin.prices.runs')}</h2>
        <p className="small muted mb12">{t('admin.prices.runsHelp')}</p>
        {o.runs.length === 0 ? <p className="small muted">{t('admin.prices.noRuns')}</p> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t('admin.prices.run')}</th><th scope="col">{t('admin.prices.result')}</th>
                  <th scope="col" className="num">{t('admin.prices.vendorsRead')}</th><th scope="col">{t('admin.prices.started')}</th>
                </tr>
              </thead>
              <tbody>
                {o.runs.map((r) => (
                  <tr key={r.run_label}>
                    <td><code>{r.run_label}</code><span className="muted">{r.mode}{r.dry_run ? ` · ${t('admin.prices.dryRun')}` : ''}</span></td>
                    <td>
                      <span className={`pill ${r.verdict === 'pass' ? 'green' : r.verdict === 'hold' || r.status === 'error' ? 'red' : ''}`}>
                        {r.verdict ? t(`admin.prices.verdict.${r.verdict}` as MessageKey) : r.status}
                      </span>
                    </td>
                    <td className="num">{r.vendors_read}/{r.vendors_tried}</td>
                    <td>{relativeTime(r.started_at, t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
