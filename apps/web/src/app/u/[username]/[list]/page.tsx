import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Avatar, EmptyState, TierBadge } from '@/components/ui/Bits';
import { USERNAME_PATTERN } from '@/lib/validation';
import { getT } from '@/server/context';
import { getFollows } from '@/server/queries';

const LISTS = ['followers', 'following'] as const;

interface Props {
  params: Promise<{ username: string; list: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username, list } = await params;
  return { title: `u/${username} · ${list}`, robots: { index: false } };
}

/** /u/<name>/followers and /u/<name>/following (…027). */
export default async function FollowListPage({ params }: Props) {
  const { username, list } = await params;
  const kind = LISTS.find((l) => l === list);
  if (!kind || !USERNAME_PATTERN.test(username)) notFound();
  const [t, rows] = await Promise.all([getT(), getFollows(username, kind)]);
  if (!rows) notFound();
  const base = `/u/${encodeURIComponent(username)}`;

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="small mb8"><Link className="link" href={base}>← u/{username}</Link></p>
        <h1 className="mb12" tabIndex={-1}>{kind === 'followers' ? t('profile.followersOf', { user: username }) : t('profile.followingBy', { user: username })}</h1>
        <nav className="tabs" aria-label={t('profile.follows')}>
          <Link href={`${base}/followers`} aria-current={kind === 'followers' ? 'page' : undefined}>{t('profile.followersTab')}</Link>
          <Link href={`${base}/following`} aria-current={kind === 'following' ? 'page' : undefined}>{t('profile.followingTab')}</Link>
        </nav>
        <div className="card">
          {rows.length === 0 ? (
            <EmptyState title={kind === 'followers' ? t('profile.noFollowers') : t('profile.noFollowing')} />
          ) : (
            <ul className="ticket-list">
              {rows.map((r) => (
                <li key={r.username}>
                  <Link href={`/u/${encodeURIComponent(r.username)}`} className="row" style={{ display: 'flex', gap: 10 }}>
                    <Avatar name={r.username} src={r.avatar} />
                    <b>u/{r.username}</b>
                    <TierBadge tier={r.tier} t={t} />
                    {r.friend ? <span className="pill green">{t('profile.friends')}</span> : null}
                    {r.is_me ? <span className="pill">{t('admin.team.you')}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
