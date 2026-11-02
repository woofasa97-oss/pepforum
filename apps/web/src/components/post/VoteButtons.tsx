'use client';

import { useOptimistic, useState, useTransition } from 'react';

import { Icon } from '@/components/ui/Icon';
import { voteAction } from '@/server/actions/content';

interface Props {
  readonly kind: 'post' | 'comment';
  readonly targetId: string;
  readonly score: number;
  readonly myVote: -1 | 1 | null;
  readonly canVote: boolean;
  readonly labels: { up: string; down: string; signIn: string; score: string };
  readonly layout?: 'column' | 'row';
  /** Where anonymous visitors go when they try to vote. */
  readonly signInHref?: string;
}

/**
 * Optimistic voting. The server is authoritative: if the action fails, the
 * optimistic state is discarded and the error is announced.
 */
export function VoteButtons({ kind, targetId, score, myVote, canVote, labels, layout = 'column', signInHref = '/auth/sign-in' }: Props) {
  const [state, setState] = useState({ score, vote: myVote ?? 0 });
  const [optimistic, setOptimistic] = useOptimistic(state);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const cast = (direction: 1 | -1) => {
    const next = optimistic.vote === direction ? 0 : direction;
    const nextScore = optimistic.score - optimistic.vote + next;
    setError(null);
    startTransition(async () => {
      setOptimistic({ score: nextScore, vote: next });
      const result = await voteAction(kind, targetId, next);
      if (result.ok) setState({ score: result.score ?? nextScore, vote: next });
      else setError(result.message ?? null);
    });
  };

  if (!canVote) {
    const anon = (
      <>
        <a href={signInHref} className="vote-link" aria-label={`${labels.up} (${labels.signIn})`}><Icon name="up" /></a>
        <span className="n">{score}</span>
        <a href={signInHref} className="vote-link" aria-label={`${labels.down} (${labels.signIn})`}><Icon name="down" /></a>
      </>
    );
    return layout === 'column' ? <div className="vote">{anon}</div> : <div className="row vote-row">{anon}</div>;
  }

  const body = (
    <>
      <button type="button" className="up" aria-pressed={optimistic.vote === 1} aria-label={labels.up} disabled={pending} onClick={() => cast(1)}>
        <Icon name="up" />
      </button>
      <span className="n" aria-label={labels.score.replace('{n}', String(optimistic.score))}>
        {optimistic.score}
      </span>
      <button type="button" className="down" aria-pressed={optimistic.vote === -1} aria-label={labels.down} disabled={pending} onClick={() => cast(-1)}>
        <Icon name="down" />
      </button>
      {error ? (
        <span className="vh" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );

  return layout === 'column' ? (
    <div className="vote" title={error ?? undefined}>
      {body}
    </div>
  ) : (
    <div className="row vote-row" title={error ?? undefined}>
      {body}
      {error ? <span className="xs err-msg">{error}</span> : null}
    </div>
  );
}
