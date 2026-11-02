import { MOD_ACTIONS, type AdminLogEntry, REPORT_REASONS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader, StatusPill } from '@/components/admin/AdminBits';
import { BarList } from '@/components/admin/Charts';
import { AppealDecisionForm, ResolveForm } from '@/components/mod/ModForms';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { percent } from '@/lib/admin';
import { formatDate, relativeTime } from '@/lib/format';
import { type MessageKey, type Translate, pick } from '@/lib/i18n';
import { restoreContentAction, setCommentsLockedAction, setNoteHiddenAction, setPinnedAction } from '@/server/actions/admin';
import { adminAppeals, adminModLog, adminQueue, adminTeam } from '@/server/admin';
import { getLocale, getT } from '@/server/context';
import { getTaxonomy } from '@/server/queries';

export const metadata: Metadata = { title: 'Moderation' };

const TABS = ['queue', 'appeals', 'log', 'performance'] as const;
type Tab = (typeof TABS)[number];

const RESOLVE_LABELS = [
  'mod.markAbusive', 'mod.violation', 'mod.reason', 'mod.remove', 'mod.keep', 'mod.uphold', 'mod.deny',
  ...REPORT_REASONS.map((r) => `report.reason.${r}` as const),
] satisfies MessageKey[];

/** The quickest way back from each logged action, when there is one. */
function Undo({ e, t }: { e: AdminLogEntry; t: Translate }) {
  const labels = { reason: t('admin.reasonLabel') };
  const id = e.target_id ?? '';
  switch (e.action) {
    case 'remove':
      return e.target_kind === 'post' || e.target_kind === 'comment' ? (
        <ActionForm action={restoreContentAction} label={t('admin.log.restore')} submit={t('admin.log.restore')}
          consequence={t('admin.content.restoreHelp')} hidden={{ kind: e.target_kind, id }} labels={labels} />
      ) : null;
    case 'pin':
      return <ActionForm action={setPinnedAction} label={t('admin.content.unpin')} submit={t('admin.content.unpin')} hidden={{ id, on: 'false' }} labels={labels} />;
    case 'lock_comments':
      return <ActionForm action={setCommentsLockedAction} label={t('admin.content.unlock')} submit={t('admin.content.unlock')} hidden={{ id, on: 'false' }} labels={labels} />;
    case 'hide_note':
      return <ActionForm action={setNoteHiddenAction} label={t('admin.content.unhide')} submit={t('admin.content.unhide')} hidden={{ id, on: 'false' }} labels={labels} />;
    case 'sanction':
    case 'grant_admin':
    case 'appoint_moderator':
    case 'grant_founding_rater':
      return e.target_user ? <Link className="btn sm" href={`/admin/people/${encodeURIComponent(e.target_user)}?tab=standing`}>{t('admin.log.manage')}</Link> : null;
    case 'config_change':
      return <Link className="btn sm" href={`/admin/settings?history=${encodeURIComponent(String(e.metadata.key ?? ''))}`}>{t('admin.log.history')}</Link>;
    case 'shield_rule_added':
      return <Link className="btn sm" href="/admin/shield">{t('admin.log.manage')}</Link>;
    default:
      return null;
  }
}

