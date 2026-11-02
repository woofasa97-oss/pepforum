import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { PostForm } from '@/components/post/PostForm';
import { POST_FORM_LABEL_KEYS } from '@/components/post/post-form-labels';
import { pick } from '@/lib/i18n';
import { isUuid } from '@/lib/params';
import { getLocale, getStanding, getT } from '@/server/context';
import { getPost } from '@/server/queries';

export const metadata: Metadata = { robots: { index: false } };

export default async function EditPostPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  if (!isUuid(postId)) notFound();
  const [t, locale, standing, post] = await Promise.all([getT(), getLocale(), getStanding(), getPost(postId)]);
  if (!standing) redirect(`/auth/sign-in?next=/post/${postId}/edit`);
  // The database re-checks ownership; this only avoids showing a useless form.
  if (!post || !post.is_mine || (post.status !== 'visible' && post.status !== 'collapsed')) notFound();

  return (
    <div className="page">
      <main id="main" className="narrow">
        <h1 className="mb16" tabIndex={-1}>{t('post.edit')}</h1>
        <PostForm
          labels={pick(t, POST_FORM_LABEL_KEYS)}
          locale={locale}
          canPostLinks={standing.capabilities.post_link === null}
          zones={[]}
          cities={[]}
          categories={[]}
          edit={{ postId: post.id, title: post.title, body: post.body, link: post.link_url, type: post.post_type }}
        />
      </main>
    </div>
  );
}
