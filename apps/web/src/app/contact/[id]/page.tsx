import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { TicketReplyForm } from '@/components/support/TicketReplyForm';
import { TicketThread } from '@/components/support/TicketThread';
import { Icon } from '@/components/ui/Icon';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { formatDate } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { ticketTone } from '@/lib/tickets';
import { closeMyTicketAction, replyTicketAction } from '@/server/actions/support';
import { getLocale, getT, getViewer } from '@/server/context';
import { getMyTicket } from '@/server/queries';

export const metadata: Metadata = { title: 'Your ticket', robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function TicketPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!(await getViewer())) redirect(`/auth/sign-in?next=${encodeURIComponent(`/contact/${id}`)}`);
  if (!UUID.test(id)) notFound();
  const [t, locale, ticket] = await Promise.all([getT(), getLocale(), getMyTicket(id)]);
  if (!ticket) notFound();
  const closed = ticket.status === 'closed';

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="small mb8"><Link className="link" href="/contact">← {t('contact.title')}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1} style={{ overflowWrap: 'anywhere' }}>{ticket.subject}</h1>
            <p className="row wrap" style={{ gap: 6 }}>
              <span className={`pill ${ticketTone(ticket.status, 'member')}`}>{t(`contact.status.${ticket.status}` as MessageKey)}</span>
              <span className="small muted">{t(`contact.kind.${ticket.kind}` as MessageKey)} · {t('contact.opened', { date: formatDate(ticket.created_at, locale) })}</span>
            </p>
          </div>
        </div>

        {query.sent ? <div className="banner ok mb12" role="status"><Icon name="check" /><div>{t('contact.sent')}</div></div> : null}

        {ticket.about_username || ticket.about_url ? (
          <div className="card card-p mb12 small">
            {ticket.about_username ? (
              <p>{t('contact.about')} <Link className="link" href={`/u/${encodeURIComponent(ticket.about_username)}`}>u/{ticket.about_username}</Link></p>
            ) : null}
            {ticket.about_url ? (
              <p style={{ overflowWrap: 'anywhere' }}>
                {t('contact.link')} <a className="link" href={ticket.about_url} rel="nofollow ugc noopener noreferrer">{ticket.about_url}</a>
              </p>
            ) : null}
          </div>
        ) : null}

        <TicketThread t={t} locale={locale} label={t('contact.thread')}
          messages={ticket.messages.map((m) => ({
            id: m.id, who: m.from_staff ? t('contact.team') : t('contact.you'), fromStaff: m.from_staff, body: m.body, createdAt: m.created_at,
          }))} />

        <div className="mt16">
          {closed ? (
            <div className="banner">
              <Icon name="lock" />
              <div>
                {ticket.closed_by_team
                  ? t('contact.closedByTeam', { date: ticket.closed_at ? formatDate(ticket.closed_at, locale) : '' })
                  : t('contact.closedByYou', { date: ticket.closed_at ? formatDate(ticket.closed_at, locale) : '' })}{' '}
                <Link className="link" href="/contact">{t('contact.openAnother')}</Link>
              </div>
            </div>
          ) : (
            <>
              <TicketReplyForm action={replyTicketAction} ticketId={ticket.id} key={ticket.messages.length}
                labels={{ label: t('contact.reply'), submit: t('contact.replySubmit'), hint: t('contact.replyHint') }} />
              <form action={closeMyTicketAction} className="row mt8" style={{ justifyContent: 'flex-end' }}>
                <input type="hidden" name="ticketId" value={ticket.id} />
                <SubmitButton className="btn sm">{t('contact.close')}</SubmitButton>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
