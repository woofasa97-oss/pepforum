import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PostImages } from '@/components/media/PostImages';
import { NoteCard } from '@/components/notes/NoteCard';
import { CommentForm } from '@/components/post/CommentForm';
import { CommentTree } from '@/components/post/CommentTree';
import { PostCard } from '@/components/post/PostCard';
import { JsonLd } from '@/components/site/JsonLd';
import { Icon } from '@/components/ui/Icon';
import { describeRequirement } from '@/lib/errors';
import { isUuid } from '@/lib/params';
import { discussionJsonLd } from '@/lib/seo';
import { deletePostAction } from '@/server/actions/content';
import { getLocale, getStanding, getT } from '@/server/context';
import { getComments, getPost, getPostMedia, getPostNotes, getTaxonomy } from '@/server/queries';

interface Props {
  params: Promise<{ postId: string }>;
  searchParams: Promise<{ images?: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { postId } = await params;
  if (!isUuid(postId)) return {};
  const post = await getPost(postId);
  if (!post) return {};
  const indexable = post.status === 'visible' || post.status === 'collapsed';
  return {
    title: post.title,
    description: post.body.slice(0, 160),
    alternates: { canonical: `/post/${post.id}` },
    robots: { index: indexable, follow: indexable },
    openGraph: { type: 'article', title: post.title, description: post.body.slice(0, 160), url: `/post/${post.id}`, publishedTime: post.created_at },
  };
}

const MEDICAL_CATEGORIES = new Set(['weight', 'clinician', 'recovery']);

export default async function PostPage({ params, searchParams }: Props) {
  const [{ postId }, { images: imagesNotice }] = await Promise.all([params, searchParams]);
  if (!isUuid(postId)) notFound();

  const [t, locale, standing, taxonomy, post] = await Promise.all([getT(), getLocale(), getStanding(), getTaxonomy(), getPost(postId)]);
  if (!post) notFound();
  const [notes, comments, images] = await Promise.all([getPostNotes(post.id), getComments(post.id), getPostMedia(post.id)]);
  const signedIn = Boolean(standing);
  const canWriteNotes = standing?.capabilities.write_notes === null && !post.is_mine;

  return (
    <div className="page">
      <div className="grid2">
        <main id="main" className="feed">
          {post.status === 'visible' || post.status === 'collapsed' ? <JsonLd data={discussionJsonLd(post)} /> : null}
          {imagesNotice && post.is_mine ? (
            <div className="banner warn"><Icon name="alert" /><div>{t(imagesNotice === 'too_many' ? 'media.tooMany' : 'media.attachFailed')} <Link className="link" href={`/post/${post.id}/edit`}>{t('post.edit')}</Link></div></div>
          ) : null}
          <PostCard post={post} t={t} locale={locale} taxonomy={taxonomy} signedIn={signedIn} canWriteNotes={canWriteNotes} full
            images={<PostImages images={images} caption={t('media.gallery', { n: images.length })} />} />

          {notes.map((note) => <NoteCard key={note.id} note={note} t={t} />)}

          {MEDICAL_CATEGORIES.has(post.category_id) ? (
            <div className="banner warn"><Icon name="alert" /><div>{t('post.medicalBanner')}</div></div>
          ) : null}

          {post.is_mine && post.status !== 'deleted' ? (
            <details className="card card-p">
              <summary className="small bold" style={{ cursor: 'pointer' }}>{t('post.delete')}</summary>
              <form action={deletePostAction} className="mt8">
                <p className="small muted mb8">{t('post.deleteConfirm')}</p>
                <input type="hidden" name="postId" value={post.id} />
                <button type="submit" className="btn danger sm">{t('post.delete')}</button>
              </form>
            </details>
          ) : null}

          <section className="card card-p" id="comments" aria-label={t('post.comments', { n: post.comment_count })}>
            <h2>{t('post.comments', { n: post.comment_count })}</h2>
            {post.comments_locked ? (
              <div className="banner mt8"><Icon name="lock" /><div>{t('comment.locked')}</div></div>
            ) : signedIn ? (
              <CommentForm postId={post.id} labels={{ placeholder: t('comment.add'), submit: t('comment.post'), hint: t('comment.rules') }} />
            ) : (
              <div className="banner mt8"><Icon name="lock" /><div>{t('comment.signIn')} <Link className="link" href={`/auth/sign-in?next=/post/${post.id}`}>{t('nav.signIn')}</Link></div></div>
            )}
            <CommentTree comments={comments} postId={post.id} t={t} signedIn={signedIn} />
          </section>
        </main>

        <aside className="rail right">
          <div className="card card-p">
            <h2 className="row" style={{ fontSize: 15 }}><Icon name="note" />{t('notes.whatIs')}</h2>
            <p className="small muted mt8">{t('notes.explain')}</p>
            {canWriteNotes ? (
              <Link className="btn sm mt12" href={`/post/${post.id}/note/new`}>{t('post.suggestNote')}</Link>
            ) : standing ? (
              <p className="xs faint mt12">{t('cap.write_notes')}: {describeRequirement(standing.capabilities.write_notes, t)}</p>
            ) : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
