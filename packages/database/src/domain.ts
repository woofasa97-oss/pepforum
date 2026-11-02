/**
 * Domain vocabulary shared by the web app and the worker. Every list here
 * mirrors a CHECK constraint or validation in supabase/migrations; the
 * contract test (tests/contract.test.ts) fails if the two drift apart.
 */

export const TIERS = ['newcomer', 'member', 'trusted', 'contributor', 'steward'] as const;
export type Tier = (typeof TIERS)[number];
export type TierIndex = 0 | 1 | 2 | 3 | 4;

export const LOCALES = ['en', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

export const POST_TYPES = ['experience', 'claim', 'question', 'resource'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const CONTENT_STATUSES = ['visible', 'collapsed', 'held', 'removed', 'deleted'] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const NOTE_CLASSIFICATIONS = [
  'misleading',
  'missing_context',
  'outdated',
  'unverifiable',
  'opinion_as_fact',
  'satire',
] as const;
export type NoteClassification = (typeof NOTE_CLASSIFICATIONS)[number];

export const NOTE_STATUSES = ['needs_more_ratings', 'helpful', 'not_helpful'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const SOURCE_KINDS = ['journal', 'registry', 'gov', 'news', 'other'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const RATING_VALUES = ['helpful', 'somewhat', 'not_helpful'] as const;
export type RatingValue = (typeof RATING_VALUES)[number];

/** Allowed reason tags per rating value (private.rating_reasons_valid). */
export const RATING_REASONS = {
  helpful: ['cites_sources', 'clear', 'addresses_claim', 'neutral', 'important_context'],
  somewhat: ['sources_weak', 'partial', 'unclear', 'minor_errors'],
  not_helpful: ['no_sources', 'source_mismatch', 'off_topic', 'opinion', 'incorrect', 'argumentative', 'harassment'],
} as const satisfies Record<RatingValue, readonly string[]>;
export type RatingReason = (typeof RATING_REASONS)[RatingValue][number];

export const REPORT_REASONS = [
  'sourcing',
  'medical_advice',
  'harassment',
  'misinformation',
  'spam',
  'before_after',
  'wrong_place',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const VIOLATIONS = ['sourcing', 'medical_advice', 'harassment', 'misinformation', 'spam', 'before_after', 'other'] as const;
export type Violation = (typeof VIOLATIONS)[number];

export const RATER_STATUSES = ['none', 'probation', 'active', 'founding'] as const;
export type RaterStatus = (typeof RATER_STATUSES)[number];

export const CAPABILITIES = [
  'vote',
  'comment',
  'report',
  'post_text',
  'post_link',
  'rate_notes',
  'write_notes',
  'steward',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const SANCTION_KINDS = ['warning', 'freeze', 'suspension', 'ban'] as const;
export type SanctionKind = (typeof SANCTION_KINDS)[number];

export const REPORT_STATUSES = ['open', 'actioned', 'dismissed', 'abusive'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const APPEAL_STATUSES = ['open', 'upheld', 'denied'] as const;
export type AppealStatus = (typeof APPEAL_STATUSES)[number];

/** Every kind of entry in the moderation log (mod_actions.action). */
export const MOD_ACTIONS = [
  'remove', 'restore', 'auto_collapse', 'auto_uncollapse', 'dismiss_reports',
  'sanction', 'revoke_sanction', 'grant_founding_rater', 'appoint_moderator',
  'remove_moderator', 'appeal_upheld', 'appeal_denied', 'config_change',
  'grant_admin', 'revoke_admin', 'end_founding_rater', 'rename_user', 'revoke_strike', 'clear_writing_lock',
  'hide_note', 'unhide_note', 'pin', 'unpin', 'lock_comments', 'unlock_comments',
  'shield_rule_added', 'shield_rule_removed', 'shield_hold', 'taxonomy_change',
  'lookup_email', 'reveal_email',
] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];

/** Labels on staff notes (Reddit-style mod notes on a member). */
export const STAFF_NOTE_LABELS = ['note', 'watch', 'warned', 'good_contributor'] as const;
export type StaffNoteLabel = (typeof STAFF_NOTE_LABELS)[number];

/** Sourcing-shield phrase actions: hold for review, or reject outright. */
export const SHIELD_ACTIONS = ['hold', 'block'] as const;
export type ShieldAction = (typeof SHIELD_ACTIONS)[number];

/** SQLSTATE codes raised by the database (see 0001_foundation). */
export const DB_ERROR_CODES = {
  notAuthenticated: 'PF401',
  forbidden: 'PF403',
  notFound: 'PF404',
  conflict: 'PF409',
  invalidInput: 'PF422',
  mfaRequired: 'PF428',
  rateLimited: 'PF429',
  misconfigured: 'PF500',
} as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[keyof typeof DB_ERROR_CODES];

/** Source kind heuristics for note citations (the writer can override). */
export function inferSourceKind(url: string): SourceKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (/(^|\.)(doi\.org|nejm\.org|thelancet\.com|jamanetwork\.com|bmj\.com|nature\.com|ncbi\.nlm\.nih\.gov|pubmed\.ncbi\.nlm\.nih\.gov|sciencedirect\.com|cmaj\.ca)$/.test(host)) {
    return 'journal';
  }
  if (/(^|\.)(clinicaltrials\.gov|isrctn\.com|trialsearch\.who\.int)$/.test(host)) return 'registry';
  if (/(^|\.)(canada\.ca|gc\.ca|gouv\.qc\.ca|gov\.bc\.ca|ontario\.ca|alberta\.ca)$/.test(host) || host.endsWith('.gov')) return 'gov';
  if (/(^|\.)(cbc\.ca|radio-canada\.ca|theglobeandmail\.com|ctvnews\.ca|lapresse\.ca|nationalpost\.com)$/.test(host)) return 'news';
  return 'other';
}
