import type { Metadata } from 'next';
import Link from 'next/link';

import { NoteCard } from '@/components/notes/NoteCard';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { describeRequirement } from '@/lib/errors';
import { nextNoteAction } from '@/server/actions/notes';
import { getStanding, getT } from '@/server/context';
import { listNotes } from '@/server/queries';

export const metadata: Metadata = { title: 'Community notes' };

const TABS = ['needs_ratings', 'helpful', 'not_helpful', 'mine'] as const;
type Tab = (typeof TABS)[number];

export default async function NotesPage({ searchParams }: { searchParams: Promise<{ tab?: string; queue?: string; error?: string }> }) {
  const [t, standing, params] = await Promise.all([getT(), getStanding(), searchParams]);
  const tab: Tab = (TABS as readonly string[]).includes(params.tab ?? '') ? (params.tab as Tab) : 'helpful';
  const notes = tab === 'mine' && !standing ? [] : await listNotes(tab);
  const rateBlocked = standing ? standing.capabilities.rate_notes : 'not_authenticated';
  // `error` carries a capability reason from nextNoteAction ("rate_notes:tier:2").
  const queueError = params.error ? params.error.split(':').slice(1).join(':') : null;

  return (
    <div className="page">
      <div className="grid2">
        <main id="main">
          <div className="page-h">
            <div>
              <h1 tabIndex={-1}>{t('notes.title')}</h1>
              <p>{t('notes.sub')}</p>
            </div>
            {rateBlocked ? null : (
              <form action={nextNoteAction}>
                <SubmitButton className="btn dark"><Icon name="note" />{t('notes.startRating')}</SubmitButton>
              </form>
            )}
          </div>

          {params.queue === 'empty' ? <div className="banner ok mb12" role="status">{t('notes.queueEmpty')}</div> : null}
          {queueError ? <div className="banner warn mb12" role="alert">{describeRequirement(queueError, t)}</div> : null}
          {rateBlocked ? (
            <div className="banner mb12"><Icon name="lock" /><div>{t('cap.rate_notes')}: {describeRequirement(rateBlocked, t)}</div></div>
          ) : null}

          <nav className="tabs" aria-label={t('notes.title')}>
            {TABS.filter((x) => x !== 'mine' || standing).map((x) => (
              <Link key={x} href={`/notes?tab=${x}`} aria-current={tab === x ? 'page' : undefined}>{t(`notes.tab.${x}`)}</Link>
            ))}
          </nav>

          <div className="feed">
            {notes.length === 0 ? <div className="card"><EmptyState title={t('feed.empty')} /></div> : null}
            {notes.map((note) => <NoteCard key={note.id} note={note} t={t} />)}
          </div>
        </main>

        <aside className="rail right">
          <div className="card card-p">
            <h2 className="row" style={{ fontSize: 15 }}><Icon name="info" />{t('notes.whatIs')}</h2>
            <p className="small muted mt8">{t('notes.explain')}</p>
            <Link className="link small mt8" style={{ display: 'inline-block' }} href="/legal/community-notes">{t('footer.howNotes')}</Link>
          </div>
          <div className="card card-p">
            <h2 style={{ fontSize: 15 }}>{t('standing.howEarned')}</h2>
            <p className="small muted mt8">{t('rate.private')}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
