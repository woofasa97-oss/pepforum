import type { FeedRow, PostDetailRow } from '@pepforum/database';
import { REPORT_REASONS } from '@pepforum/database';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ClinicianBadge } from '@/components/clinician/ClinicianBadge';
import { Avatar, TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { relativeTime, removalReasonLabel } from '@/lib/format';
import { type MessageKey, type Translate, pick } from '@/lib/i18n';
import type { Taxonomy } from '@/server/queries';

import { ReportForm } from './ReportForm';
import { VoteButtons } from './VoteButtons';

type Post = (FeedRow & { body?: undefined }) | PostDetailRow;

interface Props {
  readonly post: Post;
  readonly t: Translate;
  readonly locale: 'en' | 'fr';
  readonly taxonomy: Taxonomy;
  readonly signedIn: boolean;
  /** The viewer's username, so feed rows (which carry no is_mine flag) can hide self-actions. */
  readonly viewerUsername?: string | undefined;
  readonly canWriteNotes?: boolean;
  readonly full?: boolean;
  /** Attached images (…023), rendered by the post page under the body. */
  readonly images?: ReactNode;
}

export const REPORT_LABEL_KEYS = [
  'post.report', 'report.reason', 'report.details', 'report.submit',
  ...REPORT_REASONS.map((r) => `report.reason.${r}` as const),
] satisfies MessageKey[];

export function PostCard({ post, t, locale, taxonomy, signedIn, viewerUsername, canWriteNotes = false, full = false, images }: Props) {
  const category = taxonomy.categories.find((c) => c.id === post.category_id);
  const zone = taxonomy.zones.find((z) => z.id === post.zone_id);
  const city = post.city_id ? taxonomy.cities.find((c) => c.id === post.city_id) : undefined;
  const body = 'body' in post && post.body !== undefined ? post.body : (post as FeedRow).excerpt;
  const Heading = full ? 'h1' : 'h2';
  // Display only: the database rejects self-votes, self-reports and self-notes regardless.
  const isMine = ('is_mine' in post && post.is_mine) || (viewerUsername !== undefined && post.author_username === viewerUsername);

  return (
    <article className={`post ${full ? 'post-full' : ''} ${post.status === 'collapsed' ? 'collapsed' : ''}`} aria-labelledby={`pt-${post.id}`}>
      <VoteButtons
        kind="post"
        targetId={post.id}
        score={post.score}
        myVote={post.my_vote}
        canVote={signedIn && !isMine}
        signInHref={`/auth/sign-in?next=/post/${post.id}`}
        labels={{ up: t('post.upvote'), down: t('post.downvote'), signIn: t('errors.signInRequired'), score: t('post.score') }}
      />
      <div className="post-b">
        <div className="meta">
          <span className="pill">{t(`post.type.${post.post_type}` as MessageKey)}</span>
          {category ? (
            <Link className="pill" href={`/category/${category.id}`}>
              {locale === 'fr' ? category.name_fr : category.name_en}
            </Link>
          ) : null}
          {zone && taxonomy.regions ? (
            <Link className="pill zone" href={zone.id === 'national' ? '/' : `/zone/${zone.id}`}>
              {locale === 'fr' ? zone.name_fr : zone.name_en}
              {city ? ` · ${city.name}` : ''}
            </Link>
          ) : null}
          <span className="sep" />
          <Link href={`/u/${post.author_username}`} className="bold author">
            <Avatar name={post.author_username} size="sm" src={post.author_avatar ?? null} />
            {t('post.by', { user: post.author_username })}
          </Link>
          <TierBadge tier={post.author_tier} t={t} />
          {'author_clinician' in post ? <ClinicianBadge profession={post.author_clinician} t={t} /> : null}
          <span className="sep" />
          <time dateTime={post.created_at}>{relativeTime(post.created_at, t)}</time>
          {post.edited_at ? <span className="xs">· {t('post.edited')}</span> : null}
          {post.pinned ? <span className="pill blue"><Icon name="pin" />{t('post.pinned')}</span> : null}
          {'has_helpful_note' in post && post.has_helpful_note ? <span className="pill green"><Icon name="note" />{t('post.hasHelpfulNote')}</span> : null}
          {'has_open_note' in post && post.has_open_note && !post.has_helpful_note ? <span className="pill amber">{t('post.hasOpenNote')}</span> : null}
        </div>

        <Heading className="post-t" id={`pt-${post.id}`}>
          {full ? post.title : <Link href={`/post/${post.id}`}>{post.title}</Link>}
        </Heading>

        {post.status === 'held' ? (
          <div className="banner warn mt8 mb8"><Icon name="shield" />{t('post.held')}</div>
        ) : null}
        {post.status === 'collapsed' ? (
          <div className="banner warn mt8 mb8"><Icon name="alert" />{t('post.collapsed')}</div>
        ) : null}
        {post.status === 'removed' && 'removal_reason' in post ? (
          <div className="banner danger mt8 mb8"><Icon name="shield" />{t('post.removed', { reason: removalReasonLabel(post.removal_reason, t) })}</div>
        ) : null}

        {body ? <p className={`post-x ${full ? '' : 'clamp'}`}>{body}</p> : null}
        {images}

        {post.link_url ? (
          <a className="linkcard" href={post.link_url} target="_blank" rel="nofollow ugc noopener noreferrer">
            <Icon name="link" />
            <span className="grow">{post.link_url}</span>
            <span className="xs faint">{t('post.linkWarning')}</span>
            <Icon name="external" />
          </a>
        ) : null}

        <div className="actions">
          <Link href={`/post/${post.id}#comments`}>
            <Icon name="comment" />
            {t('post.comments', { n: post.comment_count })}
          </Link>
          {signedIn && !isMine && post.status !== 'removed' ? (
            <ReportForm kind="post" targetId={post.id} labels={pick(t, REPORT_LABEL_KEYS)} />
          ) : null}
          {canWriteNotes && !isMine ? (
            <Link href={`/post/${post.id}/note/new`}>
              <Icon name="note" />
              {t('post.suggestNote')}
            </Link>
          ) : null}
          {full && isMine ? (
            <Link href={`/post/${post.id}/edit`}>
              <Icon name="edit" />
              {t('post.edit')}
            </Link>
          ) : null}
        </div>
      </div>
    </article>
  );
}
