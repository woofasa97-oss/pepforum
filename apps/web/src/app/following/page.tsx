import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { FeedPage } from '@/components/feed/FeedPage';
import { parseFeedParams } from '@/lib/params';
import { getT, getViewer } from '@/server/context';

export const metadata: Metadata = { title: 'Following', robots: { index: false } };

/** Posts by the people the member follows (…029), newest first by default. */
export default async function FollowingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [t, viewer, params] = await Promise.all([getT(), getViewer(), searchParams]);
  if (!viewer) redirect('/auth/sign-in?next=/following');
  const { sort, page } = parseFeedParams(params);
  return (
    <FeedPage title={t('feed.followingTitle')} subtitle={t('feed.followingSub')} basePath="/following"
      query={{ sort: params.sort ? sort : 'new', page, following: true }} scope="following" />
  );
}
