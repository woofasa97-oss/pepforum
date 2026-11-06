/**
 * How each app_config key is presented in /admin/settings: its group, the
 * input to edit it with and its unit. Ranges come from app_config.bounds (the
 * database checks them). Labels and help text live in the web app's i18n files
 * under `admin.cfg.<key>` and `admin.cfgHelp.<key>`.
 *
 * A database test asserts this list covers exactly the keys in app_config.
 */
export const CONFIG_GROUPS = ['access', 'votes', 'notes', 'scoring', 'reports', 'penalties', 'features', 'rate_limits', 'security'] as const;
export type ConfigGroup = (typeof CONFIG_GROUPS)[number];

export type ConfigInput =
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'tier'
  | 'tiers'          // five increasing karma thresholds
  | 'rate_limit'     // { limit, window_seconds }
  | 'scoring_mode'   // "bootstrap" | "bridging"
  | 'classifications'
  | 'announcement';  // edited on the Announcement tab

export type ConfigUnit = 'days' | 'hours' | 'karma' | 'xp' | 'points' | 'integrity' | 'ratings' | 'votes' | 'raters' | 'ratio' | 'microcad' | 'bytes' | 'images';

export type ConfigField = {
  readonly key: string;
  readonly group: ConfigGroup | 'site';
  readonly input: ConfigInput;
  readonly unit?: ConfigUnit;
  /** Changing it weakens a protection; the editor shows a warning. */
  readonly sensitive?: true;
};

const f = (key: string, group: ConfigField['group'], input: ConfigInput, unit?: ConfigUnit, sensitive?: true): ConfigField =>
  ({ key, group, input, ...(unit ? { unit } : {}), ...(sensitive ? { sensitive } : {}) });

