import { MEMBER_REPORT_REASONS } from '@pepforum/database';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PostCard } from '@/components/post/PostCard';
import { ReportMemberForm } from '@/components/profile/ReportMemberForm';
import { Avatar, TierBadge } from '@/components/ui/Bits';
import { formatDate } from '@/lib/format';
import { type MessageKey, pick } from '@/lib/i18n';
import { USERNAME_PATTERN } from '@/lib/validation';
import { getLocale, getStanding, getT } from '@/server/context';
import { getFeed, getProfile, getTaxonomy } from '@/server/queries';

const REPORT_MEMBER_LABEL_KEYS = [
  'memberReport.open', 'memberReport.intro', 'memberReport.reason', 'memberReport.details', 'memberReport.detailsHint', 'memberReport.submit',
  ...MEMBER_REPORT_REASONS.map((r) => `memberReport.reason.${r}` as const),
] satisfies MessageKey[];

interface Props {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `u/${username}` };
}

export default async function ProfilePage({ params }: Props) {
  const { username } = await params;
  if (!USERNAME_PATTERN.test(username) && !/^deleted_[0-9a-f]{10}$/.test(username)) notFound();
  const [t, locale, standing, taxonomy, profile] = await Promise.all([getT(), getLocale(), getStanding(), getTaxonomy(), getProfile(username)]);
  if (!profile) notFound();
  const posts = profile.deleted ? [] : await getFeed({ author: profile.username, sort: 'new' });

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="card card-p mb16">
          <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
            <Avatar name={profile.username} size="lg" />
            <div className="grow">
              <div className="row wrap">
                <h1 tabIndex={-1}>u/{profile.username}</h1>
                <TierBadge tier={profile.tier} t={t} />
                <span className="pill">{t(`tier.${profile.tier}` as MessageKey)}</span>
                {profile.is_admin ? <span className="pill blue">{t('profile.admin')}</span> : null}
              </div>
              <p className="small muted">{t('profile.joined', { date: formatDate(profile.joined_at, locale) })}</p>
              {profile.deleted ? <p className="mt8">{t('profile.deleted')}</p> : null}
              {profile.bio ? <p className="mt8">{profile.bio}</p> : null}
              {profile.coi ? <p className="small mt8"><b>{t('profile.coi')}:</b> {profile.coi}</p> : null}
              {profile.moderates.length ? <p className="small mt8 pill blue">{t('profile.moderates', { zones: profile.moderates.join(', ') })}</p> : null}
            </div>
            {standing && !profile.is_me && !profile.deleted ? (
              <div className="actions" style={{ flex: 'none', marginTop: 0 }}>
                <ReportMemberForm username={profile.username} labels={pick(t, REPORT_MEMBER_LABEL_KEYS)} />
              </div>
            ) : null}
          </div>
          <div className="stats mt16">
            <div className="stat"><div className="v">{profile.karma.toLocaleString()}</div><div className="l">{t('standing.karma')}</div></div>
            {/* Moderation-track numbers are private (they'd unmask note writers); shown to the owner only. */}
            {profile.is_me && profile.mod_xp !== null ? (
              <>
                <div className="stat"><div className="v">{Number(profile.mod_xp).toLocaleString()}</div><div className="l">{t('standing.modXp')}</div></div>
                <div className="stat"><div className="v">{profile.rater_impact}</div><div className="l">{t('standing.raterImpact')}</div></div>
                <div className="stat"><div className="v">{profile.writer_impact}</div><div className="l">{t('standing.writerImpact')}</div></div>
              </>
            ) : null}
          </div>
          {profile.is_me && profile.rater_status ? (
            <p className="xs faint mt8">{t('standing.raterStatus')}: {t(`standing.rater.${profile.rater_status}` as MessageKey)}</p>
          ) : null}
        </div>

        <h2 className="mb12">{t('profile.posts')} ({profile.post_count})</h2>
        <div className="feed">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} t={t} locale={locale} taxonomy={taxonomy} signedIn={Boolean(standing)} viewerUsername={standing?.username}
              canWriteNotes={standing?.capabilities.write_notes === null} />
          ))}
        </div>
      </main>
    </div>
  );
}
