import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { isWithinDays, isoDateInDays } from '@/lib/admin';
import { formatDate, relativeTime } from '@/lib/format';
import { foundingAction, setModeratorAction, setRoleAction } from '@/server/actions/admin';
import { adminOverview, adminTeam } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Team & access' };

export default async function AdminTeamPage() {
  const [t, locale, result, overview] = await Promise.all([getT(), getLocale(), adminTeam(), adminOverview()]);
  if (!result.ok) return <><PageHeader title={t('admin.team.title')} sub={t('admin.team.sub')} /><DataUnavailable result={result} t={t} /></>;
  const team = result.data;
  const reasonLabels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const withoutMfa = [...team.admins.filter((a) => !a.mfa).map((a) => a.username), ...team.moderators.filter((m) => !m.mfa).map((m) => m.username)];
  const member = (username: string) => <Link className="link" href={`/admin/people/${encodeURIComponent(username)}`}>u/{username}</Link>;
  const mfaPill = (on: boolean) => <span className={`pill ${on ? 'green' : 'red'}`}>{on ? <Icon name="check" /> : <Icon name="alert" />}{on ? t('admin.team.mfaOn') : t('admin.team.mfaOff')}</span>;
  const in90 = isoDateInDays(90);
  const owner = overview.ok ? overview.data.owner : null;
  const isOwner = overview.ok && overview.data.is_owner;

  return (
    <>
      <PageHeader title={t('admin.team.title')} sub={t('admin.team.sub')} />

      {withoutMfa.length > 0 ? (
        <div className="banner warn mb16" role="status"><Icon name="lock" /><div>{t('admin.team.mfaWarning', { names: [...new Set(withoutMfa)].map((u) => `u/${u}`).join(', ') })}</div></div>
      ) : null}

      <section className="admin-section card card-p" aria-labelledby="admins-h">
        <div className="row between wrap mb8">
          <h2 id="admins-h" style={{ fontSize: 16 }}>{t('admin.team.admins')}</h2>
          {isOwner ? (
            <ActionForm action={setRoleAction} label={t('admin.team.addAdmin')} submit={t('admin.member.makeAdmin')} tone="primary"
              consequence={t('admin.member.makeAdminHelp')} hidden={{ admin: 'true' }} labels={reasonLabels}
              reasons={[t('admin.team.reasonJoin')]}>
              <div className="field">
                <label htmlFor="admin-username">{t('admin.username')}</label>
                <input id="admin-username" name="username" className="input" pattern="[A-Za-z0-9_]{3,20}" required />
              </div>
            </ActionForm>
          ) : null}
        </div>
        <p className="small muted mb12">{t('admin.team.adminsHelp')}</p>
        {isOwner ? (
          <div className="banner info mb12">
            <Icon name="info" />
            <div>
              <b>{t('admin.team.howTo')}</b>
              <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 18, listStyle: 'decimal' }}>
                <li>{t('admin.team.howTo1')}</li>
                <li>{t('admin.team.howTo2')}</li>
                <li>{t('admin.team.howTo3')}</li>
              </ol>
              <p className="small mt8">{t('admin.team.howToRemove')}</p>
            </div>
          </div>
        ) : (
          <div className="banner warn mb12" role="status">
            <Icon name="lock" />
            <div className="small">{owner ? t('admin.team.ownerOnly', { owner }) : t('admin.team.noOwner')}</div>
          </div>
        )}
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.people.member')}</th><th scope="col">{t('admin.team.since')}</th><th scope="col">{t('admin.member.mfa')}</th><th scope="col">{t('admin.member.lastSignIn')}</th><th scope="col" className="num">{t('admin.team.actions30')}</th>{isOwner ? <th scope="col" /> : null}</tr></thead>
            <tbody>
              {team.admins.map((a) => (
                <tr key={a.username}>
                  <td>
                    {member(a.username)} {a.username === owner ? <span className="pill blue">{t('admin.role.owner')}</span> : null}
                    {a.is_self ? <span className="pill">{t('admin.team.you')}</span> : null}
                  </td>
                  <td>{formatDate(a.since, locale)}{a.granted_by ? <span className="xs muted">{t('admin.team.by', { user: a.granted_by })}</span> : null}</td>
                  <td>{mfaPill(a.mfa)}</td>
                  <td>{a.last_sign_in_at ? relativeTime(a.last_sign_in_at, t) : '—'}</td>
                  <td className="num">{a.actions_30d}</td>
                  {isOwner ? (
                    <td>
                      {a.is_self ? null : (
                        <ActionForm action={setRoleAction} label={t('admin.member.removeAdmin')} submit={t('admin.member.removeAdmin')} tone="danger"
                          consequence={t('admin.member.removeAdminHelp')} hidden={{ username: a.username, admin: 'false' }} labels={reasonLabels} />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-section card card-p" aria-labelledby="mods-h">
        <div className="row between wrap mb8">
          <h2 id="mods-h" style={{ fontSize: 16 }}>{t('admin.team.moderators')}</h2>
          <ActionForm action={setModeratorAction} label={t('admin.team.addModerator')} submit={t('admin.member.appoint')}
            consequence={t('admin.member.appointHelp')} hidden={{ appoint: 'true' }} labels={reasonLabels}>
            <div className="field">
              <label htmlFor="mod-username">{t('admin.username')}</label>
              <input id="mod-username" name="username" className="input" pattern="[A-Za-z0-9_]{3,20}" required />
            </div>
          </ActionForm>
        </div>
        {team.moderators.length === 0 ? <EmptyState title={t('admin.team.noModerators')} /> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th scope="col">{t('admin.people.member')}</th><th scope="col">{t('admin.member.mfa')}</th><th scope="col" className="num">{t('admin.team.actions30')}</th><th scope="col">{t('admin.team.lastAction')}</th><th scope="col" /></tr></thead>
              <tbody>
                {team.moderators.map((m) => (
                  <tr key={m.username}>
                    <td>{member(m.username)}</td>
                    <td>{mfaPill(m.mfa)}</td>
                    <td className="num">{m.actions_30d}</td>
                    <td>{m.last_action_at ? relativeTime(m.last_action_at, t) : '—'}</td>
                    <td>
                      <ActionForm action={setModeratorAction} label={t('admin.member.remove')} submit={t('admin.member.remove')} tone="danger"
                        hidden={{ username: m.username, appoint: 'false' }} labels={reasonLabels} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="xs faint mt8"><Link className="link" href="/admin/moderation?tab=performance">{t('admin.team.performanceLink')}</Link></p>
      </section>

      <section className="admin-section card card-p" aria-labelledby="founding-h">
        <div className="row between wrap mb8">
          <h2 id="founding-h" style={{ fontSize: 16 }}>{t('admin.team.founding')}</h2>
          <ActionForm action={foundingAction} label={t('admin.member.makeFounding')} submit={t('admin.save')}
            consequence={t('admin.member.foundingHelp')} labels={reasonLabels}>
            <div className="field">
              <label htmlFor="founding-username">{t('admin.username')}</label>
              <input id="founding-username" name="username" className="input" pattern="[A-Za-z0-9_]{3,20}" required />
            </div>
            <div className="field">
              <label htmlFor="founding-until-team">{t('admin.member.until')}</label>
              <input id="founding-until-team" name="until" type="date" className="input" defaultValue={in90} required />
            </div>
          </ActionForm>
        </div>
        <p className="small muted mb12">{t('admin.team.foundingHelp')}</p>
        {team.founding.length === 0 ? <EmptyState title={t('admin.team.noFounding')} /> : (
          <ul className="caps">
            {team.founding.map((f) => (
              <li key={f.username}>
                <span>{member(f.username)} <span className="xs faint">· {t('admin.team.impact', { n: f.rater_impact })}</span></span>
                <span className={`pill ${isWithinDays(f.until, 14) ? 'amber' : ''}`}>{t('admin.team.until', { date: formatDate(f.until, locale) })}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="admin-section card card-p" aria-labelledby="stewards-h">
        <h2 id="stewards-h" style={{ fontSize: 16 }} className="mb8">{t('admin.team.stewards')}</h2>
        <p className="small muted mb12">{t('admin.team.stewardsHelp')}</p>
        {team.stewards.length === 0 ? <EmptyState title={t('admin.team.noStewards')} /> : (
          <ul className="caps">
            {team.stewards.map((s) => (
              <li key={s.username}><span>{member(s.username)}</span><span className="xs muted">{s.karma.toLocaleString()} karma · {s.mod_xp} XP</span></li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
