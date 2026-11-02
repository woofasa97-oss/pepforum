import { NOTE_CLASSIFICATIONS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ProposeNoteForm } from '@/components/notes/ProposeNoteForm';
import { Icon } from '@/components/ui/Icon';
import { describeRequirement } from '@/lib/errors';
import { type MessageKey, pick } from '@/lib/i18n';
import { isUuid } from '@/lib/params';
import { getLocale, getStanding, getT } from '@/server/context';
import { getPost } from '@/server/queries';

export const metadata: Metadata = { robots: { index: false } };

const LABEL_KEYS = [
  'propose.classification', 'propose.body', 'propose.bodyHint', 'propose.sources', 'propose.addSource', 'propose.submit',
  'propose.strikeWarning', 'errors.invalid_source_url',
  ...NOTE_CLASSIFICATIONS.map((c) => `notes.classification.${c}` as const),
] satisfies MessageKey[];

export default async function ProposeNotePage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  if (!isUuid(postId)) notFound();
  const [t, locale, standing, post] = await Promise.all([getT(), getLocale(), getStanding(), getPost(postId)]);
  if (!standing) redirect(`/auth/sign-in?next=/post/${postId}/note/new`);
  if (!post || post.status === 'removed' || post.status === 'deleted') notFound();

  const blocked = post.is_mine ? 'own_post' : standing.capabilities.write_notes;

  return (
    <div className="page">
      <main id="main" className="narrow">
        <h1 tabIndex={-1}>{t('propose.title')}</h1>
        <p className="muted mt8 mb16">{t('propose.sub')}</p>
        <div className="card card-p mb12">
          <div className="sec-lbl mb8">{t(`post.type.${post.post_type}` as MessageKey)}</div>
          <Link className="bold" href={`/post/${post.id}`}>{post.title}</Link>
          <p className="small muted mt8 post-x clamp">{post.body}</p>
        </div>
        {blocked ? (
          <div className="banner warn"><Icon name="lock" /><div>{blocked === 'own_post' ? t('errors.own_post') : describeRequirement(blocked, t)}</div></div>
        ) : (
          <div className="card card-p">
            <ProposeNoteForm postId={post.id} locale={locale} labels={pick(t, LABEL_KEYS)} />
          </div>
        )}
      </main>
    </div>
  );
}
