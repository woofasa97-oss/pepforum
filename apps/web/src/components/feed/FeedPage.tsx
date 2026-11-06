import Link from 'next/link';

import { AdSlot } from '@/components/ads/AdSlot';
import { NoteCard } from '@/components/notes/NoteCard';
import { PostCard } from '@/components/post/PostCard';
import { StandingCard } from '@/components/standing/StandingCard';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { getLocale, getStanding, getT } from '@/server/context';
import { FEED_PAGE_SIZE, type FeedQuery, getFeed, getTaxonomy, listNotes } from '@/server/queries';

interface Props {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly basePath: string;
  readonly query: FeedQuery;
  readonly hero?: React.ReactNode;
  /** Home and /following show "Everyone · Following" tabs to signed-in members (…029). */
  readonly scope?: 'everyone' | 'following';
}

const SORTS = ['hot', 'new', 'top'] as const;

/** Shared layout for the national, zone and category feeds. */
export async function FeedPage({ title, subtitle, basePath, query, hero, scope }: Props) {
  const [t, locale, standing, taxonomy, posts] = await Promise.all([getT(), getLocale(), getStanding(), getTaxonomy(), getFeed(query)]);
  // Capabilities are null when allowed, otherwise a reason key.
  const canRate = standing?.capabilities.rate_notes === null;
  const openNotes = canRate ? (await listNotes('needs_ratings')).slice(0, 3) : [];
  const sort = query.sort ?? 'hot';
  const page = query.page ?? 0;
  const href = (params: Record<string, string | number>) => {
    const search = new URLSearchParams(Object.entries({ sort, ...params }).map(([k, v]) => [k, String(v)]));
    return `${basePath}?${search.toString()}`;
  };

  return (
    <div className="page">
      {hero}
      <div className="grid3">
        <aside className="rail left" aria-label={t('feed.categories')}>
          <div className="card card-p">
            <h2 className="sec-lbl mb8">{t('feed.categories')}</h2>
            <ul className="sidelist">
              {taxonomy.categories.map((c) => (
                <li key={c.id}>
                  <Link href={`/category/${c.id}`} aria-current={basePath === `/category/${c.id}` ? 'page' : undefined}>
                    {locale === 'fr' ? c.name_fr : c.name_en}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <main id="main">
          <div className="page-h">
            <div>
              <div className="sec-h"><h1 tabIndex={-1}>{title}</h1></div>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
            <nav className="seg" aria-label="Sort">
              {SORTS.map((s) => (
                <Link key={s} href={href({ sort: s })} aria-current={sort === s ? 'page' : undefined}>{t(`feed.sort.${s}`)}</Link>
              ))}
            </nav>
          </div>

          {scope && standing ? (
            <nav className="tabs" aria-label={t('feed.scope')}>
              <Link href="/" aria-current={scope === 'everyone' ? 'page' : undefined}>{t('feed.everyone')}</Link>
              <Link href="/following" aria-current={scope === 'following' ? 'page' : undefined}>{t('feed.following')}</Link>
            </nav>
          ) : null}

          <div className="feed">
            {posts.length === 0 ? (
              <div className="card">
                {scope === 'following' ? (
                  <EmptyState title={t('feed.followingEmpty')}><p className="small mt8">{t('feed.followingEmptyHint')}</p></EmptyState>
                ) : (
                  <EmptyState title={t('feed.empty')}>
                    {standing ? <Link className="btn dark mt12" href="/submit">{t('feed.emptyCta')}</Link> : null}
                  </EmptyState>
                )}
              </div>
            ) : (
              posts.map((post) => (
                <PostCard key={post.id} post={post} t={t} locale={locale} taxonomy={taxonomy} signedIn={Boolean(standing)} viewerUsername={standing?.username}
                  canWriteNotes={standing?.capabilities.write_notes === null} />
              ))
            )}
            {posts.length === FEED_PAGE_SIZE ? (
              <Link className="btn block" href={href({ page: page + 1 })}>{t('feed.more')}</Link>
            ) : null}
          </div>
        </main>

        <aside className="rail right" aria-label={t('standing.title')}>
          <AdSlot pkg={query.category ? 'category' : query.zone ? 'zone' : 'national'} target={query.category ?? query.zone ?? null} />
          {standing ? <StandingCard standing={standing} t={t} /> : (
            <div className="card card-p">
              <p className="bold">{t('app.tagline')}</p>
              <p className="small muted mt8">{t('auth.trust')}</p>
              <Link className="btn dark block mt12" href="/auth/sign-up">{t('nav.signUp')}</Link>
              <Link className="btn block mt8" href="/auth/sign-in">{t('nav.signIn')}</Link>
            </div>
          )}
          {canRate ? (
            <div className="card card-p">
              <h2 className="row" style={{ fontSize: 15 }}><Icon name="note" />{t('notes.title')}</h2>
              <p className="small muted mt8">{t('notes.sub')}</p>
              <Link className="btn dark sm mt12" href="/notes">{t('notes.startRating')}</Link>
            </div>
          ) : null}
          {openNotes.length > 0 ? (
            <div className="card card-p">
              <h2 className="sec-lbl mb8">{t('notes.tab.needs_ratings')}</h2>
              {openNotes.map((n) => <NoteCard key={n.id} note={n} t={t} />)}
            </div>
          ) : null}
          <div className="card card-p">
            <h2 className="row" style={{ fontSize: 15 }}><Icon name="info" />{t('notes.whatIs')}</h2>
            <p className="small muted mt8">{t('notes.explain')}</p>
            <Link className="link small mt8" style={{ display: 'inline-block' }} href="/legal/community-notes">{t('footer.howNotes')}</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
