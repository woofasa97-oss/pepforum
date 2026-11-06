import type { StandingView } from '@pepforum/database';
import Link from 'next/link';

import { Avatar, Progress, TierBadge } from '@/components/ui/Bits';
import { describeRequirement } from '@/lib/errors';
import type { MessageKey, Translate } from '@/lib/i18n';

/** Compact standing summary for the right rail: both tracks and the next unlock. */
export function StandingCard({ standing, t }: { standing: StandingView; t: Translate }) {
  const thresholds = standing.tier_thresholds;
  const next = thresholds[standing.tier + 1];
  const floor = thresholds[standing.tier] ?? 0;
  return (
    <div className="card card-p">
      <div className="row">
        <Avatar name={standing.username} />
        <div>
          <Link className="bold" href={`/u/${standing.username}`}>u/{standing.username}</Link>
          <div className="xs faint row">
            <TierBadge tier={standing.tier} t={t} /> {t(`tier.${standing.tier}` as MessageKey)}
          </div>
        </div>
      </div>
      <div className="stats mt12" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <div className="stat" style={{ padding: 8 }}><div className="v" style={{ fontSize: 16 }}>{standing.karma.toLocaleString()}</div><div className="l">{t('standing.karma')}</div></div>
        <div className="stat" style={{ padding: 8 }}><div className="v" style={{ fontSize: 16 }}>{Number(standing.mod_xp).toLocaleString()}</div><div className="l">{t('standing.modXp')}</div></div>
        <div className="stat" style={{ padding: 8 }}><div className="v" style={{ fontSize: 16 }}>{standing.integrity}</div><div className="l">{t('standing.integrity')}</div></div>
      </div>
      {standing.is_admin ? (
        <p className="xs mt12"><span className="pill blue">{t('profile.admin')}</span> {t('standing.adminNote')}</p>
      ) : next !== undefined ? (
        <div className="mt12">
          <Progress value={standing.karma - floor} max={next - floor} label={t('standing.toNext', { n: next - standing.karma, tier: t(`tier.${standing.tier + 1}` as MessageKey) })} />
          <div className="xs faint mt8">{t('standing.toNext', { n: (next - standing.karma).toLocaleString(), tier: t(`tier.${standing.tier + 1}` as MessageKey) })}</div>
        </div>
      ) : null}
      <div className="xs mt8">
        {t('cap.rate_notes')}: <span className="faint">{describeRequirement(standing.capabilities.rate_notes, t)}</span>
        <br />
        {t('cap.write_notes')}: <span className="faint">{describeRequirement(standing.capabilities.write_notes, t)}</span>
      </div>
      <Link className="link small mt8" style={{ display: 'inline-block' }} href="/karma">{t('nav.karma')}</Link>
    </div>
  );
}
