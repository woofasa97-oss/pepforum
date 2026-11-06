import { CAPABILITIES } from '@pepforum/database';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { AppealForm } from '@/components/standing/AppealForm';
import { TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { describeRequirement } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { getLocale, getStanding, getT } from '@/server/context';
import { getActionsOnMe, getMyLedger } from '@/server/queries';

export const metadata: Metadata = { title: 'Standing', robots: { index: false } };

const KNOWN_REASONS = new Set([
  'post_votes', 'comment_votes', 'note_written', 'note_rating', 'note_strike', 'mod_removal',
  'appeal_reversal', 'report_upheld', 'report_abusive', 'seed', 'social_verified',
]);

export default async function StandingPage() {
  const [t, locale, standing] = await Promise.all([getT(), getLocale(), getStanding()]);
  if (!standing) redirect('/auth/sign-in?next=/karma');
  const [ledger, actionsOnMe] = await Promise.all([getMyLedger(), getActionsOnMe()]);

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('standing.title')}</h1>
            <p>{t('standing.sub')}</p>
          </div>
        </div>

        <div className="stats mb16">
          <div className="stat"><div className="v">{standing.karma.toLocaleString()}</div><div className="l">{t('standing.karma')} · {t(`tier.${standing.tier}` as MessageKey)}</div></div>
          <div className="stat"><div className="v">{Number(standing.mod_xp).toLocaleString()}</div><div className="l">{t('standing.modXp')}</div></div>
          <div className="stat"><div className="v">{standing.integrity}</div><div className="l">{t('standing.integrity')}</div></div>
          <div className="stat"><div className="v">{standing.rater_impact}</div><div className="l">{t('standing.raterImpact')}</div></div>
        </div>
        <p className="small mb16">{t('standing.raterStatus')}: <b>{t(`standing.rater.${standing.rater_status}` as MessageKey)}</b></p>

        {standing.writing_locked_until && new Date(standing.writing_locked_until) > new Date() ? (
          <div className="banner warn mb16"><Icon name="lock" /><div>{t('standing.writingLocked', { date: formatDate(standing.writing_locked_until, locale) })}</div></div>
        ) : null}

        <div className="grid2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <section className="card card-p" aria-labelledby="ladder-h">
            <h2 id="ladder-h" style={{ fontSize: 15 }}>{t('standing.ladder')}</h2>
            <ol className="ladder mt12">
              {standing.tier_thresholds.map((threshold, tier) => (
                <li key={tier} style={{ opacity: tier > standing.tier ? 0.6 : 1 }}>
                  <TierBadge tier={tier} t={t} />
                  <div>
                    <div className="t">{t(`tier.${tier}` as MessageKey)} · {threshold.toLocaleString()}+</div>
                    <div className="d">{t(`tier.desc.${tier}` as MessageKey)}</div>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="card card-p" aria-labelledby="caps-h">
            <h2 id="caps-h" style={{ fontSize: 15 }}>{t('standing.capabilities')}</h2>
            <ul className="caps mt8">
              {CAPABILITIES.map((cap) => {
                const reason = standing.capabilities[cap];
                return (
                  <li key={cap}>
                    <span>{t(`cap.${cap}` as MessageKey)}</span>
                    <span className={reason ? 'faint' : 'pos'}>{reason ? describeRequirement(reason, t) : <><Icon name="check" /> {t('cap.allowed')}</>}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <section className="card card-p mt16" aria-labelledby="strikes-h">
          <h2 id="strikes-h" style={{ fontSize: 15 }}>{t('standing.strikes')}</h2>
          {standing.active_strikes.length === 0 ? (
            <p className="small muted mt8">{t('standing.noStrikes')}</p>
          ) : (
            <ul className="caps mt8">
              {standing.active_strikes.map((s, i) => (
                <li key={i}><span>{s.reason}</span><span className="neg">−{s.points} · {formatDate(s.expires_at, locale)}</span></li>
              ))}
            </ul>
          )}
          {standing.active_sanctions.length > 0 ? (
            <>
              <h3 className="mt16">{t('standing.sanctions')}</h3>
              <ul className="caps mt8">
                {standing.active_sanctions.map((s, i) => (
                  <li key={i}><span>{s.kind}: {s.reason}</span><span className="faint">{s.ends_at ? formatDate(s.ends_at, locale) : '∞'}</span></li>
                ))}
              </ul>
            </>
          ) : null}
        </section>

        {actionsOnMe.length > 0 ? (
          <section className="card card-p mt16" aria-labelledby="appeals-h">
            <h2 id="appeals-h" style={{ fontSize: 15 }}>{t('mod.appeals')}</h2>
            <ul className="caps mt8">
              {actionsOnMe.map((a) => (
                <li key={a.id} style={{ display: 'block' }}>
                  <div className="row between"><span className="bold">{a.action} · {a.reason}</span><span className="xs faint">{formatDate(a.created_at, locale)}</span></div>
                  {a.appeal ? <span className="pill mt8">{a.appeal.status}</span> : <AppealForm modActionId={a.id} labels={{ body: t('mod.reason'), submit: t('report.submit') }} />}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="card mt16" aria-labelledby="ledger-h">
          <div className="card-p"><h2 id="ledger-h" style={{ fontSize: 15 }}>{t('standing.ledger')}</h2></div>
          {ledger.length === 0 ? <p className="small muted card-p">{t('standing.ledgerEmpty')}</p> : (
            <table className="tbl">
              <tbody>
                {ledger.map((e) => (
                  <tr key={e.id}>
                    <td>{t(`ledger.reason.${KNOWN_REASONS.has(e.reason) ? e.reason : 'other'}` as MessageKey)}</td>
                    <td className="faint xs">{e.track === 'karma' ? t('standing.karma') : t('standing.modXp')}</td>
                    <td className={`num ${Number(e.delta) > 0 ? 'pos' : 'neg'}`}>{Number(e.delta) > 0 ? '+' : ''}{Number(e.delta)}</td>
                    <td className="faint xs">{formatDate(e.created_at, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card card-p mt16">
          <h2 style={{ fontSize: 15 }}>{t('standing.howEarned')}</h2>
          <p className="small muted mt8">{t('standing.howEarnedBody')}</p>
        </section>
      </main>
    </div>
  );
}
