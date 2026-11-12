import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { QuickAction } from '@/components/admin/QuickAction';
import { EmptyState, TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { formatDate, relativeTime } from '@/lib/format';
import { linkDecisionAction, linkSiteAction } from '@/server/actions/admin';
import { adminLinks } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Links' };

export default async function AdminLinksPage() {
  const [t, locale, result] = await Promise.all([getT(), getLocale(), adminLinks()]);
  const header = <PageHeader title={t('admin.links.title')} sub={t('admin.links.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const l = result.data;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };

  return (
    <>
      {header}

      {l.enabled ? null : (
        <div className="banner warn mb16" role="status">
          <Icon name="info" />
          <div>{t('admin.links.off')} <Link className="link" href="/admin/settings">{t('admin.links.offLink')}</Link></div>
        </div>
      )}

      <div className="stats mb16">
        <div className="stat"><div className="v">{l.pending.length}</div><div className="l">{t('admin.links.waiting')}</div></div>
        <div className="stat"><div className="v">{l.approved_30d}</div><div className="l">{t('admin.links.approved30')}</div></div>
        <div className="stat"><div className="v">{l.declined_30d}</div><div className="l">{t('admin.links.declined30')}</div></div>
      </div>

      {l.sites.length > 0 ? (
        <section className="admin-section card card-p" aria-labelledby="sites-h">
          <h2 id="sites-h" style={{ fontSize: 16 }} className="mb8">{t('admin.links.sites')}</h2>
          <p className="small muted mb12">{t('admin.links.sitesHelp')}</p>
          <ul className="site-list">
            {l.sites.map((s) => (
              <li key={s.host}>
                <div>
                  <code>{s.host}</code>
                  <span className="xs muted" style={{ display: 'block' }}>{t('admin.links.siteMeta', { n: s.items, time: relativeTime(s.since, t) })}</span>
                </div>
                <div className="row wrap" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <QuickAction action={linkSiteAction} label={t('admin.links.approveSite')} tone="primary"
                    hidden={{ host: s.host, decision: 'approve' }} />
                  <ActionForm action={linkSiteAction} label={t('admin.links.blockSite')} submit={t('admin.links.blockSite')} tone="danger"
                    consequence={t('admin.links.blockSiteHelp', { site: s.host, n: s.items })} hidden={{ host: s.host, decision: 'block' }}
                    reasons={[t('admin.reasons.vendorSite'), t('admin.reasons.scamSite')]} labels={labels} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="admin-section" aria-labelledby="pending-h">
        <h2 id="pending-h">{t('admin.links.pending')}</h2>
        {l.pending.length === 0 ? (
          <div className="card"><EmptyState title={t('admin.links.none')} /></div>
        ) : (
          <ul className="link-queue">
            {l.pending.map((item) => (
              <li key={item.target_id} className="card card-p">
                <div className="row between wrap mb8" style={{ gap: 8 }}>
                  <span className="row wrap" style={{ gap: 6 }}>
                    <span className="pill">{t(item.target_kind === 'post' ? 'admin.links.post' : 'admin.links.comment')}</span>
                    {item.held_reason ? <span className="pill amber">{t('admin.links.alsoHeld', { rule: item.held_reason })}</span> : null}
                  </span>
                  <span className="xs muted">{t('admin.links.waitingSince', { time: relativeTime(item.waiting_since, t) })}</span>
                </div>

                <p className="small mb8">
                  {item.target_kind === 'comment' ? <span className="muted">{t('admin.links.onPost')} </span> : null}
                  <Link className="link bold" href={`/post/${item.post_id}`}>{item.title}</Link>
                </p>
                {item.body ? <p className="small muted clamp mb8">{item.body}</p> : null}

                <div className="mb8">
                  <span className="xs faint">{t('admin.links.linksLabel')}</span>
                  <ul className="link-urls">
                    {(item.urls.length > 0 ? item.urls : item.hosts).map((url) => <li key={url}><code>{url}</code></li>)}
                  </ul>
                </div>

                <p className="xs muted mb12">
                  <Link className="link" href={`/admin/people/${encodeURIComponent(item.author_username)}`}>u/{item.author_username}</Link>
                  {' '}<TierBadge tier={item.author_tier} t={t} />
                  {' · '}{t('admin.links.authorFacts', { karma: item.author_karma.toLocaleString(), integrity: item.author_integrity, joined: formatDate(item.author_joined, locale) })}
                </p>

                <div className="row wrap" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <QuickAction action={linkDecisionAction} label={t('admin.links.approve')} tone="primary"
                    hidden={{ kind: item.target_kind, id: item.target_id, decision: 'approve' }} />
                  {item.hosts.map((host) => (
                    <QuickAction key={host} action={linkSiteAction} label={t('admin.links.approveHost', { site: host })}
                      hidden={{ host, decision: 'approve' }} />
                  ))}
                  <ActionForm action={linkDecisionAction} label={t('admin.links.decline')} submit={t('admin.links.decline')} tone="danger"
                    consequence={t('admin.links.declineHelp')} hidden={{ kind: item.target_kind, id: item.target_id, decision: 'decline' }}
                    reasons={[t('admin.links.reasonVendor'), t('admin.links.reasonUnreliable'), t('admin.links.reasonOffTopic')]} labels={labels} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-section card card-p" aria-labelledby="approved-h">
        <div className="row between wrap mb8">
          <h2 id="approved-h" style={{ fontSize: 16 }}>{t('admin.links.approvedSites')}</h2>
          <ActionForm action={linkSiteAction} label={t('admin.links.addSite')} submit={t('admin.links.approveSite')}
            consequence={t('admin.links.addSiteHelp')} hidden={{ decision: 'approve' }} labels={labels}
            reasons={[t('admin.links.reasonOfficial'), t('admin.links.reasonJournal')]}>
            <div className="field">
              <label htmlFor="approve-host">{t('admin.links.site')}</label>
              <input id="approve-host" name="host" className="input" placeholder="pubmed.ncbi.nlm.nih.gov" maxLength={253} required />
            </div>
          </ActionForm>
        </div>
        <p className="small muted mb12">{t('admin.links.approvedHelp')}</p>
        {l.approved.length === 0 ? <EmptyState title={t('admin.links.noApproved')} /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th scope="col">{t('admin.links.site')}</th><th scope="col">{t('admin.reason')}</th><th scope="col" /></tr></thead>
              <tbody>
                {l.approved.map((d) => (
                  <tr key={d.domain}>
                    <td><code>{d.domain}</code><span className="xs muted">{d.created_by ? `u/${d.created_by} · ` : ''}{formatDate(d.created_at, locale)}</span></td>
                    <td>{d.reason}</td>
                    <td>
                      <ActionForm action={linkSiteAction} label={t('admin.member.remove')} submit={t('admin.member.remove')} tone="danger"
                        consequence={t('admin.links.unapproveHelp')} hidden={{ host: d.domain, decision: 'unapprove' }} labels={labels} />
                    </td>
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
