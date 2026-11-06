import { TICKET_KINDS, TICKET_STATUSES, type TicketKind, type TicketStatus } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState, TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { TICKET_KIND_ICONS, ticketTone } from '@/lib/tickets';
import { adminTickets } from '@/server/admin';
import { getT } from '@/server/context';

export const metadata: Metadata = { title: 'Inbox' };

export default async function AdminInboxPage({ searchParams }: { searchParams: Promise<{ status?: string; kind?: string }> }) {
  const [t, params] = await Promise.all([getT(), searchParams]);
  const status: TicketStatus = TICKET_STATUSES.find((s) => s === params.status) ?? 'open';
  const kind: TicketKind | null = TICKET_KINDS.find((k) => k === params.kind) ?? null;
  const result = await adminTickets({ p_status: status, p_kind: kind });
  const header = <PageHeader title={t('admin.inbox.title')} sub={t('admin.inbox.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const { tickets, counts, open_by_kind: byKind } = result.data;

  const href = (s: TicketStatus, k: TicketKind | null) => {
    const q = new URLSearchParams();
    if (s !== 'open') q.set('status', s);
    if (k) q.set('kind', k);
    const qs = q.toString();
    return qs ? `/admin/inbox?${qs}` : '/admin/inbox';
  };
  const tabCount: Record<TicketStatus, number> = { open: counts.open, answered: counts.answered, closed: counts.closed_30d };

  return (
    <>
      {header}

      <div className="stats mb16">
        <div className="stat"><div className="v">{counts.open}</div><div className="l">{t('admin.inbox.status.open')}</div></div>
        <div className="stat"><div className="v">{counts.answered}</div><div className="l">{t('admin.inbox.status.answered')}</div></div>
        <div className="stat"><div className="v">{counts.closed_30d}</div><div className="l">{t('admin.inbox.closed30')}</div></div>
      </div>

      <nav className="tabs" aria-label={t('admin.inbox.tabs')}>
        {TICKET_STATUSES.map((s) => (
          <Link key={s} href={href(s, kind)} aria-current={s === status ? 'page' : undefined}>
            {t(`admin.inbox.status.${s}` as MessageKey)} ({tabCount[s]})
          </Link>
        ))}
      </nav>

      <nav className="filters" aria-label={t('admin.inbox.kinds')}>
        <Link className="chip sm" href={href(status, null)} aria-current={kind === null ? 'page' : undefined}>{t('admin.inbox.allKinds')}</Link>
        {TICKET_KINDS.map((k) => (
          <Link key={k} className="chip sm" href={href(status, k)} aria-current={kind === k ? 'page' : undefined}>
            <Icon name={TICKET_KIND_ICONS[k]} />
            {t(`contact.kind.${k}` as MessageKey)}
            {status === 'open' && byKind[k] ? ` (${byKind[k]})` : ''}
          </Link>
        ))}
      </nav>

      {status === 'closed' ? <p className="xs faint mb8">{t('admin.inbox.closedWindow')}</p> : null}

      <div className="card">
        {tickets.length === 0 ? (
          <EmptyState title={status === 'open' ? t('admin.inbox.noneOpen') : t('admin.inbox.none')} />
        ) : (
          <ul className="ticket-list">
            {tickets.map((x) => (
              <li key={x.id}>
                <Link href={`/admin/inbox/${x.id}`}>
                  <span className="row between wrap" style={{ gap: 8 }}>
                    <span className="row wrap" style={{ gap: 6 }}>
                      <Icon name={TICKET_KIND_ICONS[x.kind]} />
                      <b style={{ overflowWrap: 'anywhere' }}>{x.subject}</b>
                    </span>
                    <span className="row wrap" style={{ gap: 6 }}>
                      <span className="pill">{t(`contact.kind.${x.kind}` as MessageKey)}</span>
                      <span className={`pill ${ticketTone(x.status, 'admin')}`}>{t(`admin.inbox.status.${x.status}` as MessageKey)}</span>
                    </span>
                  </span>
                  <span className="small muted" style={{ overflowWrap: 'anywhere' }}>
                    {x.last_from_staff ? `${t('admin.inbox.teamPrefix')} ` : ''}{x.preview}
                  </span>
                  <span className="row wrap xs muted" style={{ gap: 6 }}>
                    <span>u/{x.member}</span>
                    <TierBadge tier={x.member_tier} t={t} />
                    {x.about ? <span>· {t('admin.inbox.about', { user: x.about })}</span> : null}
                    <span>· {t('contact.messages', { n: x.messages })} · {relativeTime(x.last_message_at, t)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
