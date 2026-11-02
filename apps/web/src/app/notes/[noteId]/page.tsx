import { RATING_REASONS, RATING_VALUES } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NoteCard } from '@/components/notes/NoteCard';
import { RatingForm } from '@/components/notes/RatingForm';
import { Icon } from '@/components/ui/Icon';
import { describeRequirement } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import { type MessageKey, pick } from '@/lib/i18n';
import { isUuid } from '@/lib/params';
import { getLocale, getStanding, getT } from '@/server/context';
import { getNote } from '@/server/queries';

export const metadata: Metadata = { title: 'Community note' };

const RATING_LABEL_KEYS = [
  'rate.title', 'rate.why', 'rate.submit', 'rate.private',
  ...RATING_VALUES.map((v) => `rate.${v}` as const),
  ...Object.values(RATING_REASONS).flat().map((r) => `rate.reason.${r}` as const),
] satisfies MessageKey[];

export default async function NotePage({ params }: { params: Promise<{ noteId: string }> }) {
  const { noteId } = await params;
  if (!isUuid(noteId)) notFound();
  const [t, locale, standing, note] = await Promise.all([getT(), getLocale(), getStanding(), getNote(noteId)]);
  if (!note) notFound();

  return (
    <div className="page">
      <div className="grid2">
        <main id="main" className="feed">
          <div className="card card-p">
            <div className="sec-lbl mb8">{t(`post.type.${note.post.post_type}` as MessageKey)}</div>
            <Link className="bold" href={`/post/${note.post.id}`}>{note.post.title}</Link>
            <p className="small muted mt8 post-x clamp">{note.post.body}</p>
          </div>

          <NoteCard note={note} t={t} linkToDetail={false} />

          {note.breakdown ? (
            <div className="card card-p small">
              {t('notes.breakdown', { h: note.breakdown.helpful, s: note.breakdown.somewhat, n: note.breakdown.not_helpful })}
            </div>
          ) : (
            <div className="banner small"><Icon name="lock" /><div>{t('notes.breakdownHidden')}</div></div>
          )}

          <section className="card card-p" aria-labelledby="rate-h">
            <h2 id="rate-h" className="mb8">{t('rate.title')}</h2>
            <p className="small muted mb12">{t('rate.sub')}</p>
            {note.can_rate ? (
              <RatingForm noteId={note.id} current={note.my_rating} labels={pick(t, RATING_LABEL_KEYS)} />
            ) : note.my_rating ? (
              <p className="small">{t('rate.yourRating', { value: t(`rate.${note.my_rating.value}` as MessageKey) })}</p>
            ) : (
              <div className="banner small">
                <Icon name="lock" />
                <div>
                  {note.locked ? t('errors.note_locked')
                    : note.is_mine ? t('errors.own_note')
                    : note.post.is_mine ? t('errors.own_post')
                    : describeRequirement(standing ? standing.capabilities.rate_notes : 'not_authenticated', t)}
                </div>
              </div>
            )}
          </section>
        </main>

        <aside className="rail right">
          <div className="card card-p">
            <h2 style={{ fontSize: 15 }}>{t('notes.history')}</h2>
            <ol className="ladder mt12">
              {note.history.map((h, i) => (
                <li key={i}>
                  <span className="tier t0">{i + 1}</span>
                  <div>
                    <div className="t">{t(`notes.event.${h.event}` as MessageKey)}{h.to ? ` → ${t(`notes.status.${h.to}` as MessageKey)}` : ''}</div>
                    <div className="d">{formatDate(h.at, locale)}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
