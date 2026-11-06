import type { SocialBadge } from '@pepforum/database';

import { ActionForm } from '@/components/admin/ActionForm';
import { Icon } from '@/components/ui/Icon';
import { compactNumber, formatDate } from '@/lib/format';
import type { Translate } from '@/lib/i18n';
import { PLATFORM_NAMES, audienceKey, displayHandle } from '@/lib/social-names';
import { adminUnlinkSocialAction } from '@/server/actions/admin';

/**
 * Verified social accounts on a profile (…028). Links are https-only (the
 * database checks) and carry nofollow ugc. Admins get a Remove action, which
 * also takes back the karma bonus and is logged.
 */
export function SocialBadges({ username, socials, t, locale, isAdmin }: {
  username: string;
  socials: readonly SocialBadge[];
  t: Translate;
  locale: string;
  isAdmin: boolean;
}) {
  if (socials.length === 0) return null;
  return (
    <ul className="social-badges mt8" aria-label={t('socials.title')}>
      {socials.map((s) => (
        <li key={s.platform}>
          <a className="pill social" href={s.url} rel="nofollow ugc noopener noreferrer"
            title={t('socials.verifiedOn', { date: formatDate(s.verified_at, locale) })}>
            <Icon name="check" />
            <b>{PLATFORM_NAMES[s.platform]}</b> {displayHandle(s.platform, s.handle)}
            <span className="faint">· {t(audienceKey(s.platform), { n: compactNumber(s.audience, locale) })}</span>
          </a>
          {isAdmin ? (
            <ActionForm action={adminUnlinkSocialAction} label={t('socials.adminRemove')} submit={t('socials.adminRemove')} tone="danger"
              consequence={t('socials.adminRemoveHelp', { platform: PLATFORM_NAMES[s.platform] })}
              hidden={{ username, platform: s.platform }} labels={{ reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') }}
              reasons={[t('socials.reasonVendor'), t('socials.reasonImpersonation')]} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
