import Link from 'next/link';

import { Leaf } from '@/components/ui/Icon';
import { getT } from '@/server/context';

export async function SiteFooter() {
  const t = await getT();
  return (
    <footer className="ftr">
      <div className="ftr-in">
        <div>
          <Link className="logo" href="/"><Leaf /><span>PEP<span className="lt">FORUM</span></span></Link>
          <p className="small mt8" style={{ color: 'rgba(255,255,255,.75)', maxWidth: 360 }}>{t('app.tagline')}</p>
          <p className="xs mt8" style={{ color: 'rgba(255,255,255,.65)' }}>{t('app.disclaimer')}</p>
        </div>
        <div>
          <h2>Pepforum</h2>
          <Link href="/notes">{t('nav.notes')}</Link>
          <Link href="/legal/community-notes">{t('footer.howNotes')}</Link>
        </div>
        <div>
          <h2>{t('footer.legal')}</h2>
          <Link href="/legal/terms">{t('footer.terms')}</Link>
          <Link href="/legal/privacy">{t('footer.privacy')}</Link>
          <Link href="/legal/content-policy">{t('footer.contentPolicy')}</Link>
          <Link href="/legal/loi-25">{t('footer.loi25')}</Link>
        </div>
        <div className="copy">{t('footer.copyright')}</div>
      </div>
    </footer>
  );
}
