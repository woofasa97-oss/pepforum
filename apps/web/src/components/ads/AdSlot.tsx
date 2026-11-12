import { AD_REPORT_REASONS } from '@pepforum/database';
import Link from 'next/link';

import { Icon } from '@/components/ui/Icon';
import { type MessageKey, pick } from '@/lib/i18n';
import { getLocale, getStanding, getT } from '@/server/context';
import { getAd } from '@/server/queries';

import { ReportAdForm } from './ReportAdForm';

export const REPORT_AD_LABEL_KEYS = [
  'ads.report', 'ads.reportIntro', 'ads.reportReason', 'ads.reportDetails', 'ads.reportSubmit',
  ...AD_REPORT_REASONS.map((r) => `ads.reportReason.${r}` as const),
] satisfies MessageKey[];

/**
 * One sponsored card for a slot (…025). Renders nothing when ads are off or
 * nothing is booked. The click goes through /ads/go/<id>; the landing URL is
 * never in the page.
 */
export async function AdSlot({ pkg, target }: { pkg: 'national' | 'category'; target: string | null }) {
  const [t, locale, standing] = await Promise.all([getT(), getLocale(), getStanding()]);
  const ad = await getAd(pkg, target, locale);
  if (!ad) return null;
  return (
    <aside className="card card-p ad-card" aria-label={t('ads.sponsored')}>
      <div className="row between">
        <span className="pill amber xs">{t('ads.sponsored')}</span>
        <span className="xs faint">{t('ads.by', { name: ad.advertiser })}</span>
      </div>
      {ad.image_id ? (
        // eslint-disable-next-line @next/next/no-img-element -- advertiser upload, same origin
        <img className="ad-image mt8" src={`/media/${ad.image_id}`} alt="" loading="lazy" />
      ) : null}
      <p className="bold mt8">{ad.headline}</p>
      <p className="small muted mt8">{ad.body}</p>
      <a className="btn sm dark mt12" href={`/ads/go/${ad.id}`} rel="nofollow sponsored noopener">
        {ad.cta} <Icon name="external" />
      </a>
      <div className="row between mt8">
        <Link className="xs faint" href="/advertise">{t('ads.whyThis')}</Link>
        {standing ? <ReportAdForm campaignId={ad.id} labels={pick(t, REPORT_AD_LABEL_KEYS)} /> : null}
      </div>
    </aside>
  );
}
