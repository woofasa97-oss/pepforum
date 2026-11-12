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

/** Why a member reports another member (member_reports.reason, …019). */
export const MEMBER_REPORT_REASONS = [
  'harassment',
  'sourcing',
  'spam',
  'impersonation',
  'ban_evasion',
  'privacy',
  'underage',
  'other',
] as const;
export type MemberReportReason = (typeof MEMBER_REPORT_REASONS)[number];

/** How an admin closes the reports about a member. */
export const MEMBER_REPORT_OUTCOMES = ['actioned', 'dismissed'] as const;
export type MemberReportOutcome = (typeof MEMBER_REPORT_OUTCOMES)[number];

/** What a member writes to the team about (support_tickets.kind, …020). */
/** Networks a member can verify an account on (social_accounts.platform, …028). */
export const SOCIAL_PLATFORMS = ['x', 'youtube', 'instagram', 'tiktok', 'reddit'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const TICKET_KINDS = ['suggestion', 'report_member', 'report_content', 'bug', 'account', 'other'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/** open = waiting for the team; answered = waiting for the member. */
export const TICKET_STATUSES = ['open', 'answered', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

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
  'upload_image',
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
  'link_hold', 'link_approved', 'link_declined', 'site_approved', 'site_unapproved',
  'member_reports_actioned', 'member_reports_dismissed',
  'redirect_set', 'redirect_removed',
  'media_removed',
  'clinician_approved', 'clinician_rejected', 'clinician_revoked',
  'advertiser_approved', 'advertiser_suspended', 'ad_approved', 'ad_rejected', 'ad_suspended',
  'ad_payment_recorded', 'ad_adjustment', 'ad_report_resolved', 'social_unlinked',
  'price_vendor_saved', 'price_vendor_status', 'price_coa_saved', 'price_coa_status'
] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];

/** Labels on staff notes (Reddit-style mod notes on a member). */
export const STAFF_NOTE_LABELS = ['note', 'watch', 'warned', 'good_contributor'] as const;
export type StaffNoteLabel = (typeof STAFF_NOTE_LABELS)[number];

/** Sourcing-shield phrase actions: hold for review, or reject outright. */
export const SHIELD_ACTIONS = ['hold', 'block'] as const;
export type ShieldAction = (typeof SHIELD_ACTIONS)[number];

/** What a member says is wrong with an ad (ad_reports.reason, …025). */
export const AD_REPORT_REASONS = ['vendor', 'medical_claim', 'misleading', 'offensive', 'other'] as const;
export type AdReportReason = (typeof AD_REPORT_REASONS)[number];

/** Where a campaign runs (ad_campaigns.package, …025). */
export const AD_PACKAGES = ['zone', 'category', 'national'] as const;
export type AdPackage = (typeof AD_PACKAGES)[number];

export const AD_CAMPAIGN_STATUSES = ['draft', 'review', 'approved', 'active', 'paused', 'rejected', 'completed', 'suspended'] as const;
export type AdCampaignStatus = (typeof AD_CAMPAIGN_STATUSES)[number];

export const ADVERTISER_STATUSES = ['pending', 'active', 'suspended'] as const;
export type AdvertiserStatus = (typeof ADVERTISER_STATUSES)[number];

/** Canadian provinces and territories, for advertiser billing (…025). */
export const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'] as const;
export type Province = (typeof PROVINCES)[number];

/** Health professions a member can be verified as (clinician_verifications.profession, …024). */
export const CLINICIAN_PROFESSIONS = ['physician', 'nurse_practitioner', 'registered_nurse', 'pharmacist', 'naturopathic_doctor', 'dietitian', 'other'] as const;
export type ClinicianProfession = (typeof CLINICIAN_PROFESSIONS)[number];

export const CLINICIAN_STATUSES = ['pending', 'approved', 'rejected', 'revoked', 'withdrawn'] as const;
export type ClinicianStatus = (typeof CLINICIAN_STATUSES)[number];

/** Kinds of uploads (media.kind, …023 / …025). */
export const MEDIA_KINDS = ['post_image', 'credential', 'ad_image', 'avatar'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const MEDIA_STATUSES = ['pending', 'ready', 'removed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** Image types accepted for post images; PDF is accepted for credentials only. */
export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/** What a notification is about (notifications.kind, …022 / …024 / …025). */
export const NOTIFICATION_KINDS = ['reply_post', 'reply_comment', 'note_outcome', 'note_on_post', 'mod_action', 'team_reply', 'clinician_review', 'ad_review', 'new_follower'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

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

// ── Price tracking (…030–…033) ──────────────────────────────────────────────
/** prices.vendors.status: only `active` vendors are read live and shown. */
export const PRICE_VENDOR_STATUSES = ['pending', 'active', 'paused', 'delisted'] as const;
export type PriceVendorStatus = (typeof PRICE_VENDOR_STATUSES)[number];

/** Where a vendor is based (prices.vendors.origin_country). */
export const PRICE_ORIGINS = ['US', 'CA', 'GB', 'AU', 'NZ', 'EU', 'OTHER'] as const;
export type PriceOrigin = (typeof PRICE_ORIGINS)[number];

export const PRICE_CURRENCIES = ['USD', 'CAD', 'GBP', 'AUD', 'NZD', 'EUR'] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

export const PRICE_AVAILABILITIES = ['in_stock', 'out_of_stock', 'backorder', 'preorder', 'discontinued', 'unknown'] as const;
export type PriceAvailability = (typeof PRICE_AVAILABILITIES)[number];

export const PRICE_COMPOUND_TYPES = ['Single compound', 'Copper complex', 'Blend'] as const;
export type PriceCompoundType = (typeof PRICE_COMPOUND_TYPES)[number];

/** What a certificate of analysis covers (prices.coa_documents.scope). */
export const COA_SCOPES = ['vendor', 'product', 'batch'] as const;
export type CoaScope = (typeof COA_SCOPES)[number];

/** The method a certificate names (prices.coa_documents.method). */
export const COA_METHODS = ['hplc', 'ms', 'hplc_ms', 'other'] as const;
export type CoaMethod = (typeof COA_METHODS)[number];

export const COA_STATUSES = ['candidate', 'published', 'withdrawn'] as const;
export type CoaStatus = (typeof COA_STATUSES)[number];
