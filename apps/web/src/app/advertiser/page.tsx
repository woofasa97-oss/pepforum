import { formatCad } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AdvertiserForm } from '@/components/ads/AdvertiserForm';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { campaignTone } from '@/lib/ads';
import { formatDate, formatDay } from '@/lib/format';
import { type MessageKey, pick } from '@/lib/i18n';
import { countryOptions } from '@/lib/countries';
import { getLocale, getT, getViewer } from '@/server/context';
import { getAdRateCard, getMyAdvertiser } from '@/server/queries';

export const metadata: Metadata = { title: 'Advertiser workspace', robots: { index: false } };

/** The advertiser's organisation, credit, campaigns and ledger (…025). */
export default async function AdvertiserPage() {
  const [t, locale, viewer] = await Promise.all([getT(), getLocale(), getViewer()]);
  if (!viewer) redirect('/auth/sign-in?next=/advertiser');
  const [adv, card] = await Promise.all([getMyAdvertiser(), getAdRateCard()]);
  const fmt = (micro: number) => formatCad(micro, locale === 'fr' ? 'fr-CA' : 'en-CA');

  if (!adv) {
    return (
      <div className="page">
        <main id="main" className="narrow">
          <h1 className="mb8" tabIndex={-1}>{t('ads.workspace')}</h1>
          <p className="muted mb16">{t('ads.noOrg')} <Link className="link" href="/advertise">{t('ads.readPolicy')}</Link></p>
          <section className="card card-p">
            <h2 className="mb12">{t('ads.createOrg')}</h2>
            <AdvertiserForm labels={pick(t, ['ads.orgName', 'ads.orgWebsite', 'ads.billingEmail', 'ads.billingAddress', 'ads.billingCountry', 'ads.orgAck', 'ads.orgSubmit'])} countries={countryOptions(locale)} />
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{adv.name}</h1>
            <p>{t('ads.workspaceSub')}</p>
          </div>
          {adv.status === 'active' ? <Link className="btn dark" href="/advertiser/campaign"><Icon name="plus" />{t('ads.newCampaign')}</Link> : null}
        </div>

        {adv.status === 'pending' ? <div className="banner mb16"><Icon name="clock" /><div>{t('ads.orgPending')}</div></div> : null}
        {adv.status === 'suspended' ? <div className="banner danger mb16"><Icon name="alert" /><div>{t('ads.orgSuspended')} {adv.review_note}</div></div> : null}
        {!card?.enabled && adv.status === 'active' ? <div className="banner mb16"><Icon name="info" /><div>{t('ads.paused')}</div></div> : null}

        <div className="stats mb16">
          <div className="stat"><div className="l">{t('ads.available')}</div><div className="v">{fmt(adv.available)}</div></div>
          <div className="stat"><div className="l">{t('ads.reservedLabel')}</div><div className="v">{fmt(adv.reserved)}</div></div>
          <div className="stat"><div className="l">{t('ads.balance')}</div><div className="v">{fmt(adv.balance)}</div></div>
        </div>
        <p className="small muted mb16">{t('ads.creditHow', { email: adv.billing_email })}</p>

        <h2 className="mb8">{t('ads.campaigns')}</h2>
        <div className="card mb16">
          {adv.campaigns.length === 0 ? <EmptyState title={t('ads.noCampaigns')} /> : (
            <ul className="ticket-list">
              {adv.campaigns.map((c) => (
                <li key={c.id}>
                  <Link href={`/advertiser/campaign?id=${c.id}`}>
                    <span className="row between wrap">
                      <b>{c.name}</b>
                      <span className={`pill ${campaignTone(c.status)}`}>{t(`ads.status.${c.status}` as MessageKey)}</span>
                    </span>
                    <span className="small muted">
                      {t(`ads.package.${c.package}` as MessageKey)}{c.category_id ? ` · ${c.category_id}` : ''} · {fmt(c.budget)}
                      {c.starts_on && c.ends_on ? ` · ${formatDay(c.starts_on, locale)} – ${formatDay(c.ends_on, locale)}` : ''}
                    </span>
                    <span className="xs muted">{t('ads.stats', { impressions: c.impressions.toLocaleString(), clicks: c.clicks.toLocaleString(), spent: fmt(c.spent) })}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <h2 className="mb8">{t('ads.ledger')}</h2>
        <div className="card">
          {adv.ledger.length === 0 ? <EmptyState title={t('ads.noLedger')} /> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>{t('ads.ledgerDate')}</th><th>{t('ads.ledgerKind')}</th><th>{t('ads.ledgerRef')}</th><th style={{ textAlign: 'right' }}>{t('ads.ledgerAmount')}</th></tr></thead>
                <tbody>
                  {adv.ledger.map((l) => (
                    <tr key={l.id}>
                      <td>{formatDate(l.created_at, locale)}</td>
                      <td>{t(`ads.ledgerKind.${l.kind}` as MessageKey)}</td>
                      <td className="xs muted">{l.reference}{l.note ? ` · ${l.note}` : ''}</td>
                      <td style={{ textAlign: 'right', color: l.amount < 0 ? 'var(--accent)' : 'var(--green)' }}>{fmt(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
