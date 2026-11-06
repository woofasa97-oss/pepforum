import { formatCad } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState, TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { campaignTone } from '@/lib/ads';
import { formatDate, formatDay, relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import {
  adAdjustmentAction, recordAdPaymentAction, resolveAdReportAction, reviewAdvertiserAction, reviewCampaignAction, suspendCampaignAction,
} from '@/server/actions/admin';
import { adminAds } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Ads' };

/** Advertisers, campaigns in review, ad reports, credit (…025). */
export default async function AdminAdsPage() {
  const [t, locale, result] = await Promise.all([getT(), getLocale(), adminAds()]);
  const header = <PageHeader title={t('admin.ads.title')} sub={t('admin.ads.sub')}><Link className="btn sm" href="/admin/settings#group-features">{t('admin.ads.pricing')}</Link></PageHeader>;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const a = result.data;
  const fmt = (micro: number) => formatCad(micro, locale === 'fr' ? 'fr-CA' : 'en-CA');
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const inReview = a.campaigns.filter((c) => c.status === 'review');
  const running = a.campaigns.filter((c) => c.status === 'active' || c.status === 'paused');
  const finished = a.campaigns.filter((c) => !['review', 'active', 'paused'].includes(c.status));

  const campaignCard = (c: (typeof a.campaigns)[number]) => (
    <li key={c.id} className="card card-p">
      <div className="row between wrap mb8" style={{ gap: 8 }}>
        <span className="row wrap" style={{ gap: 6 }}>
          <b>{c.name}</b>
          <span className={`pill ${campaignTone(c.status)}`}>{t(`ads.status.${c.status}` as MessageKey)}</span>
          <span className="pill">{t(`ads.package.${c.package}` as MessageKey)}{c.zone_id ? ` · ${c.zone_id.toUpperCase()}` : ''}{c.category_id ? ` · ${c.category_id}` : ''}</span>
          {c.open_reports > 0 ? <span className="pill red">{t('admin.ads.reportsOn', { n: c.open_reports })}</span> : null}
        </span>
        <span className="xs muted">{c.advertiser} · u/{c.owner}{c.submitted_at ? ` · ${relativeTime(c.submitted_at, t)}` : ''}</span>
      </div>
      <div className="card card-p mb8 ad-card" style={{ maxWidth: 420 }}>
        <span className="pill amber xs">{t('ads.sponsored')}</span>
        {c.image_id ? (
          // eslint-disable-next-line @next/next/no-img-element -- advertiser upload from this origin
          <img className="ad-image mt8" src={`/media/${c.image_id}`} alt="" />
        ) : null}
        <p className="bold mt8">{c.headline}</p>
        <p className="small muted">{c.body}</p>
        <p className="small bold mt8">{c.cta} →</p>
        {c.headline_fr ? <p className="xs muted mt8" lang="fr">{c.headline_fr} — {c.body_fr} — {c.cta_fr}</p> : null}
      </div>
      <dl className="facts">
        <div><dt>{t('ads.landing')}</dt><dd><a className="link" href={c.landing_url} target="_blank" rel="nofollow noopener noreferrer" style={{ overflowWrap: 'anywhere' }}>{c.landing_url}</a></dd></div>
        <div><dt>{t('ads.budget')}</dt><dd>{fmt(c.budget)} · {t('ads.cpm')} {fmt(c.cpm)} · {t('ads.spent')} {fmt(c.spent)}</dd></div>
        {c.starts_on && c.ends_on ? <div><dt>{t('ads.flightLabel')}</dt><dd>{formatDay(c.starts_on, locale)} – {formatDay(c.ends_on, locale)} · {c.impressions.toLocaleString()} / {c.clicks.toLocaleString()}</dd></div> : null}
        {c.review_note ? <div><dt>{t('admin.clin.reviewedBy')}</dt><dd>{c.reviewed_by ? `u/${c.reviewed_by} · ` : ''}{c.review_note}</dd></div> : null}
      </dl>
      <div className="row wrap mt12" style={{ gap: 8 }}>
        {c.status === 'review' ? (
          <>
            <ActionForm action={reviewCampaignAction} label={t('admin.ads.approve')} submit={t('admin.ads.approve')} tone="primary"
              consequence={t('admin.ads.approveConsequence', { days: a.rate_card.flight_days })} hidden={{ id: c.id, decision: 'approve' }}
              reasons={[t('admin.ads.reason.checked')]} labels={labels} />
            <ActionForm action={reviewCampaignAction} label={t('admin.ads.reject')} submit={t('admin.ads.reject')} tone="danger"
              consequence={t('admin.ads.rejectConsequence')} hidden={{ id: c.id, decision: 'reject' }}
              reasons={[t('admin.ads.reason.vendor'), t('admin.ads.reason.claims'), t('admin.ads.reason.landing')]} labels={labels} />
          </>
        ) : null}
        {['active', 'paused', 'review'].includes(c.status) ? (
          <ActionForm action={suspendCampaignAction} label={t('admin.ads.suspend')} submit={t('admin.ads.suspend')} tone="danger"
            consequence={t('admin.ads.suspendConsequence')} hidden={{ id: c.id }} labels={labels} />
        ) : null}
      </div>
    </li>
  );

  return (
    <>
      {header}
      <div className="stats mb16">
        <div className="stat"><div className="v">{a.totals.campaigns_in_review}</div><div className="l">{t('admin.ads.inReview')}</div></div>
        <div className="stat"><div className="v">{a.totals.pending_advertisers}</div><div className="l">{t('admin.ads.pendingOrgs')}</div></div>
        <div className="stat"><div className="v">{a.totals.open_reports}</div><div className="l">{t('admin.ads.openReports')}</div></div>
        <div className="stat"><div className="v">{fmt(a.totals.charged_30d)}</div><div className="l">{t('admin.ads.charged30')}</div></div>
        <div className="stat"><div className="v">{fmt(a.totals.balance)}</div><div className="l">{t('admin.ads.heldCredit')}</div></div>
      </div>
      {!a.rate_card.enabled ? <div className="banner mb16"><Icon name="info" /><div>{t('admin.ads.disabled')}</div></div> : null}

      <section className="admin-section" aria-labelledby="reports-h">
        <h2 id="reports-h">{t('admin.ads.reports')}</h2>
        {a.reports.length === 0 ? <div className="card"><EmptyState title={t('admin.ads.noReports')} /></div> : (
          <ul className="link-queue">
            {a.reports.map((r) => (
              <li key={r.id} className="card card-p">
                <div className="row between wrap" style={{ gap: 8 }}>
                  <span><b>{r.campaign}</b> <span className="xs muted">· {r.advertiser}</span> <span className="pill red">{t(`ads.reportReason.${r.reason}` as MessageKey)}</span></span>
                  <span className="xs muted">u/{r.reporter} · {relativeTime(r.created_at, t)}</span>
                </div>
                {r.details ? <p className="small mt8">“{r.details}”</p> : null}
                <div className="row wrap mt8" style={{ gap: 8 }}>
                  <ActionForm action={resolveAdReportAction} label={t('admin.ads.resolveReport')} submit={t('admin.ads.resolveReport')} hidden={{ id: r.id }} labels={labels} />
                  <ActionForm action={suspendCampaignAction} label={t('admin.ads.suspend')} submit={t('admin.ads.suspend')} tone="danger" consequence={t('admin.ads.suspendConsequence')} hidden={{ id: r.campaign_id }} labels={labels} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-section" aria-labelledby="review-h">
        <h2 id="review-h">{t('admin.ads.waiting')}</h2>
        {inReview.length === 0 ? <div className="card"><EmptyState title={t('admin.ads.noneWaiting')} /></div> : <ul className="link-queue">{inReview.map(campaignCard)}</ul>}
      </section>

      <section className="admin-section" aria-labelledby="orgs-h">
        <h2 id="orgs-h">{t('admin.ads.advertisers')}</h2>
        {a.advertisers.length === 0 ? <div className="card"><EmptyState title={t('admin.ads.noAdvertisers')} /></div> : (
          <ul className="link-queue">
            {a.advertisers.map((o) => (
              <li key={o.id} className="card card-p">
                <div className="row between wrap mb8" style={{ gap: 8 }}>
                  <span className="row wrap" style={{ gap: 6 }}>
                    <b>{o.name}</b>
                    <span className={`pill ${campaignTone(o.status)}`}>{t(`ads.orgStatus.${o.status}` as MessageKey)}</span>
                    <Link className="link xs" href={`/admin/people/${encodeURIComponent(o.owner)}`}>u/{o.owner}</Link>
                    <TierBadge tier={o.owner_tier} t={t} />
                  </span>
                  <span className="xs muted">{formatDate(o.created_at, locale)}</span>
                </div>
                <dl className="facts">
                  <div><dt>{t('ads.orgWebsite')}</dt><dd><a className="link" href={o.website} target="_blank" rel="nofollow noopener noreferrer">{o.website}</a></dd></div>
                  <div><dt>{t('ads.billingEmail')}</dt><dd>{o.billing_email} · {o.billing_province}</dd></div>
                  <div><dt>{t('ads.balance')}</dt><dd>{fmt(o.balance)} ({t('ads.reservedLabel')} {fmt(o.reserved)}) · {t('admin.ads.campaignCount', { n: o.campaigns, review: o.in_review })}</dd></div>
                  {o.review_note ? <div><dt>{t('admin.clin.reviewedBy')}</dt><dd>{o.review_note}</dd></div> : null}
                </dl>
                <div className="row wrap mt12" style={{ gap: 8 }}>
                  {o.status !== 'active' ? (
                    <ActionForm action={reviewAdvertiserAction} label={t('admin.ads.approveOrg')} submit={t('admin.ads.approveOrg')} tone="primary"
                      consequence={t('admin.ads.approveOrgConsequence')} hidden={{ id: o.id, decision: 'approve' }} reasons={[t('admin.ads.reason.orgChecked')]} labels={labels} />
                  ) : null}
                  {o.status !== 'suspended' ? (
                    <ActionForm action={reviewAdvertiserAction} label={t('admin.ads.suspendOrg')} submit={t('admin.ads.suspendOrg')} tone="danger"
                      consequence={t('admin.ads.suspendOrgConsequence')} hidden={{ id: o.id, decision: 'suspend' }} labels={labels} />
                  ) : null}
                  <ActionForm action={recordAdPaymentAction} label={t('admin.ads.recordPayment')} submit={t('admin.ads.recordPayment')} consequence={t('admin.ads.paymentConsequence')} hidden={{ advertiserId: o.id }} labels={labels}>
                    <div className="row wrap" style={{ gap: 12 }}>
                      <div className="field"><label htmlFor={`pay-amt-${o.id}`}>{t('admin.ads.amountCad')}</label><input id={`pay-amt-${o.id}`} name="amountCad" type="number" min={1} step="0.01" className="input" required /></div>
                      <div className="field grow"><label htmlFor={`pay-ref-${o.id}`}>{t('admin.ads.reference')}</label><input id={`pay-ref-${o.id}`} name="reference" className="input" minLength={3} maxLength={120} required /></div>
                    </div>
                  </ActionForm>
                  <ActionForm action={adAdjustmentAction} label={t('admin.ads.adjust')} submit={t('admin.ads.adjust')} consequence={t('admin.ads.adjustConsequence')} hidden={{ advertiserId: o.id }} labels={labels}>
                    <div className="row wrap" style={{ gap: 12 }}>
                      <div className="field"><label htmlFor={`adj-amt-${o.id}`}>{t('admin.ads.amountCadSigned')}</label><input id={`adj-amt-${o.id}`} name="amountCad" type="number" step="0.01" className="input" required /></div>
                      <div className="field grow"><label htmlFor={`adj-ref-${o.id}`}>{t('admin.ads.reference')}</label><input id={`adj-ref-${o.id}`} name="reference" className="input" minLength={3} maxLength={120} required /></div>
                    </div>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {running.length > 0 ? (
        <section className="admin-section" aria-labelledby="running-h">
          <h2 id="running-h">{t('admin.ads.running')}</h2>
          <ul className="link-queue">{running.map(campaignCard)}</ul>
        </section>
      ) : null}
      {finished.length > 0 ? (
        <section className="admin-section" aria-labelledby="finished-h">
          <h2 id="finished-h">{t('admin.ads.finished')}</h2>
          <ul className="link-queue">{finished.slice(0, 20).map(campaignCard)}</ul>
        </section>
      ) : null}

      <section className="admin-section" aria-labelledby="ledger-h">
        <h2 id="ledger-h">{t('admin.ads.ledger')}</h2>
        {a.ledger.length === 0 ? <div className="card"><EmptyState title={t('ads.noLedger')} /></div> : (
          <div className="card tbl-wrap">
            <table className="tbl">
              <thead><tr><th>{t('ads.ledgerDate')}</th><th>{t('admin.ads.advertiser')}</th><th>{t('ads.ledgerKind')}</th><th>{t('ads.ledgerRef')}</th><th>{t('admin.ads.by')}</th><th style={{ textAlign: 'right' }}>{t('ads.ledgerAmount')}</th></tr></thead>
              <tbody>
                {a.ledger.map((l) => (
                  <tr key={l.id}>
                    <td>{formatDate(l.created_at, locale)}</td><td>{l.advertiser}</td><td>{t(`ads.ledgerKind.${l.kind}` as MessageKey)}</td>
                    <td className="xs muted">{l.reference}{l.note ? ` · ${l.note}` : ''}</td><td className="xs muted">{l.by ? `u/${l.by}` : t('admin.ads.worker')}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(l.amount)}</td>
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
