import Link from 'next/link';

import { getT } from '@/server/context';
import { getPricesEnabled } from '@/server/queries';

import { Logo } from './Logo';

export async function SiteFooter() {
  const [t, prices] = await Promise.all([getT(), getPricesEnabled()]);
  return (
    <footer className="ftr">
      <div className="ftr-in">
        <div>
          <Logo tag={t('app.brandTag')} />
          <p className="small mt8" style={{ color: 'rgba(255,255,255,.75)', maxWidth: 360 }}>{t(prices ? 'app.taglinePrices' : 'app.tagline')}</p>
          <p className="xs mt8" style={{ color: 'rgba(255,255,255,.65)' }}>{t('app.disclaimer')}</p>
        </div>
        <div>
          <h2>Pepforums</h2>
          <Link href="/notes">{t('nav.notes')}</Link>
          <Link href="/legal/community-notes">{t('footer.howNotes')}</Link>
          <Link href="/transparency">{t('footer.transparency')}</Link>
          <Link href="/contact">{t('footer.contact')}</Link>
          <Link href="/advertise">{t('footer.advertise')}</Link>
          {prices ? <Link href="/prices">{t('nav.prices')}</Link> : null}
        </div>
        <div>
          <h2>{t('footer.legal')}</h2>
          <Link href="/legal/terms">{t('footer.terms')}</Link>
          <Link href="/legal/privacy">{t('footer.privacy')}</Link>
          <Link href="/legal/content-policy">{t('footer.contentPolicy')}</Link>
          <Link href="/legal/loi-25">{t('footer.loi25')}</Link>
          <Link href="/legal/price-methodology">{t('prices.methodology')}</Link>
          <Link href="/legal/affiliate-disclosure">{t('prices.disclosure')}</Link>
        </div>
        <div className="copy">{t('footer.copyright')}</div>
      </div>
    </footer>
  );
}
