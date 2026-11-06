import { TICKET_KINDS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { describeRequirement } from '@/lib/errors';
import { relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { TICKET_KIND_ICONS, ticketTone } from '@/lib/tickets';
import { getStanding, getT } from '@/server/context';
import { getMyTickets } from '@/server/queries';

export const metadata: Metadata = { title: 'Contact the team' };

/** Suggestions, reports and questions for the admins, and the member's tickets so far. */
export default async function ContactPage() {
  const [t, standing] = await Promise.all([getT(), getStanding()]);
  const tickets = standing ? await getMyTickets() : [];
  const blocked = standing?.capabilities.report ?? null;

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('contact.title')}</h1>
            <p>{t('contact.sub')}</p>
          </div>
        </div>

        {!standing ? (
          <div className="card card-p">
            <p className="mb12">{t('contact.signIn')}</p>
            <Link className="btn red" href="/auth/sign-in?next=/contact">{t('nav.signIn')}</Link>
          </div>
        ) : (
          <>
            <section aria-labelledby="kinds-h" className="mb16">
              <h2 id="kinds-h" className="mb12">{t('contact.pick')}</h2>
              {blocked ? (
                <div className="banner warn"><Icon name="lock" /><div>{t('contact.blocked', { reason: describeRequirement(blocked, t) })}</div></div>
              ) : (
                <div className="kind-grid">
                  {TICKET_KINDS.map((kind) => (
                    <Link key={kind} className="kind-card" href={`/contact/new?kind=${kind}`}>
                      <Icon name={TICKET_KIND_ICONS[kind]} />
                      <span>
                        <b>{t(`contact.kind.${kind}` as MessageKey)}</b>
                        <span className="small muted">{t(`contact.kindHelp.${kind}` as MessageKey)}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <section aria-labelledby="mine-h">
              <h2 id="mine-h" className="mb12">{t('contact.mine')}</h2>
              <div className="card">
                {tickets.length === 0 ? <EmptyState title={t('contact.none')} /> : (
                  <ul className="ticket-list">
                    {tickets.map((x) => (
                      <li key={x.id}>
                        <Link href={`/contact/${x.id}`}>
                          <span className="row between wrap" style={{ gap: 8 }}>
                            <b>{x.subject}</b>
                            <span className="row wrap" style={{ gap: 6 }}>
                              {x.unread ? <span className="pill red">{t('contact.newReply')}</span> : null}
                              <span className={`pill ${ticketTone(x.status, 'member')}`}>{t(`contact.status.${x.status}` as MessageKey)}</span>
                            </span>
                          </span>
                          <span className="xs muted">
                            {t(`contact.kind.${x.kind}` as MessageKey)} · {t('contact.messages', { n: x.messages })} · {relativeTime(x.last_message_at, t)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </>
        )}
        <p className="xs faint mt16">{t('contact.privacy')}</p>
      </main>
    </div>
  );
}