export const CONFIG_FIELDS: readonly ConfigField[] = [
  // Who can do what
  f('tiers.thresholds', 'access', 'tiers', 'karma'),
  f('tiers.demotion_ratio', 'access', 'decimal', 'ratio'),
  f('gates.post_text.min_tier', 'access', 'tier'),
  f('gates.post_link.min_tier', 'access', 'tier'),
  f('links.require_approval', 'access', 'boolean'),
  f('gates.posting.min_integrity', 'access', 'integer', 'integrity'),
  f('gates.posting.cooldown_integrity', 'access', 'integer', 'integrity'),
  f('gates.rate_notes.min_tier', 'access', 'tier'),
  f('gates.rate_notes.min_account_days', 'access', 'integer', 'days'),
  f('gates.rate_notes.min_integrity', 'access', 'integer', 'integrity'),
  f('gates.rate_notes.require_phone', 'access', 'boolean'),
  f('gates.write_notes.min_tier', 'access', 'tier'),
  f('gates.write_notes.min_integrity', 'access', 'integer', 'integrity'),
  f('gates.steward.min_karma', 'access', 'integer', 'karma'),
  f('gates.steward.min_mod_xp', 'access', 'integer', 'xp'),
  f('gates.steward.min_integrity', 'access', 'integer', 'integrity'),

  // Votes and karma
  f('gates.vote_counts.min_account_days', 'votes', 'integer', 'days', true),
  f('gates.vote_counts.min_integrity', 'votes', 'integer', 'integrity', true),
  f('karma.vote_floor_per_item', 'votes', 'integer', 'karma'),
  f('karma.max_counted_votes_per_voter_author_30d', 'votes', 'integer', 'votes', true),
  f('karma.max_counted_votes_per_author_day', 'votes', 'integer', 'votes', true),

  // Community notes
  f('notes.min_ratings', 'notes', 'integer', 'ratings'),
  f('notes.graduation_impact', 'notes', 'integer'),
  f('notes.demotion_impact', 'notes', 'integer'),
  f('notes.unassigned_weight', 'notes', 'decimal', 'ratio', true),
  f('notes.lock_stable_hours', 'notes', 'integer', 'hours'),
  f('notes.max_age_days', 'notes', 'integer', 'days'),
  f('notes.correction_window_hours', 'notes', 'integer', 'hours'),
  f('notes.writer_helpful_xp', 'notes', 'integer', 'xp'),
  f('notes.writer_helpful_bonus_cap', 'notes', 'integer', 'xp'),
  f('notes.writer_not_helpful_xp', 'notes', 'integer', 'xp'),
  f('notes.rater_xp_scale', 'notes', 'decimal'),
  f('notes.base_rate_window_days', 'notes', 'integer', 'days'),
  f('notes.base_rate_min_samples', 'notes', 'integer', 'ratings'),
  f('notes.writer_lock_window', 'notes', 'integer'),
  f('notes.writer_lock_min_not_helpful', 'notes', 'integer'),
  f('notes.writer_lock_helpful_ratio', 'notes', 'decimal', 'ratio'),
  f('notes.writer_lock_days', 'notes', 'integer', 'days'),
  f('notes.strike_classifications', 'notes', 'classifications'),
  f('notes.author_penalty_karma', 'notes', 'integer', 'karma'),
  f('notes.author_penalty_cap_30d', 'notes', 'integer', 'karma'),

  // Scoring
  f('scoring.mode', 'scoring', 'scoring_mode'),
  f('scoring.bootstrap.helpful_lower_bound', 'scoring', 'decimal', 'ratio'),
  f('scoring.bootstrap.not_helpful_upper_bound', 'scoring', 'decimal', 'ratio'),
  f('scoring.bootstrap.z', 'scoring', 'decimal'),
  f('scoring.bridging.lambda_intercept', 'scoring', 'decimal'),
  f('scoring.bridging.lambda_factor', 'scoring', 'decimal'),
  f('scoring.bridging.helpful_intercept', 'scoring', 'decimal'),
  f('scoring.bridging.max_factor', 'scoring', 'decimal'),
  f('scoring.bridging.not_helpful_intercept', 'scoring', 'decimal'),
  f('scoring.bridging.not_helpful_factor_slope', 'scoring', 'decimal'),
  f('scoring.bridging.switch_min_raters', 'scoring', 'integer', 'raters'),

  // Reports and auto-collapse
  f('reports.min_account_days', 'reports', 'integer', 'days', true),
  f('reports.collapse_weight', 'reports', 'decimal'),
  f('reports.collapse_min_reporters', 'reports', 'integer', undefined, true),
  f('reports.steward_required_tier', 'reports', 'tier'),
  f('reports.collapse_review_hours', 'reports', 'integer', 'hours'),
  f('reports.upheld_xp', 'reports', 'integer', 'xp'),
  f('reports.abusive_xp', 'reports', 'integer', 'xp'),

  // Penalties and appeals
  f('strikes.duration_days', 'penalties', 'integer', 'days'),
  f('strikes.note_misleading_points', 'penalties', 'integer', 'points'),
  f('strikes.mod_removal_points', 'penalties', 'integer', 'points'),
  f('strikes.sourcing_points', 'penalties', 'integer', 'points'),
  f('strikes.sanction_points', 'penalties', 'integer', 'points'),
  f('moderation.removal_penalty_karma', 'penalties', 'integer', 'karma'),
  f('moderation.sourcing_penalty_karma', 'penalties', 'integer', 'karma'),
  f('moderation.removal_freeze_days', 'penalties', 'integer', 'days'),
  f('moderation.appeal_window_days', 'penalties', 'integer', 'days'),

  // Features ported from the prototype: uploads (…023), clinicians (…024), notifications (…022), ads (…025)
  f('gates.upload.min_tier', 'features', 'tier'),
  f('uploads.max_bytes', 'features', 'integer', 'bytes'),
  f('uploads.max_per_post', 'features', 'integer', 'images'),
  f('clinician.valid_days', 'features', 'integer', 'days'),
  f('notifications.retention_days', 'features', 'integer', 'days'),
  f('ads.enabled', 'features', 'boolean'),
  f('ads.cpm.zone', 'features', 'integer', 'microcad'),
  f('ads.cpm.category', 'features', 'integer', 'microcad'),
  f('ads.cpm.national', 'features', 'integer', 'microcad'),
  f('ads.min_booking_microcad', 'features', 'integer', 'microcad'),
  f('ads.flight_days', 'features', 'integer', 'days'),

  // Rate limits
  ...['vote', 'comment', 'post', 'post_newcomer', 'post_low_integrity', 'edit', 'note', 'rating', 'queue', 'report', 'report_member', 'appeal', 'export',
      'onboarding', 'open_ticket', 'ticket_reply', 'admin_action',
      'push_subscribe', 'notification_settings', 'upload', 'clinician_submit', 'ad_write', 'ad_report'].map((action) => f(`rate_limit.${action}`, 'rate_limits', 'rate_limit', undefined, true)),

  // Security
  f('security.require_mfa_for_staff', 'security', 'boolean', undefined, true),

  // Site (edited on the Announcement tab)
  f('site.announcement', 'site', 'announcement'),
];

export const CONFIG_FIELD_BY_KEY: ReadonlyMap<string, ConfigField> = new Map(CONFIG_FIELDS.map((field) => [field.key, field]));
