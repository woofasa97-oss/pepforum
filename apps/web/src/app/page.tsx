import Link from 'next/link';

import { FeedPage } from '@/components/feed/FeedPage';
import { Leaf } from '@/components/ui/Icon';
import { parseFeedParams } from '@/lib/params';
import { getT, getViewer } from '@/server/context';

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [t, viewer, params] = await Promise.all([getT(), getViewer(), searchParams]);
  const { sort, page } = parseFeedParams(params);

  const hero = viewer ? undefined : (
    <section className="hero" aria-label="Pepforum">
      <h1>{t('app.tagline')}</h1>
      <p>{t('notes.explain')}</p>
      <p className="small mt8">{t('auth.trust')}</p>
      <div className="cta">
        <Link className="btn red" href="/auth/sign-up">{t('nav.signUp')}</Link>
        <Link className="btn ghost" href="/legal/community-notes">{t('notes.whatIs')}</Link>
      </div>
      <Leaf className="leaf" />
    </section>
  );

  return <FeedPage title={t('feed.national')} subtitle={t('feed.nationalSub')} basePath="/" query={{ sort, page }} hero={hero} />;
}
