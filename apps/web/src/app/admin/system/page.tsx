import type { Metadata } from 'next';
import Link from 'next/link';

import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { BarList } from '@/components/admin/Charts';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { JOBS, jobHealth } from '@/lib/admin';
import { PROVIDER_NAMES } from '@/lib/auth-providers';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { adminSystemStatus } from '@/server/admin';
import { getLocale, getT } from '@/server/context';
import { getEnabledOAuthProviders } from '@/server/queries';

export const metadata: Metadata = { title: 'System' };

export default async function AdminSystemPage() {
  const [t, locale, result, providers] = await Promise.all([getT(), getLocale(), adminSystemStatus(), getEnabledOAuthProviders()]);
  const header = <PageHeader title={t('admin.system.title')} sub={t('admin.system.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const s = result.data;
  const jobsMap = Object.fromEntries(s.jobs.map((j) => [j.job, { at: j.last_at, ok: j.ok }]));

  return (
    <>
      {header}

      <section className="admin-section card card-p" aria-labelledby="jobs-h">
        <h2 id="jobs-h" style={{ fontSize: 16 }} className="mb8">{t('admin.system.jobs')}</h2>
        <p className="small muted mb12">{t('admin.system.jobsHelp')}</p>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.system.job')}</th><th scope="col">{t('admin.status')}</th><th scope="col">{t('admin.system.lastRun')}</th><th scope="col" className="num">{t('admin.system.runs24')}</th><th scope="col">{t('admin.system.summary')}</th></tr></thead>
            <tbody>
              {JOBS.map((job) => {
                const row = s.jobs.find((j) => j.job === job);
                const health = jobHealth(jobsMap, job);
                return (
                  <tr key={job}>
                    <td><b>{t(`admin.job.${job}` as MessageKey)}</b><span className="xs muted">{t(`admin.jobHelp.${job}` as MessageKey)}</span></td>
                    <td>
                      <span className={`pill ${health === 'ok' ? 'green' : health === 'late' ? 'amber' : 'red'}`}>
                        <Icon name={health === 'ok' ? 'check' : 'alert'} />{t(`admin.health.${row?.ok === false ? 'failed' : health}` as MessageKey)}
                      </span>
                    </td>
                    <td>{row ? relativeTime(row.last_at, t) : t('admin.system.never')}</td>
                    <td className="num">{row ? `${row.runs_24h}${row.failures_24h ? ` · ${t('admin.system.failures', { n: row.failures_24h })}` : ''}` : '—'}</td>
                    <td className="xs muted">{row ? Object.entries(row.summary).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || '—' : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid2 mb16" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <section className="card card-p" aria-labelledby="audit-h">
          <h2 id="audit-h" style={{ fontSize: 16 }} className="mb8">{t('admin.system.audit')}</h2>
          <p className="small muted mb12">{t('admin.system.auditHelp')}</p>
          {s.security_audit.length === 0 ? <div className="all-clear"><Icon name="check" />{t('admin.system.auditClean')}</div> : (
            <ul className="caps">
              {s.security_audit.map((a) => <li key={`${a.check}-${a.object}`}><span><b>{a.check}</b> <code className="xs">{a.object}</code></span><span className="xs muted">{a.detail}</span></li>)}
            </ul>
          )}
          <h3 className="mt16 mb8" style={{ fontSize: 14 }}>{t('admin.system.staffMfa')}</h3>
          {s.staff_without_mfa.length === 0 ? <p className="small muted">{t('admin.system.staffMfaOk')}</p> : (
            <p className="small">{s.staff_without_mfa.map((u, i) => (
              <span key={u}>{i > 0 ? ', ' : ''}<Link className="link" href={`/admin/people/${encodeURIComponent(u)}`}>u/{u}</Link></span>
            ))}</p>
          )}
        </section>

        <section className="card card-p" aria-labelledby="privacy-h">
          <h2 id="privacy-h" style={{ fontSize: 16 }} className="mb8">{t('admin.system.privacy')}</h2>
          <p className="small muted mb12">{t('admin.system.privacyHelp')}</p>
          <ul className="caps">
            <li><span>{t('admin.system.deletionsPending')}</span><b>{s.deletions.pending}</b></li>
            <li><span>{t('admin.system.deletionsOldest')}</span><span>{s.deletions.oldest ? relativeTime(s.deletions.oldest, t) : '—'}</span></li>
            <li><span>{t('admin.system.deletionsDone')}</span><b>{s.deletions.processed_30d}</b></li>
          </ul>
        </section>
      </div>

      <div className="grid2 mb16" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <section className="card card-p" aria-labelledby="signin-h">
          <h2 id="signin-h" style={{ fontSize: 16 }} className="mb8">{t('admin.system.signIn')}</h2>
          <p className="small muted mb8">{t('admin.system.providers')}</p>
          <p className="row wrap mb12" style={{ gap: 4 }}>
            <span className="pill green">{t('admin.people.emailSignIn')}</span>
            {providers.map((p) => <span key={p} className="pill green">{PROVIDER_NAMES[p]}</span>)}
          </p>
          <p className="xs faint mb12">{t('admin.system.providersHelp')}</p>
          <h3 className="mb8" style={{ fontSize: 14 }}>{t('admin.system.signupsByMethod')}</h3>
          {Object.keys(s.signups_by_provider_30d).length === 0 ? <p className="small muted">{t('admin.system.noSignups')}</p> : (
            <BarList label={t('admin.system.signupsByMethod')} rows={Object.entries(s.signups_by_provider_30d)
              .map(([p, n]) => ({ label: p === 'email' ? t('admin.people.emailSignIn') : (PROVIDER_NAMES as Record<string, string>)[p] ?? p, value: n }))
              .sort((a, b) => b.value - a.value)} />
          )}
        </section>

        <section className="card card-p" aria-labelledby="busy-h">
          <h2 id="busy-h" style={{ fontSize: 16 }} className="mb8">{t('admin.system.busiest')}</h2>
          <p className="small muted mb12">{t('admin.system.busiestHelp')}</p>
          {s.busiest_24h.length === 0 ? <EmptyState title={t('admin.system.quiet')} /> : (
            <table className="tbl">
              <thead><tr><th scope="col">{t('admin.people.member')}</th><th scope="col">{t('admin.log.action')}</th><th scope="col" className="num">{t('admin.system.count')}</th></tr></thead>
              <tbody>
                {s.busiest_24h.map((b) => (
                  <tr key={`${b.username}-${b.action}`}>
                    <td><Link className="link" href={`/admin/people/${encodeURIComponent(b.username)}`}>u/{b.username}</Link></td>
                    <td>{b.action}</td>
                    <td className="num">{b.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {s.last_scoring_run ? (
        <p className="xs faint">{t('admin.system.lastScoring', { date: formatDate(s.last_scoring_run.at, locale), mode: s.last_scoring_run.mode, scored: s.last_scoring_run.scored })}</p>
      ) : null}
    </>
  );
}
