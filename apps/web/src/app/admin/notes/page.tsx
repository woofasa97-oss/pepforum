import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { PercentLine } from '@/components/admin/Charts';
import { EmptyState, Progress } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { setConfigAction } from '@/server/actions/admin';
import { adminNotesHealth } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Community notes' };

/** Shadow agreement the scoring guide asks for before switching to bridging. */
const AGREEMENT_TARGET = 85;

export default async function AdminNotesPage() {
  const [t, locale, result] = await Promise.all([getT(), getLocale(), adminNotesHealth()]);
  const header = <PageHeader title={t('admin.notes.title')} sub={t('admin.notes.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const h = result.data;
  const runs = h.scoring.runs;
  const latest = runs[runs.length - 1];
  const established = latest?.established_raters ?? 0;
  const agreement = latest?.agreement === null || latest?.agreement === undefined ? null : Math.round(latest.agreement * 100);
  const enoughRaters = established >= h.scoring.switch_min_raters;
  const enoughAgreement = agreement !== null && agreement >= AGREEMENT_TARGET;
  const check = (ok: boolean) => <Icon name={ok ? 'check' : 'x'} />;
  const member = (u: string) => <Link className="link" href={`/admin/people/${encodeURIComponent(u)}`}>u/{u}</Link>;

  return (
    <>
      {header}

      <div className="stats mb16">
        {([
          ['admin.notes.waiting', h.open.needs_more_ratings],
          ['admin.notes.showingHelpful', h.open.helpful],
          ['admin.notes.leaningNot', h.open.not_helpful],
          ['admin.notes.settledHelpful', h.locked.helpful],
          ['admin.notes.settledNot', h.locked.not_helpful],
          ['admin.notes.expired', h.locked.needs_more_ratings],
          ['admin.notes.hidden', h.hidden],
        ] as const).map(([label, value]) => (
          <div key={label} className="stat" title={t(`${label}Help` as MessageKey)}><div className="l">{t(label)}</div><div className="v">{value.toLocaleString()}</div></div>
        ))}
      </div>

      <section className="admin-section card card-p" aria-labelledby="scoring-h">
        <h2 id="scoring-h" style={{ fontSize: 16 }} className="mb8">{t('admin.notes.scoring')}</h2>
        <p className="small muted mb12">
          {t(h.scoring.mode === 'bridging' ? 'admin.notes.modeBridging' : 'admin.notes.modeBootstrap')}
          {latest ? ` ${t('admin.notes.lastRun', { age: relativeTime(latest.at, t), changed: latest.transitions, locked: latest.locked })}` : ` ${t('admin.notes.noRuns')}`}
        </p>
        {runs.length > 1 ? (
          <>
            <PercentLine
              label={t('admin.notes.agreementChart')}
              points={runs.map((r) => ({ label: formatDate(r.at, locale), value: r.agreement === null ? null : Math.round(r.agreement * 100) }))}
              target={AGREEMENT_TARGET}
              targetLabel={t('admin.notes.target', { n: AGREEMENT_TARGET })}
            />
            <p className="xs faint mb12">{t('admin.notes.agreementHelp')}</p>
          </>
        ) : null}
        <div className="grid2 even">
          <div>
            <h3 className="mb8" style={{ fontSize: 14 }}>{t('admin.notes.readiness')}</h3>
            <ul className="caps">
              <li><span>{check(enoughRaters)} {t('admin.notes.ratersCheck', { n: established, min: h.scoring.switch_min_raters })}</span></li>
              <li><span>{check(enoughAgreement)} {t('admin.notes.agreementCheck', { n: agreement ?? '—', min: AGREEMENT_TARGET })}</span></li>
            </ul>
            <div className="mt8"><Progress value={established} max={h.scoring.switch_min_raters} tone="teal" label={t('admin.notes.ratersCheck', { n: established, min: h.scoring.switch_min_raters })} /></div>
          </div>
          <div>
            {h.scoring.mode === 'bootstrap' ? (
              <ActionForm action={setConfigAction} label={t('admin.notes.switch')} submit={t('admin.notes.switch')} tone="primary"
                consequence={t(enoughRaters && enoughAgreement ? 'admin.notes.switchHelp' : 'admin.notes.switchEarly')}
                hidden={{ key: 'scoring.mode', raw: '"bridging"' }} labels={{ reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') }} />
            ) : (
              <ActionForm action={setConfigAction} label={t('admin.notes.switchBack')} submit={t('admin.notes.switchBack')}
                consequence={t('admin.notes.switchBackHelp')} hidden={{ key: 'scoring.mode', raw: '"bootstrap"' }}
                labels={{ reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') }} />
            )}
          </div>
        </div>
      </section>

      <div className="grid2 even mb16">
        <section className="card card-p" aria-labelledby="waiting-h">
          <h2 id="waiting-h" style={{ fontSize: 16 }} className="mb8">{t('admin.notes.oldestWaiting')}</h2>
          {h.waiting.length === 0 ? <EmptyState title={t('admin.notes.noneWaiting')} /> : (
            <ul className="caps">
              {h.waiting.map((n) => (
                <li key={n.id}>
                  <Link className="link" href={`/notes/${n.id}`}>{n.post_title}</Link>
                  <span className="xs muted" style={{ whiteSpace: 'nowrap' }}>{n.ratings}/{n.min_ratings} · {relativeTime(n.created_at, t)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card card-p" aria-labelledby="locked-h">
          <h2 id="locked-h" style={{ fontSize: 16 }} className="mb8">{t('admin.notes.recentlySettled')}</h2>
          {h.recently_locked.length === 0 ? <EmptyState title={t('admin.notes.noneSettled')} /> : (
            <ul className="caps">
              {h.recently_locked.map((n) => (
                <li key={n.id}>
                  <Link className="link" href={`/notes/${n.id}`}>{n.post_title}</Link>
                  <span>
                    <span className="pill">{t(`notes.status.${n.locked_status}` as MessageKey)}</span>
                    {n.hidden ? <span className="pill red">{t('admin.content.hidden')}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="admin-section card card-p" aria-labelledby="people-h">
        <h2 id="people-h" style={{ fontSize: 16 }} className="mb8">{t('admin.notes.people')}</h2>
        <ul className="caps mb12">
          <li><span>{t('admin.notes.raters')}</span><span>{t('admin.notes.raterCounts', { probation: h.raters.probation, active: h.raters.active, founding: h.raters.founding })}</span></li>
          <li><span>{t('admin.notes.strikes30')}</span><b>{h.strikes_30d}</b></li>
          <li><span>{t('admin.notes.corrections30')}</span><b>{h.corrections_30d}</b></li>
        </ul>
        <h3 className="mb8" style={{ fontSize: 14 }}>{t('admin.notes.writerLocks')}</h3>
        {h.writer_locks.length === 0 ? <p className="small muted">{t('admin.notes.noLocks')}</p> : (
          <ul className="caps">
            {h.writer_locks.map((w) => <li key={w.username}>{member(w.username)}<span className="xs muted">{t('admin.team.until', { date: formatDate(w.until, locale) })}</span></li>)}
          </ul>
        )}
      </section>

      <section className="admin-section card card-p" aria-labelledby="signals-h">
        <h2 id="signals-h" style={{ fontSize: 16 }} className="mb8">{t('admin.notes.signals')}</h2>
        <p className="small muted mb12">{t('admin.notes.signalsHelp')}</p>
        <h3 className="mb8" style={{ fontSize: 14 }}>{t('admin.notes.youngRaters')}</h3>
        {h.young_rater_notes.length === 0 ? <p className="small muted mb12">{t('admin.notes.noSignal')}</p> : (
          <ul className="caps mb12">
            {h.young_rater_notes.map((n) => (
              <li key={n.id}><Link className="link" href={`/notes/${n.id}`}>{n.post_title}</Link><span className="pill amber">{t('admin.notes.youngShare', { n: Math.round(n.young_share * 100) })}</span></li>
            ))}
          </ul>
        )}
        <h3 className="mb8" style={{ fontSize: 14 }}>{t('admin.notes.lockstep')}</h3>
        {h.lockstep_pairs.length === 0 ? <p className="small muted">{t('admin.notes.noSignal')}</p> : (
          <ul className="caps">
            {h.lockstep_pairs.map((p) => (
              <li key={`${p.a}-${p.b}`}><span>{member(p.a)} + {member(p.b)}</span><span className="pill amber">{t('admin.notes.lockstepPair', { n: Math.round(p.agreement * 100), shared: p.shared })}</span></li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
