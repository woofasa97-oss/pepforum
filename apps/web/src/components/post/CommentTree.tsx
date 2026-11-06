import type { CommentRow } from '@pepforum/database';
import Link from 'next/link';

import { ClinicianBadge } from '@/components/clinician/ClinicianBadge';
import { Avatar, TierBadge } from '@/components/ui/Bits';
import { relativeTime } from '@/lib/format';
import { type ThreadNode, buildThread } from '@/lib/thread';
import { type Translate, pick } from '@/lib/i18n';

import { CommentForm } from './CommentForm';
import { REPORT_LABEL_KEYS } from './PostCard';
import { ReportForm } from './ReportForm';
import { VoteButtons } from './VoteButtons';

interface Props {
  readonly comments: readonly CommentRow[];
  readonly postId: string;
  readonly t: Translate;
  readonly signedIn: boolean;
}

export function CommentTree({ comments, postId, t, signedIn }: Props) {
  const renderNode = (node: ThreadNode) => (
    <li key={node.id} className="cmt" id={`c-${node.id}`}>
      <div className="meta">
        {/* Who and when stay on one line; a clinician badge follows and wraps if it must. */}
        <span className="byline">
          <Link href={`/u/${node.author_username}`} className="bold author">
            <Avatar name={node.author_username} size="sm" src={node.author_avatar ?? null} /><span className="who">u/{node.author_username}</span>
          </Link>
          <TierBadge tier={node.author_tier} t={t} />
          {node.is_op ? <span className="badge op">{t('comment.op')}</span> : null}
          <span className="sep" />
          <time dateTime={node.created_at}>{relativeTime(node.created_at, t)}</time>
        </span>
        <ClinicianBadge profession={node.author_clinician} t={t} />
      </div>
      {node.status === 'held' ? <p className="xs" style={{ color: 'var(--amber)' }}>{t('comment.held')}</p> : null}
      <p className="cmt-x">{node.status === 'deleted' ? t('comment.deleted') : node.body}</p>
      {node.status === 'visible' || node.status === 'collapsed' ? (
        <div className="actions">
          <VoteButtons
            kind="comment"
            targetId={node.id}
            score={node.score}
            myVote={node.my_vote}
            canVote={signedIn && !node.is_mine}
            layout="row"
            signInHref={`/auth/sign-in?next=/post/${postId}`}
            labels={{ up: t('post.upvote'), down: t('post.downvote'), signIn: t('errors.signInRequired'), score: t('post.score') }}
          />
          {signedIn && node.depth < 6 ? (
            <details className="popover">
              <summary>{t('comment.reply')}</summary>
              <div className="popover-body">
                <CommentForm postId={postId} parentId={node.id} labels={{ placeholder: t('comment.add'), submit: t('comment.reply') }} />
              </div>
            </details>
          ) : null}
          {signedIn && !node.is_mine ? <ReportForm kind="comment" targetId={node.id} labels={pick(t, REPORT_LABEL_KEYS)} /> : null}
        </div>
      ) : null}
      {node.children.length > 0 ? <ul className="children">{node.children.map(renderNode)}</ul> : null}
    </li>
  );

  return <ul className="comments">{buildThread(comments).map(renderNode)}</ul>;
}
