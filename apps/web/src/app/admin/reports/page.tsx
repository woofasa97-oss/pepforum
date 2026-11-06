import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState, TierBadge } from '@/components/ui/Bits';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { resolveMemberReportsAction } from '@/server/actions/admin';
import { adminMemberReports } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Member reports' };

export default async function AdminMemberReportsPage() {
  const [t, locale, result] = await Promise.all([getT(), getLocale(), adminMemberReports()]);
  const header = <PageHeader title={t('admin.reports.title')} sub={t('admin.reports.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const r = result.data;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const reportsOpen = r.open.reduce((sum, ticket) => sum + ticket.reports.length, 0);
  const memberLink = (username: string) => `/admin/people/${encodeURIComponent(username)}`;

  return (
    <>
      {header}

      <div className="stats mb16">
        <div className="stat"><div className="v">{r.open.length}</div><div className="l">{t('admin.reports.open')}</div></div>
        <div className="stat"><div className="v">{reportsOpen}</div><div className="l">{t('admin.reports.reportsOpen')}</div></div>
        <div className="stat"><div className="v">{r.actioned_30d}</div><div className="l">{t('admin.reports.actioned30')}</div></div>
        <div className="stat"><div className="v">{r.dismissed_30d}</div><div className="l">{t('admin.reports.dismissed30')}</div></div>
      </div>

      <section className="admin-section" aria-labelledby="tickets-h">
        <h2 id="tickets-h">{t('admin.reports.waiting')}</h2>
        {r.open.length === 0 ? (
          <div className="card"><EmptyState title={t('admin.reports.none')} /></div>
        ) : (
          <ul className="link-queue">
            {r.open.map((ticket) => {
              const n = ticket.reports.length;
              const reasons = [...new Set(ticket.reports.map((x) => x.reason))];
              return (
                <li key={ticket.username} className="card card-p">
                  <div className="row between wrap mb8" style={{ gap: 8 }}>
                    <span className="row wrap" style={{ gap: 6 }}>
                      <Link className="link bold" href={memberLink(ticket.username)}>u/{ticket.username}</Link>
                      <TierBadge tier={ticket.tier} t={t} />
                      {ticket.is_admin ? <span className="pill blue">{t('admin.role.admin')}</span> : null}
                      {ticket.sanction ? <span className="pill red">{t(`admin.sanction.${ticket.sanction}` as MessageKey)}</span> : null}
                      <span className="pill amber">{t('admin.reports.count', { n })}</span>
                    </span>
                    <span className="xs muted">{t('admin.links.waitingSince', { time: relativeTime(ticket.oldest, t) })}</span>
                  </div>

                  <p className="xs muted mb8">
                    {t('admin.reports.memberFacts', {
                      karma: ticket.karma.toLocaleString(), integrity: ticket.integrity,
                      joined: formatDate(ticket.joined, locale), strikes: ticket.strikes,
                    })}
                    {ticket.actioned_before > 0 ? <> · <b>{t('admin.reports.before', { n: ticket.actioned_before })}</b></> : null}
                  </p>

                  <p className="small mb8">{reasons.map((reason) => t(`memberReport.reason.${reason}` as MessageKey)).join(' · ')}</p>

                  <ul className="ticket-reports mb12">
                    {ticket.reports.map((x) => (
                      <li key={x.id}>
                        <span className="xs muted">
                          <b>{t(`memberReport.reason.${x.reason}` as MessageKey)}</b>
                          {' · '}{t('admin.reports.reportedBy', { user: x.reporter, integrity: x.reporter_integrity, time: relativeTime(x.created_at, t) })}
                        </span>
                        <p className="small">{x.details || <span className="faint">{t('admin.reports.noDetails')}</span>}</p>
                      </li>
                    ))}
                  </ul>

                  {ticket.is_self ? <p className="xs muted">{t('admin.reports.selfNote')}</p> : (
                    <div className="row wrap" style={{ gap: 6, alignItems: 'flex-start' }}>
                      <Link className="btn sm dark" href={memberLink(ticket.username)}>{t('admin.reports.openMember')}</Link>
                      <ActionForm action={resolveMemberReportsAction} label={t('admin.reports.actioned')} submit={t('admin.reports.actioned')}
                        consequence={t('admin.reports.actionedHelp', { n, user: ticket.username })}
                        hidden={{ username: ticket.username, outcome: 'actioned' }} labels={labels}
                        reasons={[t('admin.reports.reasonWarned'), t('admin.reports.reasonSanctioned')]} />
                      <ActionForm action={resolveMemberReportsAction} label={t('admin.reports.dismiss')} submit={t('admin.reports.dismiss')}
                        consequence={t('admin.reports.dismissHelp', { n, user: ticket.username })}
                        hidden={{ username: ticket.username, outcome: 'dismissed' }} labels={labels}
                        reasons={[t('admin.reports.reasonNoBreach'), t('admin.reports.reasonDuplicate')]} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="admin-section card card-p" aria-labelledby="recent-h">
        <h2 id="recent-h" style={{ fontSize: 16 }} className="mb8">{t('admin.reports.recent')}</h2>
        {r.recent.length === 0 ? <EmptyState title={t('admin.reports.noRecent')} /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{t('admin.people.member')}</th>
                  <th scope="col">{t('admin.reports.outcome')}</th>
                  <th scope="col">{t('admin.reason')}</th>
                  <th scope="col">{t('admin.reports.by')}</th>
                </tr>
              </thead>
              <tbody>
                {r.recent.map((x) => (
                  <tr key={`${x.username}-${x.at}`}>
                    <td><Link className="link" href={memberLink(x.username)}>u/{x.username}</Link><span className="xs muted">{t('admin.reports.count', { n: x.reports })}</span></td>
                    <td><span className={`pill ${x.outcome === 'actioned' ? 'green' : ''}`}>{t(`admin.reports.outcome.${x.outcome}` as MessageKey)}</span></td>
                    <td>{x.reason}</td>
                    <td>{x.by ? `u/${x.by}` : '—'}<span className="xs muted">{relativeTime(x.at, t)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
