import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, Facts, PageHeader } from '@/components/admin/AdminBits';
import { TicketReplyForm } from '@/components/support/TicketReplyForm';
import { TicketThread } from '@/components/support/TicketThread';
import { TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { TICKET_KIND_ICONS, ticketTone } from '@/lib/tickets';
import { adminReplyTicketAction, adminSetTicketClosedAction } from '@/server/actions/admin';
import { adminTicket } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Ticket' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [t, locale, result] = await Promise.all([getT(), getLocale(), adminTicket(id)]);
  const back = <p className="small mb8"><Link className="link" href="/admin/inbox">← {t('admin.inbox.title')}</Link></p>;
  if (!result.ok) return <>{back}<DataUnavailable result={result} t={t} /></>;
  const ticket = result.data;
  if (!ticket) notFound();
  const m = ticket.member;
  const closed = ticket.status === 'closed';
  const people = (username: string) => `/admin/people/${encodeURIComponent(username)}`;

  return (
    <>
      {back}
      <PageHeader title={ticket.subject} sub={`${t(`contact.kind.${ticket.kind}` as MessageKey)} · ${t('contact.opened', { date: formatDate(ticket.created_at, locale) })}`}>
        <span className={`pill ${ticketTone(ticket.status, 'admin')}`}>{t(`admin.inbox.status.${ticket.status}` as MessageKey)}</span>
      </PageHeader>

      <div className="grid2">
        <div>
          <TicketThread t={t} locale={locale} label={t('contact.thread')}
            messages={ticket.messages.map((x) => ({
              id: x.id, who: x.from_staff ? t('admin.inbox.staffWho', { user: x.author }) : `u/${x.author}`,
              fromStaff: x.from_staff, body: x.body, createdAt: x.created_at,
            }))} />

          <div className="mt16">
            {closed ? (
              <div className="banner mb12">
                <Icon name="lock" />
                <div>
                  {ticket.closed_by_member
                    ? t('admin.inbox.closedByMember', { date: ticket.closed_at ? formatDate(ticket.closed_at, locale) : '' })
                    : t('admin.inbox.closedBy', { user: ticket.closed_by ?? '—', date: ticket.closed_at ? formatDate(ticket.closed_at, locale) : '' })}
                </div>
              </div>
            ) : null}
            {ticket.is_self ? (
              <div className="banner warn"><Icon name="info" /><div>{t('admin.inbox.selfNote')}</div></div>
            ) : (
              <TicketReplyForm action={adminReplyTicketAction} ticketId={ticket.id} key={ticket.messages.length}
                closeLabel={t('admin.inbox.closeAfter')}
                labels={{ label: t('admin.inbox.reply'), submit: t('admin.inbox.send'), hint: closed ? t('admin.inbox.replyClosedHint') : t('admin.inbox.replyHint') }} />
            )}
          </div>
        </div>

        <aside className="card card-p" aria-labelledby="member-h">
          <h2 id="member-h" style={{ fontSize: 16 }} className="mb8">{t('admin.inbox.from')}</h2>
          <p className="row wrap mb12" style={{ gap: 6 }}>
            <Link className="link bold" href={people(m.username)}>u/{m.username}</Link>
            <TierBadge tier={m.tier} t={t} />
            {m.is_admin ? <span className="pill blue">{t('admin.role.admin')}</span> : null}
            {m.sanction ? <span className="pill red">{t(`admin.sanction.${m.sanction}` as MessageKey)}</span> : null}
          </p>
          <Facts rows={[
            [t('standing.karma'), m.karma.toLocaleString()],
            [t('admin.inbox.integrity'), m.integrity],
            [t('admin.inbox.joined'), formatDate(m.joined, locale)],
            [t('admin.inbox.ticketsTotal'), m.tickets],
            [t('admin.inbox.lastActivity'), relativeTime(ticket.last_message_at, t)],
          ]} />
          {ticket.about || ticket.about_url ? (
            <div className="mt12">
              <h3 className="small bold mb8 row" style={{ gap: 6 }}><Icon name={TICKET_KIND_ICONS[ticket.kind]} />{t('admin.inbox.reportedWhat')}</h3>
              {ticket.about ? (
                <p className="small mb8">
                  <Link className="link" href={people(ticket.about)}>u/{ticket.about}</Link>{' · '}
                  <Link className="link" href={`/u/${encodeURIComponent(ticket.about)}`}>{t('admin.inbox.publicProfile')}</Link>
                </p>
              ) : null}
              {ticket.about_url ? (
                <p className="small" style={{ overflowWrap: 'anywhere' }}>
                  <a className="link" href={ticket.about_url} rel="nofollow ugc noopener noreferrer">{ticket.about_url}</a>
                </p>
              ) : null}
            </div>
          ) : null}

          {ticket.is_self ? null : (
            <div className="mt16">
              {closed ? (
                <ActionForm action={adminSetTicketClosedAction} label={t('admin.inbox.reopen')} submit={t('admin.inbox.reopen')} requireReason={false}
                  consequence={t('admin.inbox.reopenHelp')} hidden={{ ticketId: ticket.id, closed: 'false' }} labels={{ reason: t('admin.reasonLabel') }} />
              ) : (
                <ActionForm action={adminSetTicketClosedAction} label={t('admin.inbox.close')} submit={t('admin.inbox.close')} requireReason={false}
                  consequence={t('admin.inbox.closeHelp')} hidden={{ ticketId: ticket.id, closed: 'true' }} labels={{ reason: t('admin.reasonLabel') }} />
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