export default async function AdminModerationPage({ searchParams }: {
  searchParams: Promise<{ tab?: string; zone?: string; action?: string; actor?: string; target?: string; before?: string }>;
}) {
  const [t, locale, params, taxonomy] = await Promise.all([getT(), getLocale(), searchParams, getTaxonomy()]);
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'queue';
  const zoneName = (id: string | null) => {
    if (!id) return t('admin.mod.noZone');
    const z = taxonomy.zones.find((x) => x.id === id);
    return z ? (locale === 'fr' ? z.name_fr : z.name_en) : id;
  };
  const labels = pick(t, RESOLVE_LABELS);

  return (
    <>
      <PageHeader title={t('admin.mod.title')} sub={t('admin.mod.sub')} />
      <nav className="tabs" aria-label={t('admin.mod.title')}>
        {TABS.map((x) => <Link key={x} href={`/admin/moderation?tab=${x}`} aria-current={x === tab ? 'page' : undefined}>{t(`admin.mod.tab.${x}` as MessageKey)}</Link>)}
      </nav>

      {tab === 'queue' ? await (async () => {
        const result = await adminQueue();
        if (!result.ok) return <DataUnavailable result={result} t={t} />;
        const zones = [...new Set(result.data.map((i) => i.zone_id))];
        const items = params.zone ? result.data.filter((i) => i.zone_id === params.zone) : result.data;
        return (
          <>
            {zones.length > 1 ? (
              <nav className="row wrap mb12" style={{ gap: 6 }} aria-label={t('admin.zone')}>
                <Link className="chip sm" href="/admin/moderation" aria-current={!params.zone ? 'page' : undefined}>{t('admin.all')} · {result.data.length}</Link>
                {zones.map((z) => (
                  <Link key={z} className="chip sm" href={`/admin/moderation?zone=${z}`} aria-current={params.zone === z ? 'page' : undefined}>
                    {zoneName(z)} · {result.data.filter((i) => i.zone_id === z).length}
                  </Link>
                ))}
              </nav>
            ) : null}
            {items.length === 0 ? <div className="card"><EmptyState title={t('admin.mod.queueEmpty')} /></div> : (
              <div className="feed">
                {items.map((item) => (
                  <article key={item.target_id} className="card card-p">
                    <div className="meta">
                      <span className="pill zone">{zoneName(item.zone_id)}</span>
                      <span className="pill">{t(`admin.kind.${item.target_kind}` as MessageKey)}</span>
                      <StatusPill status={item.status} t={t} />
                      {item.held_reason ? <span className="pill amber"><Icon name="shield" />{t('admin.mod.heldBy', { rule: item.held_reason })}</span> : null}
                      {item.report_count > 0 ? <span>{t('mod.reports', { n: item.report_count, w: item.total_weight })}</span> : null}
                      <span className="xs faint">{relativeTime(item.first_reported_at, t)}</span>
                    </div>
                    <h3 className="mt8"><Link href={`/post/${item.post_id}`}>{item.excerpt}</Link></h3>
                    <p className="small muted mt8 post-x clamp">{item.body}</p>
                    <p className="xs faint mt8">
                      <Link className="link" href={`/admin/people/${encodeURIComponent(item.author_username)}`}>u/{item.author_username}</Link>
                      {' · '}{t('admin.mod.authorFacts', { tier: item.author_tier, integrity: item.author_integrity, prior: item.author_prior_actions })}
                    </p>
                    <ResolveForm kind={item.target_kind} targetId={item.target_id} reports={item.reports} labels={labels} />
                  </article>
                ))}
              </div>
            )}
          </>
        );
      })() : null}

      {tab === 'appeals' ? await (async () => {
        const result = await adminAppeals();
        if (!result.ok) return <DataUnavailable result={result} t={t} />;
        if (result.data.length === 0) return <div className="card"><EmptyState title={t('admin.mod.appealsEmpty')} /></div>;
        return (
          <div className="feed">
            {result.data.map((appeal) => (
              <article key={appeal.id} className="card card-p">
                <div className="meta">
                  <span className="pill zone">{zoneName(appeal.zone_id)}</span>
                  <span className="pill amber">{t(`admin.action.${appeal.action}` as MessageKey)}</span>
                  <Link className="link" href={`/admin/people/${encodeURIComponent(appeal.appellant)}`}>u/{appeal.appellant}</Link>
                  <span className="xs faint">{relativeTime(appeal.created_at, t)}</span>
                </div>
                <p className="small muted mt8">{t('admin.mod.original', { by: appeal.acted_by ?? t('admin.system'), reason: appeal.reason })}</p>
                <p className="mt8">{appeal.body}</p>
                {appeal.can_decide ? <AppealDecisionForm appealId={appeal.id} labels={labels} /> : <p className="xs faint mt8">{t('mod.cannotDecide')}</p>}
              </article>
            ))}
          </div>
        );
      })() : null}

      {tab === 'log' ? await (async () => {
        const action = MOD_ACTIONS.includes(params.action as (typeof MOD_ACTIONS)[number]) ? (params.action as string) : null;
        const result = await adminModLog({
          p_action: action, p_actor: params.actor?.trim() || null, p_zone: params.zone || null,
          p_target: params.target?.trim() || null, p_before: params.before || null,
        });
        const last = result.ok ? result.data[result.data.length - 1] : undefined;
        const older = new URLSearchParams({ tab: 'log', ...(action ? { action } : {}), ...(params.actor ? { actor: params.actor } : {}),
          ...(params.target ? { target: params.target } : {}), ...(params.zone ? { zone: params.zone } : {}), ...(last ? { before: last.created_at } : {}) });
        return (
          <>
            <form className="filters card card-p" action="/admin/moderation">
              <input type="hidden" name="tab" value="log" />
              <label className="vh" htmlFor="log-action">{t('admin.log.action')}</label>
              <select id="log-action" name="action" className="input" defaultValue={action ?? ''} style={{ maxWidth: 220 }}>
                <option value="">{t('admin.log.anyAction')}</option>
                {MOD_ACTIONS.map((a) => <option key={a} value={a}>{t(`admin.action.${a}` as MessageKey)}</option>)}
              </select>
              <label className="vh" htmlFor="log-actor">{t('admin.log.actor')}</label>
              <input id="log-actor" name="actor" className="input" placeholder={t('admin.log.actor')} defaultValue={params.actor ?? ''} style={{ maxWidth: 160 }} />
              <label className="vh" htmlFor="log-target">{t('admin.log.target')}</label>
              <input id="log-target" name="target" className="input" placeholder={t('admin.log.target')} defaultValue={params.target ?? ''} style={{ maxWidth: 160 }} />
              <label className="vh" htmlFor="log-zone">{t('admin.zone')}</label>
              <select id="log-zone" name="zone" className="input" defaultValue={params.zone ?? ''} style={{ maxWidth: 180 }}>
                <option value="">{t('admin.log.anyZone')}</option>
                {taxonomy.zones.map((z) => <option key={z.id} value={z.id}>{zoneName(z.id)}</option>)}
              </select>
              <button type="submit" className="btn">{t('admin.filter')}</button>
              <a className="btn ghost" href="/admin/export/modlog" download><Icon name="download" />{t('admin.export')}</a>
            </form>
            {!result.ok ? <DataUnavailable result={result} t={t} /> : result.data.length === 0 ? <div className="card"><EmptyState title={t('admin.log.empty')} /></div> : (
              <div className="card tbl-wrap">
                <table className="tbl">
                  <thead><tr><th scope="col">{t('admin.date')}</th><th scope="col">{t('admin.log.actor')}</th><th scope="col">{t('admin.log.action')}</th><th scope="col">{t('admin.log.target')}</th><th scope="col">{t('admin.reason')}</th><th scope="col" /></tr></thead>
                  <tbody>
                    {result.data.map((e) => (
                      <tr key={e.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(e.created_at, locale)}<span className="xs muted">{relativeTime(e.created_at, t)}</span></td>
                        <td>{e.actor ? <Link className="link" href={`/admin/people/${encodeURIComponent(e.actor)}`}>u/{e.actor}</Link> : <span className="muted">{t('admin.system')}</span>}</td>
                        <td>{t(`admin.action.${e.action}` as MessageKey)}{e.appealed ? <span className="pill amber">{t('admin.log.appealed')}</span> : null}</td>
                        <td>
                          {e.target_user ? <Link className="link" href={`/admin/people/${encodeURIComponent(e.target_user)}`}>u/{e.target_user}</Link> : null}
                          {e.post_id ? <Link className="link xs" style={{ display: 'block' }} href={`/post/${e.post_id}`}>{t('admin.log.open')}</Link> : null}
                          {e.action === 'config_change' ? <code className="xs">{String(e.metadata.key)}</code> : null}
                          {e.action === 'shield_rule_added' || e.action === 'shield_rule_removed' ? <code className="xs">{String(e.metadata.value)}</code> : null}
                        </td>
                        <td>{e.reason}</td>
                        <td><Undo e={e} t={t} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {result.ok && result.data.length === 100 ? <div className="mt16"><Link className="btn sm" href={`/admin/moderation?${older.toString()}`}>{t('admin.older')}</Link></div> : null}
          </>
        );
      })() : null}

      {tab === 'performance' ? await (async () => {
        const result = await adminTeam();
        if (!result.ok) return <DataUnavailable result={result} t={t} />;
        const team = result.data;
        const reasons = REPORT_REASONS.map((r) => ({ label: t(`report.reason.${r}` as MessageKey), value: team.reports_by_reason_30d[r] ?? 0 }))
          .filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
        return (
          <>
            <section className="admin-section card card-p">
              <h2 style={{ fontSize: 16 }} className="mb8">{t('admin.perf.moderators')}</h2>
              <p className="small muted mb12">{t('admin.perf.help')}</p>
              {team.moderators.length === 0 ? <EmptyState title={t('admin.team.noModerators')} /> : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead><tr>
                      <th scope="col">{t('admin.people.member')}</th><th scope="col">{t('admin.zone')}</th>
                      <th scope="col" className="num">{t('admin.team.actions30')}</th><th scope="col" className="num">{t('admin.perf.median')}</th>
                      <th scope="col" className="num">{t('admin.perf.overturned')}</th><th scope="col">{t('admin.team.lastAction')}</th>
                    </tr></thead>
                    <tbody>
                      {team.moderators.map((m) => {
                        const overturned = percent(m.decisions_overturned, m.decisions_appealed);
                        return (
                          <tr key={`${m.zone_id}-${m.username}`}>
                            <td><Link className="link" href={`/admin/people/${encodeURIComponent(m.username)}`}>u/{m.username}</Link></td>
                            <td>{zoneName(m.zone_id)}</td>
                            <td className="num">{m.actions_30d}</td>
                            <td className="num">{m.median_hours === null ? '—' : t('admin.hours', { n: m.median_hours })}</td>
                            <td className="num">
                              {overturned === null ? '—' : <span className={overturned > 30 ? 'pill amber' : ''}>{overturned}% <span className="xs faint">({m.decisions_overturned}/{m.decisions_appealed})</span></span>}
                            </td>
                            <td>{m.last_action_at ? relativeTime(m.last_action_at, t) : <span className="pill amber">{t('admin.perf.inactive')}</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="admin-section card card-p">
              <h2 style={{ fontSize: 16 }} className="mb8">{t('admin.perf.reasons')}</h2>
              {reasons.length === 0 ? <p className="small muted">{t('admin.perf.noReports')}</p> : <BarList rows={reasons} label={t('admin.perf.reasons')} />}
              <p className="small muted mt12">{t('admin.perf.abusive', { n: team.abusive_reports_30d, total: team.resolved_reports_30d })}</p>
            </section>
          </>
        );
      })() : null}
    </>
  );
}
