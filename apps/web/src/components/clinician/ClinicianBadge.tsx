import type { ClinicianProfession } from '@pepforum/database';

import { Icon } from '@/components/ui/Icon';
import type { MessageKey, Translate } from '@/lib/i18n';

/** "Verified pharmacist" next to a name (…024). Context, never authority. */
export function ClinicianBadge({ profession, t, size = 'sm' }: { profession: ClinicianProfession | null | undefined; t: Translate; size?: 'sm' | 'md' }) {
  if (!profession) return null;
  const label = t('clinician.badge', { profession: t(`clinician.profession.${profession}` as MessageKey) });
  return (
    <span className={`pill green ${size === 'sm' ? 'xs' : ''}`} title={t('clinician.badgeHint')}>
      <Icon name="check" />{label}
    </span>
  );
}
