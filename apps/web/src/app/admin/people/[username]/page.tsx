import { type AdminMember, STAFF_NOTE_LABELS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, Facts, StatusPill } from '@/components/admin/AdminBits';
import { Avatar, EmptyState, TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { isFuture, isoDateInDays, percent } from '@/lib/admin';
import { providerName } from '@/lib/auth-providers';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import {
  clearWritingLockAction,
  foundingAction,
  renameMemberAction,
  revealEmailAction,
  revokeSanctionAction,
  revokeStrikeAction,
  sanctionAction,
  setModeratorAction,
  setRoleAction,
  staffNoteAction,
} from '@/server/actions/admin';
import { adminMember, adminOverview } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

const TABS = ['activity', 'standing', 'moderation', 'notes', 'staff'] as const;
type Tab = (typeof TABS)[number];

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).username) };
}

const isActive = (s: AdminMember['sanctions'][number]) =>
  !s.revoked_at && new Date(s.starts_at).getTime() <= Date.now() && (!s.ends_at || new Date(s.ends_at).getTime() > Date.now());

function ActivityTab({ m, t, locale }: { m: AdminMember; t: Translate; locale: string }) {
  if (m.recent.length === 0) return <EmptyState title={t('admin.member.noActivity')} />;
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th scope="col">{t('admin.member.what')}</th><th scope="col">{t('admin.status')}</th><th scope="col">{t('admin.date')}</th></tr></thead>
        <tbody>
          {m.recent.map((r) => (
            <tr key={r.id}>
              <td><span className="pill">{t(`admin.kind.${r.kind}` as MessageKey)}</span> <Link className="link" href={`/post/${r.post_id}`}>{r.text}</Link></td>
              <td><StatusPill status={r.status} t={t} /></td>
              <td>{formatDate(r.created_at, locale)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StandingTab({ m, t, locale, reasonLabels }: { m: AdminMember; t: Translate; locale: string; reasonLabels: { reason: string } }) {
  return (
    <>
      <h3 className="mb8">{t('admin.member.sanctions')}</h3>
      {m.sanctions.length === 0 ? <p className="small muted mb16">{t('admin.member.none')}</p> : (
        <div className="tbl-wrap mb16">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.member.kind')}</th><th scope="col">{t('admin.reason')}</th><th scope="col">{t('admin.member.by')}</th><th scope="col">{t('admin.member.period')}</th><th scope="col" /></tr></thead>
            <tbody>
              {m.sanctions.map((s) => (
                <tr key={s.id}>
                  <td><span className={`pill ${isActive(s) ? 'red' : ''}`}>{t(`admin.sanction.${s.kind}` as MessageKey)}</span></td>
                  <td>{s.reason}</td>
                  <td>{s.issued_by ? `u/${s.issued_by}` : t('admin.system')}</td>
                  <td>
                    {formatDate(s.starts_at, locale)} → {s.ends_at ? formatDate(s.ends_at, locale) : '∞'}
                    {s.revoked_at ? <span className="xs muted">{t('admin.member.lifted', { by: s.revoked_by ?? '—', date: formatDate(s.revoked_at, locale) })}</span> : null}
                  </td>
                  <td>
                    {isActive(s) ? (
                      <ActionForm action={revokeSanctionAction} label={t('admin.member.lift')} submit={t('admin.member.lift')}
                        consequence={t('admin.member.liftHelp')} hidden={{ sanctionId: s.id }} labels={reasonLabels} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mb8">{t('admin.member.strikes')}</h3>
      {m.strikes.length === 0 ? <p className="small muted mb16">{t('admin.member.none')}</p> : (
        <div className="tbl-wrap mb16">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.reason')}</th><th scope="col" className="num">{t('admin.member.points')}</th><th scope="col">{t('admin.member.expires')}</th><th scope="col" /></tr></thead>
            <tbody>
              {m.strikes.map((s) => (
                <tr key={s.id}>
                  <td><span className={`pill ${s.active ? 'red' : ''}`}>{t(`admin.strike.${s.reason}` as MessageKey)}</span></td>
                  <td className="num">−{s.points}</td>
                  <td>{s.revoked_at ? t('admin.member.removed') : formatDate(s.expires_at, locale)}</td>
                  <td>
                    {s.active ? (
                      <ActionForm action={revokeStrikeAction} label={t('admin.member.removeStrike')} submit={t('admin.member.removeStrike')}
                        consequence={t('admin.member.removeStrikeHelp', { n: s.points })} hidden={{ strikeId: s.id }} labels={reasonLabels}
                        reasons={[t('admin.reasons.mistake'), t('admin.reasons.wrongMember')]} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mb8">{t('admin.member.ledger')}</h3>
      <p className="xs faint mb8">{t('admin.member.ledgerHelp')}</p>
      {m.ledger.length === 0 ? <p className="small muted">{t('admin.member.none')}</p> : (
        <ul className="ledger">
          {m.ledger.map((l, i) => (
            <li key={`${l.created_at}-${i}`}>
              <span>{t(`ledger.reason.${l.reason}` as MessageKey)} <span className="xs faint">· {l.track === 'karma' ? t('admin.metric.karma') : t('admin.member.modXp')}</span></span>
              <span className={`d ${l.delta > 0 ? 'pos' : 'neg'}`}>{l.delta > 0 ? '+' : ''}{l.delta}</span>
              <span className="xs faint">{relativeTime(l.created_at, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ModerationTab({ m, t, locale }: { m: AdminMember; t: Translate; locale: string }) {
  return (
    <>
      <h3 className="mb8">{t('admin.member.actionsOn')}</h3>
      {m.actions.length === 0 ? <p className="small muted mb16">{t('admin.member.none')}</p> : (
        <div className="tbl-wrap mb16">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.log.action')}</th><th scope="col">{t('admin.member.by')}</th><th scope="col">{t('admin.reason')}</th><th scope="col">{t('admin.date')}</th></tr></thead>
            <tbody>
              {m.actions.map((a) => (
                <tr key={a.id}>
                  <td>{t(`admin.action.${a.action}` as MessageKey)}</td>
                  <td>{a.actor ? `u/${a.actor}` : t('admin.system')}</td>
                  <td>{a.reason}</td>
                  <td>{formatDate(a.created_at, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className="mb8">{t('admin.member.appeals')}</h3>
      {m.appeals.length === 0 ? <p className="small muted">{t('admin.member.none')}</p> : (
        <ul className="caps">
          {m.appeals.map((a) => (
            <li key={a.id}>
              <span>{a.body}{a.decision_note ? <span className="xs faint" style={{ display: 'block' }}>{a.decided_by ? `u/${a.decided_by}: ` : ''}{a.decision_note}</span> : null}</span>
              <span className={`pill ${a.status === 'upheld' ? 'green' : a.status === 'open' ? 'amber' : ''}`}>{t(`admin.appeal.${a.status}` as MessageKey)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function NotesTab({ m, t, locale }: { m: AdminMember; t: Translate; locale: string }) {
  return (
    <>
      <p className="small muted mb12">{t('admin.member.notesSummary', { notes: m.counts.notes, helpful: m.counts.notes_helpful, ratings: m.counts.ratings, impact: m.rater_impact })}</p>
      {m.notes_written.length === 0 ? <EmptyState title={t('admin.member.noNotes')} /> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.member.onPost')}</th><th scope="col">{t('admin.status')}</th><th scope="col">{t('admin.date')}</th></tr></thead>
            <tbody>
              {m.notes_written.map((n) => (
                <tr key={n.id}>
                  <td><Link className="link" href={`/notes/${n.id}`}>{n.post_title}</Link></td>
                  <td>
                    <span className="pill">{t(`notes.status.${n.locked_status ?? n.status}` as MessageKey)}</span>
                    {n.hidden ? <span className="pill red">{t('admin.content.hidden')}</span> : null}
                  </td>
                  <td>{formatDate(n.created_at, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function StaffTab({ m, t }: { m: AdminMember; t: Translate }) {
  return (
    <>
      <ActionForm action={staffNoteAction} label={t('admin.member.addNote')} submit={t('admin.member.addNote')} requireReason={false}
        consequence={t('admin.member.noteHelp')} hidden={{ userId: m.id }} labels={{ reason: t('admin.reason') }}>
        <div className="field">
          <label htmlFor="note-label">{t('admin.member.noteLabel')}</label>
          <select id="note-label" name="label" className="input" defaultValue="note">
            {STAFF_NOTE_LABELS.map((l) => <option key={l} value={l}>{t(`admin.noteLabel.${l}` as MessageKey)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="note-body">{t('admin.member.noteBody')}</label>
          <textarea id="note-body" name="body" className="input" rows={3} minLength={3} maxLength={1000} required />
        </div>
      </ActionForm>
      {m.staff_notes.length === 0 ? <p className="small muted mt12">{t('admin.member.noStaffNotes')}</p> : (
        <ul className="caps mt12">
          {m.staff_notes.map((n) => (
            <li key={n.id}>
              <span><span className="pill">{t(`admin.noteLabel.${n.label}` as MessageKey)}</span> {n.body}</span>
              <span className="xs faint" style={{ whiteSpace: 'nowrap' }}>u/{n.author} · {relativeTime(n.created_at, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default async function AdminMemberPage({ params, searchParams }: { params: Promise<{ username: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [t, locale, { username }, query] = await Promise.all([getT(), getLocale(), params, searchParams]);
  const tab: Tab = TABS.includes(query.tab as Tab) ? (query.tab as Tab) : 'activity';
  const [result, overview] = await Promise.all([adminMember(decodeURIComponent(username)), adminOverview()]);
  if (!result.ok) return <DataUnavailable result={result} t={t} />;
  const m = result.data;
  const base = `/admin/people/${encodeURIComponent(m.username)}`;
  const reasonLabels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const active = m.sanctions.find(isActive);
  const founding = m.rater_status === 'founding' && m.founding_until;
  const writingLocked = isFuture(m.writing_locked_until);
  const canSanction = !m.is_admin && !m.is_self && !m.deleted_at;
  const in90 = isoDateInDays(90);
  const owner = overview.ok ? overview.data.owner : null;
  const isOwner = overview.ok && overview.data.is_owner;

  return (
    <>
      <p className="small mb12"><Link className="link" href="/admin/people">← {t('admin.people.title')}</Link></p>
      <div className="card card-p mb16">
        <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
          <Avatar name={m.username} size="lg" />
          <div className="grow" style={{ minWidth: 220 }}>
            <h1 tabIndex={-1} className="row wrap" style={{ gap: 8 }}>u/{m.username} <TierBadge tier={m.tier} t={t} /></h1>
            <div className="row wrap mt8" style={{ gap: 4 }}>
              {m.is_admin ? <span className="pill blue">{t(m.username === owner ? 'admin.role.owner' : 'admin.role.admin')}</span> : null}
              {m.is_moderator ? <span className="pill blue">{t('admin.role.moderator')}</span> : null}
              {founding ? <span className="pill green">{t('admin.role.foundingUntil', { date: formatDate(m.founding_until as string, locale) })}</span> : null}
              {active ? <span className="pill red">{t(`admin.sanction.${active.kind}` as MessageKey)}</span> : null}
              {m.needs_onboarding ? <span className="pill amber">{t('admin.people.onboarding')}</span> : null}
              {m.deleted_at ? <span className="pill">{t('admin.people.deleted')}</span> : null}
              {m.signals.map((s) => <span key={s} className="pill amber" title={t(`admin.signalHelp.${s}` as MessageKey)}><Icon name="alert" />{t(`admin.signal.${s}` as MessageKey)}</span>)}
            </div>
          </div>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Facts rows={[
              [t('admin.people.joined'), formatDate(m.created_at, locale)],
              [t('admin.people.signIn'), (m.account.providers.length ? m.account.providers : [m.account.provider]).map((p) => providerName(p) ?? t('admin.people.emailSignIn')).join(', ')],
              [t('admin.member.email'), (
                <span key="email">
                  {m.account.email_masked ?? '—'} {m.account.email_confirmed ? '' : <span className="pill amber">{t('admin.member.unconfirmed')}</span>}
                  {m.account.email_masked ? (
                    <ActionForm action={revealEmailAction} label={t('admin.member.reveal')} submit={t('admin.member.reveal')}
                      consequence={t('admin.member.revealHelp')} hidden={{ userId: m.id }} labels={reasonLabels}
                      reasons={[t('admin.reasons.privacyRequest'), t('admin.reasons.support'), t('admin.reasons.legal')]} />
                  ) : null}
                </span>
              )],
              [t('admin.member.lastSignIn'), m.account.last_sign_in_at ? relativeTime(m.account.last_sign_in_at, t) : '—'],
              [t('admin.member.mfa'), m.account.mfa ? t('admin.yes') : t('admin.no')],
            ]} />
          </div>
        </div>
      </div>

      <div className="stats mb16">
        {([
          ['admin.metric.karma', m.karma.toLocaleString()],
          ['admin.member.modXp', String(m.mod_xp)],
          ['admin.member.integrity', String(m.integrity)],
          ['admin.member.raterImpact', String(m.rater_impact)],
          ['admin.member.writerImpact', String(m.writer_impact)],
          ['admin.member.posts', t('admin.member.ofRemoved', { n: m.counts.posts, removed: m.counts.posts_removed })],
          ['admin.member.comments', t('admin.member.ofRemoved', { n: m.counts.comments, removed: m.counts.comments_removed })],
          ['admin.member.reportsFiled', t('admin.member.accuracy', {
            n: m.counts.reports_filed,
            pct: percent(m.counts.reports_actioned, m.counts.reports_actioned + m.counts.reports_abusive) ?? '—',
          })],
          ['admin.member.reportsReceived', String(m.counts.reports_received_30d)],
        ] as const).map(([label, value]) => (
          <div key={label} className="stat"><div className="l">{t(label)}</div><div className="v" style={{ fontSize: 16, lineHeight: 1.3 }}>{value}</div></div>
        ))}
      </div>

      <div className="grid2 side300">
        <div className="card card-p">
          <nav className="tabs" aria-label={t('admin.member.sections')}>
            {TABS.map((x) => <Link key={x} href={`${base}?tab=${x}`} aria-current={x === tab ? 'page' : undefined}>{t(`admin.member.tab.${x}` as MessageKey)}</Link>)}
          </nav>
          {tab === 'activity' ? <ActivityTab m={m} t={t} locale={locale} /> : null}
          {tab === 'standing' ? <StandingTab m={m} t={t} locale={locale} reasonLabels={reasonLabels} /> : null}
          {tab === 'moderation' ? <ModerationTab m={m} t={t} locale={locale} /> : null}
          {tab === 'notes' ? <NotesTab m={m} t={t} locale={locale} /> : null}
          {tab === 'staff' ? <StaffTab m={m} t={t} /> : null}
        </div>

        <aside className="card card-p actions-panel" aria-label={t('admin.member.actions')}>
          <h2 style={{ fontSize: 15 }}>{t('admin.member.actions')}</h2>
          <p className="xs faint">{t('admin.member.karmaNote')}</p>

          <div className="grp">
            <span className="sec-lbl">{t('admin.member.restrict')}</span>
            {canSanction ? (
              <div className="row" style={{ gap: 6 }}>
                {(['warning', 'freeze', 'suspension', 'ban'] as const).map((kind) => (
                  <ActionForm key={kind} action={sanctionAction} label={t(`admin.sanctionVerb.${kind}` as MessageKey)}
                    submit={t(`admin.sanctionVerb.${kind}` as MessageKey)} tone={kind === 'ban' || kind === 'suspension' ? 'danger' : 'normal'}
                    consequence={t(`admin.sanctionHelp.${kind}` as MessageKey, { user: m.username })}
                    hidden={{ userId: m.id, kind }} labels={reasonLabels}
                    reasons={[t('admin.reasons.sourcing'), t('admin.reasons.harassment'), t('admin.reasons.spam'), t('admin.reasons.evasion')]}>
                    {kind === 'freeze' || kind === 'suspension' ? (
                      <div className="field">
                        <label htmlFor={`days-${kind}`}>{t('admin.member.days')}</label>
                        <input id={`days-${kind}`} name="days" type="number" min={1} max={365} defaultValue={kind === 'freeze' ? 7 : 30} className="input" required />
                      </div>
                    ) : null}
                  </ActionForm>
                ))}
              </div>
            ) : <p className="xs muted">{t(m.is_self ? 'admin.member.selfNote' : m.is_admin ? 'admin.member.adminNote' : 'admin.member.deletedNote')}</p>}
          </div>

          <div className="grp">
            <span className="sec-lbl">{t('admin.member.roles')}</span>
            {!isOwner && !m.is_self ? (
              <p className="xs muted">{owner ? t('admin.member.ownerOnly', { owner }) : t('admin.team.noOwner')}</p>
            ) : null}
            {isOwner && !m.is_self && !m.deleted_at ? (
              <ActionForm action={setRoleAction} label={t(m.is_admin ? 'admin.member.removeAdmin' : 'admin.member.makeAdmin')}
                submit={t(m.is_admin ? 'admin.member.removeAdmin' : 'admin.member.makeAdmin')} tone={m.is_admin ? 'danger' : 'normal'}
                consequence={t(m.is_admin ? 'admin.member.removeAdminHelp' : 'admin.member.makeAdminHelp')}
                hidden={{ username: m.username, admin: m.is_admin ? 'false' : 'true' }} labels={reasonLabels} />
            ) : null}
            {!m.deleted_at && !m.is_self ? (
              m.is_moderator ? (
                <ActionForm action={setModeratorAction} label={t('admin.member.removeModerator')} submit={t('admin.member.remove')}
                  tone="danger" consequence={t('admin.member.removeModeratorHelp')} hidden={{ username: m.username, appoint: 'false' }} labels={reasonLabels} />
              ) : (
                <ActionForm action={setModeratorAction} label={t('admin.member.makeModerator')} submit={t('admin.member.appoint')}
                  consequence={t('admin.member.appointHelp')} hidden={{ username: m.username, appoint: 'true' }} labels={reasonLabels} />
              )
            ) : null}
          </div>

          <div className="grp">
            <span className="sec-lbl">{t('admin.member.notesRole')}</span>
            {!m.deleted_at ? (
              <ActionForm action={foundingAction} label={t(founding ? 'admin.member.extendFounding' : 'admin.member.makeFounding')}
                submit={t('admin.save')} consequence={t('admin.member.foundingHelp')} hidden={{ username: m.username }} labels={reasonLabels}>
                <div className="field">
                  <label htmlFor="founding-until">{t('admin.member.until')}</label>
                  <input id="founding-until" name="until" type="date" className="input" defaultValue={founding ? (m.founding_until as string).slice(0, 10) : in90} required />
                </div>
              </ActionForm>
            ) : null}
            {founding ? (
              <ActionForm action={foundingAction} label={t('admin.member.endFounding')} submit={t('admin.member.endFounding')} tone="danger"
                hidden={{ username: m.username, end: 'true' }} labels={reasonLabels} />
            ) : null}
            {writingLocked ? (
              <ActionForm action={clearWritingLockAction} label={t('admin.member.clearLock')} submit={t('admin.member.clearLock')}
                consequence={t('admin.member.clearLockHelp', { date: formatDate(m.writing_locked_until as string, locale) })}
                hidden={{ userId: m.id }} labels={reasonLabels} />
            ) : null}
          </div>

          {!m.deleted_at ? (
            <div className="grp">
              <span className="sec-lbl">{t('admin.member.account')}</span>
              <ActionForm action={renameMemberAction} label={t('admin.member.rename')} submit={t('admin.member.rename')}
                consequence={t('admin.member.renameHelp')} hidden={{ userId: m.id }} labels={reasonLabels}
                reasons={[t('admin.reasons.offensiveName'), t('admin.reasons.impersonation'), t('admin.reasons.vendorName')]}>
                <div className="field">
                  <label htmlFor="new-username">{t('admin.member.newUsername')}</label>
                  <input id="new-username" name="username" className="input" pattern="[A-Za-z0-9_]{3,20}" required />
                </div>
              </ActionForm>
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );
}
