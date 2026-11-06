/**
 * Maps database errors (custom PF SQLSTATEs, see supabase/migrations/0001) to
 * user-facing messages. Unknown errors become a generic message — internal
 * details never reach the browser.
 */
import { DB_ERROR_CODES } from '@pepforum/database';

import type { MessageKey, Translate } from '@/lib/i18n';

export interface DbErrorLike {
  readonly code?: string | null;
  readonly message?: string | null;
  readonly details?: string | null;
}

const SPECIFIC_MESSAGES = new Set<string>([
  'self_vote', 'own_post', 'own_note', 'own_content', 'already_reported', 'already_noted', 'note_locked',
  'thread_too_deep', 'invalid_source_url', 'conflict_of_interest', 'appeal_window_closed', 'already_appealed', 'no_changes',
  // Admin console and sourcing shield (…015, …016)
  'blocked_by_shield', 'comments_locked', 'pin_limit', 'already_pinned', 'last_admin', 'config_out_of_range', 'config_type_mismatch', 'reason_required', 'not_removed', 'already_hidden', 'not_hidden', 'username_taken', 'invalid_domain', 'invalid_phrase',
  // Link review (…018)
  'not_pending',
  // Member reports and the site owner (…019)
  'owner_only', 'report_self',
  // Contact the team (…020)
  'ticket_closed',
]);

const SIMPLE_REQUIREMENTS = new Set<string>([
  'not_authenticated', 'no_profile', 'onboarding', 'email_unconfirmed', 'sanctioned', 'frozen', 'writing_locked', 'phone_unconfirmed',
]);

/** Turns a capability reason key ("tier:2", "account_age:30", …) into a sentence fragment. */
export function describeRequirement(reason: string | null | undefined, t: Translate): string {
  if (!reason) return t('cap.allowed');
  const [kind = '', value = ''] = reason.split(':');
  switch (kind) {
    case 'tier':
      return t('req.tier', { tier: t(`tier.${value}` as MessageKey) });
    case 'account_age':
      return t('req.account_age', { days: value });
    case 'integrity':
      return t('req.integrity', { n: value });
    case 'rater_impact':
      return t('req.rater_impact', { n: value });
    case 'karma':
      return t('req.karma', { n: Number(value).toLocaleString() });
    case 'mod_xp':
      return t('req.mod_xp', { n: value });
    default:
      return SIMPLE_REQUIREMENTS.has(kind) ? t(`req.${kind}` as MessageKey) : t('req.unknown');
  }
}

export function messageForDbError(error: DbErrorLike, t: Translate): string {
  const code = error.code ?? '';
  const message = error.message ?? '';

  if (SPECIFIC_MESSAGES.has(message)) return t(`errors.${message}` as MessageKey);

  switch (code) {
    case DB_ERROR_CODES.forbidden:
      if (message === 'capability_denied') {
        // details = "<capability>:<reason>[:<value>]"
        const reason = (error.details ?? '').split(':').slice(1).join(':');
        return t('errors.capability', { reason: describeRequirement(reason, t) });
      }
      return t('errors.forbidden');
    case DB_ERROR_CODES.notAuthenticated:
      return t('errors.signInRequired');
    case DB_ERROR_CODES.notFound:
      return t('errors.notFound');
    case DB_ERROR_CODES.rateLimited:
      return error.details === 'post_newcomer' ? t('errors.rateLimitedNewcomer') : t('errors.rateLimited');
    case DB_ERROR_CODES.mfaRequired:
      return t('errors.mfaRequired');
    case DB_ERROR_CODES.invalidInput:
    case '23514': // check_violation (constraint backstop)
      return t('errors.invalid');
    case '42501': // insufficient_privilege
      return t('errors.forbidden');
    default:
      return t('errors.unexpected');
  }
}

/** Server-side log line for unexpected errors: codes only, never content. */
export function logUnexpected(context: string, error: DbErrorLike): void {
  if (Object.values(DB_ERROR_CODES).includes(error.code as never)) return;
  console.error(JSON.stringify({ level: 'error', context, code: error.code ?? 'unknown' }));
}
