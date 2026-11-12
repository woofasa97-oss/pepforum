import { FeedPage } from '@/components/feed/FeedPage';
import { BrandHero } from '@/components/home/BrandHero';
import { parseFeedParams } from '@/lib/params';
import { getT, getViewer } from '@/server/context';

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [t, viewer, params] = await Promise.all([getT(), getViewer(), searchParams]);
  const { sort, page } = parseFeedParams(params);
  // Like the prototype, the hero tops the default (popular) view only.
  const isLanding = (sort ?? 'hot') === 'hot' && !page;
  const hero = isLanding ? <BrandHero t={t} signedIn={Boolean(viewer)} /> : undefined;

  return <FeedPage title={t('feed.national')} subtitle={t('feed.nationalSub')} basePath="/" query={{ sort, page }} hero={hero} scope="everyone" />;
}
