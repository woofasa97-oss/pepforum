import { AD_PACKAGES, formatCad } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Icon } from '@/components/ui/Icon';
import type { MessageKey } from '@/lib/i18n';
import { getLocale, getT, getViewer } from '@/server/context';
import { getAdRateCard } from '@/server/queries';

export const metadata: Metadata = { title: 'Advertise' };

/** Public rate card and policy (…025). Pricing comes from app_config via ad_rate_card(). */
export default async function AdvertisePage() {
  const [t, locale, viewer, card] = await Promise.all([getT(), getLocale(), getViewer(), getAdRateCard()]);
  const fmt = (micro: number) => formatCad(micro, locale === 'fr' ? 'fr-CA' : 'en-CA');
  return (
    <div className="page">
      <main id="main" className="narrow">
        <h1 className="mb8" tabIndex={-1}>{t('ads.pageTitle')}</h1>
        <p className="muted mb16" style={{ fontSize: 17 }}>{t('ads.pageLead')}</p>

        <section className="card card-p mb16" aria-labelledby="policy-h">
          <h2 id="policy-h" className="mb8">{t('ads.policyTitle')}</h2>
          <ul style={{ paddingLeft: 18 }}>
            {['noVendors', 'noClaims', 'reviewed', 'labelled', 'reportable'].map((k) => <li key={k} className="small mb8">{t(`ads.policy.${k}` as MessageKey)}</li>)}
          </ul>
        </section>

        <section className="card card-p mb16" aria-labelledby="rates-h">
          <h2 id="rates-h" className="mb8">{t('ads.ratesTitle')}</h2>
          {card ? (
            <>
              <div className="stats mb12">
                {AD_PACKAGES.map((p) => (
                  <div key={p} className="stat">
                    <div className="l">{t(`ads.package.${p}` as MessageKey)}</div>
                    <div className="v">{fmt(card.cpm[p])}</div>
                    <div className="xs muted">{t('ads.cpm')}</div>
                  </div>
                ))}
              </div>
              <p className="small muted">{t('ads.ratesBody', { min: fmt(card.min_booking), days: card.flight_days })}</p>
              {!card.enabled ? <div className="banner mt12"><Icon name="info" /><div>{t('ads.paused')}</div></div> : null}
            </>
          ) : <p className="small muted">{t('ads.ratesUnavailable')}</p>}
        </section>

        <section className="card card-p" aria-labelledby="how-h">
          <h2 id="how-h" className="mb8">{t('ads.howTitle')}</h2>
          <ol style={{ paddingLeft: 18 }}>
            {['org', 'credit', 'campaign', 'review', 'run'].map((k) => <li key={k} className="small mb8">{t(`ads.how.${k}` as MessageKey)}</li>)}
          </ol>
          <Link className="btn dark mt12" href={viewer ? '/advertiser' : '/auth/sign-in?next=/advertiser'}>{t('ads.openWorkspace')}</Link>
        </section>
      </main>
    </div>
  );
}
