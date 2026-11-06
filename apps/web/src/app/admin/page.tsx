import { type AdminMetrics, type AdminOverview, METRIC_KEYS, type MetricKey } from '@pepforum/database';
import Link from 'next/link';

import { DataUnavailable, PageHeader, StatTile } from '@/components/admin/AdminBits';
import { Icon, type IconName } from '@/components/ui/Icon';
import { JOBS, hoursUntil, jobHealth } from '@/lib/admin';
import { formatDay, relativeTime } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { adminMetrics, adminOverview } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

const RANGES = [7, 30, 90] as const;

/** Tiles in reading order; reports and removals going up is not good news. */
const TILES: ReadonlyArray<{ key: MetricKey; goodWhenUp: boolean }> = [
  { key: 'active', goodWhenUp: true },
  { key: 'signups', goodWhenUp: true },
  { key: 'posts', goodWhenUp: true },
  { key: 'comments', goodWhenUp: true },
  { key: 'notes', goodWhenUp: true },
  { key: 'notes_shown', goodWhenUp: true },
  { key: 'ratings', goodWhenUp: true },
  { key: 'reports', goodWhenUp: false },
  { key: 'removals', goodWhenUp: false },
];

interface Need {
  readonly tone: 'red' | 'amber' | 'info';
  readonly icon: IconName;
  readonly text: string;
  readonly href: string;
  readonly cta: string;
}

function needs(o: AdminOverview, t: Translate): Need[] {
  const list: Need[] = [];
  const now = Date.now();
  if (o.reports_open > 0) {
    list.push({ tone: 'red', icon: 'flag', href: '/admin/moderation', cta: t('admin.home.review'),
      text: t('admin.home.reports', { n: o.reports_open, age: o.reports_oldest ? relativeTime(o.reports_oldest, t) : '' }) });
  }
  if (o.appeals_open > 0) {
    list.push({ tone: 'amber', icon: 'scale', href: '/admin/moderation?tab=appeals', cta: t('admin.home.review'),
      text: o.appeals_admin_only > 0
        ? t('admin.home.appealsAdmin', { n: o.appeals_open, m: o.appeals_admin_only })
        : t('admin.home.appeals', { n: o.appeals_open }) });
  }
  if (o.collapsed > 0) {
    list.push({ tone: 'amber', icon: 'eye', href: '/admin/moderation', cta: t('admin.home.review'),
      text: t('admin.home.collapsed', { n: o.collapsed, h: o.collapsed_next_reopen ? hoursUntil(o.collapsed_next_reopen, now) : 0 }) });
  }
  if (o.links_pending > 0) {
    list.push({ tone: 'amber', icon: 'link', href: '/admin/links', cta: t('admin.home.review'),
      text: t('admin.home.links', { n: o.links_pending, age: o.links_oldest ? relativeTime(o.links_oldest, t) : '' }) });
  }
  if (o.held > 0) {
    list.push({ tone: 'amber', icon: 'shield', href: '/admin/moderation', cta: t('admin.home.review'), text: t('admin.home.held', { n: o.held }) });
  }
  for (const job of JOBS) {
    const health = jobHealth(o.jobs, job, now);
    if (health === 'ok') continue;
    const at = o.jobs[job]?.at;
    list.push({
      tone: health === 'stalled' ? 'red' : 'amber', icon: 'clock', href: '/admin/system', cta: t('admin.home.check'),
      text: o.jobs[job]?.ok === false
        ? t('admin.home.jobFailed', { job: t(`admin.job.${job}` as MessageKey) })
        : at ? t('admin.home.jobLate', { job: t(`admin.job.${job}` as MessageKey), age: relativeTime(at, t) })
          : t('admin.home.jobNever', { job: t(`admin.job.${job}` as MessageKey) }),
    });
  }
  if (o.security_problems > 0) {
    list.push({ tone: 'red', icon: 'alert', href: '/admin/system', cta: t('admin.home.check'), text: t('admin.home.security', { n: o.security_problems }) });
  }
  if (o.deletions_pending > 0 && o.deletions_oldest && Date.now() - new Date(o.deletions_oldest).getTime() > 3600000) {
    list.push({ tone: 'red', icon: 'user', href: '/admin/system', cta: t('admin.home.check'), text: t('admin.home.deletions', { n: o.deletions_pending }) });
  }
  if (o.staff_without_mfa > 0) {
    list.push({ tone: 'amber', icon: 'lock', href: '/admin/team', cta: t('admin.home.check'), text: t('admin.home.staffMfa', { n: o.staff_without_mfa }) });
  }
  if (o.founding_expiring > 0) {
    list.push({ tone: 'info', icon: 'star', href: '/admin/team', cta: t('admin.home.check'), text: t('admin.home.founding', { n: o.founding_expiring }) });
  }
  if (o.bridging_ready) {
    list.push({ tone: 'info', icon: 'note', href: '/admin/notes', cta: t('admin.home.check'), text: t('admin.home.bridging') });
  }
  return list;
}

