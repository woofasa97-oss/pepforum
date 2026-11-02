import type { NoteView } from '@pepforum/database';
import Link from 'next/link';

import { Progress } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import type { MessageKey, Translate } from '@/lib/i18n';

const STATUS_TITLE: Record<NoteView['status'], MessageKey> = {
  helpful: 'notes.readersAdded',
  needs_more_ratings: 'notes.proposed',
  not_helpful: 'notes.notHelpful',
};

const STATUS_PILL: Record<NoteView['status'], string> = { helpful: 'green', needs_more_ratings: 'amber', not_helpful: '' };

export function SourceList({ sources }: { sources: NoteView['sources'] }) {
  return (
    <div className="sources">
      {sources.map((source) => (
        <a key={source.url} href={source.url} target="_blank" rel="nofollow ugc noopener noreferrer">
          <span className={`srcbadge ${source.kind}`}>{source.kind}</span>
          <span className="u grow">{source.url}</span>
          <Icon name="external" />
        </a>
      ))}
    </div>
  );
}

/** A note as shown under a post or in the notes hub. */
export function NoteCard({ note, t, linkToDetail = true }: { note: NoteView; t: Translate; linkToDetail?: boolean }) {
  return (
    <section className={`note ${note.status}`} aria-label={t(STATUS_TITLE[note.status])}>
      <div className="note-h">
        <span className="t">
          <Icon name="note" />
          {t(STATUS_TITLE[note.status])}
        </span>
        <span className="row">
          <span className="pill">{t(`notes.classification.${note.classification}` as MessageKey)}</span>
          <span className={`pill ${STATUS_PILL[note.status]}`}>{t(`notes.status.${note.status}` as MessageKey)}</span>
          {note.locked ? <span className="pill"><Icon name="lock" />{t('notes.locked')}</span> : null}
        </span>
      </div>
      {note.post_title ? <p className="small faint mb8">{note.post_title}</p> : null}
      <p className="note-x" lang={note.language}>{note.body}</p>
      <SourceList sources={note.sources} />
      {note.status === 'needs_more_ratings' && !note.locked ? (
        <div className="mt8">
          <Progress value={note.rating_count} max={note.min_ratings} tone="amber" label={t('notes.ratings', { n: note.rating_count, min: note.min_ratings })} />
        </div>
      ) : null}
      <div className="note-f">
        <span>
          {note.is_mine ? t('notes.yours') : t('notes.by', { alias: note.author_alias })} · {t('notes.ratings', { n: note.rating_count, min: note.min_ratings })}
          {note.post_corrected ? <> · <span className="pill green">{t('notes.corrected')}</span></> : null}
        </span>
        {linkToDetail ? (
          <Link className="btn sm" href={`/notes/${note.id}`}>
            {note.my_rating || note.locked || note.is_mine ? t('notes.history') : t('rate.title')}
          </Link>
        ) : null}
      </div>
    </section>
  );
}