function Quality({ m, t }: { m: AdminMetrics; t: Translate }) {
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);
  const rows: ReadonlyArray<readonly [MessageKey, MessageKey, string]> = [
    ['admin.q.actioned', 'admin.q.actionedHelp', pct(m.quality.reports_actioned_pct)],
    ['admin.q.review', 'admin.q.reviewHelp', m.quality.median_review_hours === null ? '—' : t('admin.hours', { n: m.quality.median_review_hours })],
    ['admin.q.overturned', 'admin.q.overturnedHelp', pct(m.quality.appeals_overturned_pct)],
    ['admin.q.helpfulNotes', 'admin.q.helpfulNotesHelp', pct(m.quality.posts_with_helpful_note_pct)],
    ['admin.q.reopened', 'admin.q.reopenedHelp', String(m.quality.collapses_reopened_unreviewed)],
  ];
  return (
    <ul className="caps">
      {rows.map(([label, help, value]) => (
        <li key={label}>
          <span>{t(label)}<span className="xs faint" style={{ display: 'block' }}>{t(help)}</span></span>
          <b>{value}</b>
        </li>
      ))}
    </ul>
  );
}

export default async function AdminHomePage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const [t, locale, params] = await Promise.all([getT(), getLocale(), searchParams]);
  const days = (RANGES.find((r) => String(r) === params.range) ?? 30) as 7 | 30 | 90;
  const [overview, metrics] = await Promise.all([adminOverview(), adminMetrics(days)]);

  return (
    <>
      <PageHeader title={t('admin.home.title')} sub={t('admin.home.sub')} />

      <section className="admin-section" aria-labelledby="needs-h">
        <h2 id="needs-h">{t('admin.home.needs')}</h2>
        {!overview.ok ? <DataUnavailable result={overview} t={t} /> : (() => {
          const list = needs(overview.data, t);
          if (list.length === 0) return <div className="all-clear"><Icon name="check" />{t('admin.home.allClear')}</div>;
          return (
            <ul className="needs">
              {list.map((n) => (
                <li key={n.text} className={n.tone}>
                  <Icon name={n.icon} />
                  <span className="grow">{n.text}</span>
                  <Link className="btn sm" href={n.href}>{n.cta}</Link>
                </li>
              ))}
            </ul>
          );
        })()}
      </section>

      <section className="admin-section" aria-labelledby="glance-h">
        <div className="row between wrap mb12">
          <h2 id="glance-h" style={{ marginBottom: 0 }}>{t('admin.home.glance')}</h2>
          <nav className="seg" aria-label={t('admin.home.range')}>
            {RANGES.map((r) => (
              <Link key={r} href={`/admin?range=${r}`} aria-current={r === days ? 'page' : undefined}>{t('admin.days', { n: r })}</Link>
            ))}
          </nav>
        </div>
        {!metrics.ok ? <DataUnavailable result={metrics} t={t} /> : (
          <>
            <div className="stats">
              {TILES.map(({ key, goodWhenUp }) => (
                <StatTile
                  key={key}
                  label={t(`admin.metric.${key}` as MessageKey)}
                  hint={t(`admin.metricHelp.${key}` as MessageKey)}
                  value={metrics.data.totals[key].current}
                  previous={metrics.data.totals[key].previous}
                  goodWhenUp={goodWhenUp}
                  {...(key === 'signups' ? { sub: t('admin.home.viaSocial', { n: metrics.data.totals.signups_social.current }) } : {})}
                  points={metrics.data.days.map((d, i) => ({ label: formatDay(d, locale), value: metrics.data.series[key][i] ?? 0 }))}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
            <div className="grid2 mt16" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
              <div className="card card-p">
                <h3 className="mb8">{t('admin.home.quality')}</h3>
                <Quality m={metrics.data} t={t} />
              </div>
              <div className="card card-p">
                <h3 className="mb8">{t('admin.home.more')}</h3>
                <ul className="caps">
                  <li><Link className="link" href="/transparency">{t('admin.home.transparency')}</Link><Icon name="external" /></li>
                  <li><a className="link" href={`/admin/export/metrics?days=${days}`} download>{t('admin.home.exportMetrics')}</a><Icon name="download" /></li>
                  <li><a className="link" href="/admin/export/modlog" download>{t('admin.home.exportLog')}</a><Icon name="download" /></li>
                </ul>
              </div>
            </div>
            <details className="mt16">
              <summary className="link small" style={{ cursor: 'pointer' }}>{t('admin.home.table')}</summary>
              <div className="tbl-wrap card mt8">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{t('admin.date')}</th>
                      {METRIC_KEYS.map((k) => <th key={k} scope="col" className="num">{t(`admin.metric.${k}` as MessageKey)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.data.days.map((d, i) => (
                      <tr key={d}>
                        <th scope="row">{formatDay(d, locale)}</th>
                        {METRIC_KEYS.map((k) => <td key={k} className="num">{metrics.data.series[k][i] ?? 0}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
      </section>
    </>
  );
}
