/**
 * Shapes returned by the admin console RPCs (migrations …015 and …016).
 * Every one of these functions requires an admin in an MFA (aal2) session.
 */
import type {
  AppealStatus,
  ContentStatus,
  ModAction,
  NoteClassification,
  NoteStatus,
  RaterStatus,
  ReportReason,
  SanctionKind,
  ShieldAction,
  StaffNoteLabel,
  Violation,
} from './domain.ts';

export type JobName = 'score_notes' | 'maintenance' | 'process_deletions';

export type AdminOverview = {
  reports_open: number;
  reports_oldest: string | null;
  appeals_open: number;
  appeals_admin_only: number;
  collapsed: number;
  collapsed_next_reopen: string | null;
  held: number;
  jobs: Partial<Record<JobName, { at: string; ok: boolean }>>;
  last_scoring_run: string | null;
  security_problems: number;
  staff_without_mfa: number;
  founding_expiring: number;
  deletions_pending: number;
  deletions_oldest: string | null;
  scoring_mode: 'bootstrap' | 'bridging';
  bridging_ready: boolean;
};

export const METRIC_KEYS = [
  'signups', 'signups_social', 'active', 'posts', 'comments', 'notes', 'notes_shown', 'ratings', 'reports', 'removals',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export type AdminMetrics = {
  /** ISO dates (Eastern time), oldest first; aligned with every series. */
  days: string[];
  series: Record<MetricKey, number[]>;
  totals: Record<MetricKey, { current: number; previous: number }>;
  quality: {
    reports_actioned_pct: number | null;
    median_review_hours: number | null;
    appeals_overturned_pct: number | null;
    posts_with_helpful_note_pct: number | null;
    collapses_reopened_unreviewed: number;
  };
};

export const PEOPLE_FILTERS = ['all', 'new', 'onboarding', 'restricted', 'low_integrity', 'staff', 'founding'] as const;
export type PeopleFilter = (typeof PEOPLE_FILTERS)[number];
export const PEOPLE_SORTS = ['newest', 'karma', 'reported'] as const;
export type PeopleSort = (typeof PEOPLE_SORTS)[number];

export type AdminPersonRow = {
  username: string;
  tier: number;
  karma: number;
  integrity: number;
  created_at: string;
  provider: string;
  needs_onboarding: boolean;
  deleted: boolean;
  is_admin: boolean;
  is_moderator: boolean;
  founding: boolean;
  restriction: Exclude<SanctionKind, 'warning'> | null;
  reports_30d: number;
};

export type Page<T> = { rows: T[]; has_more: boolean };

export const RISK_SIGNALS = ['new_account_busy', 'low_integrity', 'often_reported', 'vote_caps'] as const;
export type RiskSignal = (typeof RISK_SIGNALS)[number];

export type AdminMember = {
  id: string;
  username: string;
  locale: 'en' | 'fr';
  home_zone_id: string | null;
  bio: string;
  coi: string;
  karma: number;
  mod_xp: number;
  tier: number;
  integrity: number;
  rater_status: RaterStatus;
  rater_impact: number;
  writer_impact: number;
  founding_until: string | null;
  writing_locked_until: string | null;
  needs_onboarding: boolean;
  created_at: string;
  deleted_at: string | null;
  is_admin: boolean;
  is_self: boolean;
  moderates: string[];
  account: {
    email_masked: string | null;
    email_confirmed: boolean;
    provider: string;
    providers: string[];
    last_sign_in_at: string | null;
    mfa: boolean;
  };
  counts: {
    posts: number;
    posts_removed: number;
    comments: number;
    comments_removed: number;
    notes: number;
    notes_helpful: number;
    ratings: number;
    reports_filed: number;
    reports_actioned: number;
    reports_abusive: number;
    reports_received_30d: number;
  };
  signals: RiskSignal[];
  sanctions: Array<{
    id: string;
    kind: SanctionKind;
    reason: string;
    starts_at: string;
    ends_at: string | null;
    revoked_at: string | null;
    issued_by: string | null;
    revoked_by: string | null;
  }>;
  strikes: Array<{ id: string; reason: string; points: number; created_at: string; expires_at: string; revoked_at: string | null; active: boolean }>;
  ledger: Array<{ track: 'karma' | 'mod_xp'; delta: number; reason: string; created_at: string }>;
  actions: AdminLogEntry[];
  appeals: Array<{ id: string; status: AppealStatus; body: string; created_at: string; decision_note: string | null; decided_by: string | null }>;
  staff_notes: Array<{ id: string; label: StaffNoteLabel; body: string; author: string; created_at: string }>;
  recent: Array<{ kind: 'post' | 'comment'; id: string; post_id: string; text: string; status: ContentStatus; zone_id: string | null; created_at: string }>;
  notes_written: Array<{ id: string; post_id: string; post_title: string; status: NoteStatus; locked_status: NoteStatus | null; hidden: boolean; created_at: string }>;
};

export const CONTENT_KINDS = ['post', 'comment', 'note'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

export type AdminContentRow = {
  kind: ContentKind;
  id: string;
  post_id: string;
  title: string;
  excerpt: string;
  status: ContentStatus | NoteStatus;
  zone_id: string;
  category_id?: string;
  author: string;
  created_at: string;
  pinned?: boolean;
  locked?: boolean;
  hidden?: boolean;
  hidden_reason?: string | null;
  classification?: NoteClassification;
  removal_reason?: string | null;
  open_reports?: number;
};

export type AdminLogEntry = {
  id: string;
  action: ModAction;
  target_kind: string | null;
  target_id: string | null;
  target_user?: string | null;
  zone_id?: string | null;
  reason: string;
  metadata: Record<string, unknown>;
  actor: string | null;
  created_at: string;
  appealed?: boolean;
  post_id?: string | null;
};

export type AdminTeam = {
  admins: Array<{ username: string; since: string; granted_by: string | null; is_self: boolean; mfa: boolean; last_sign_in_at: string | null; actions_30d: number }>;
  moderators: Array<{
    zone_id: string;
    username: string;
    since: string;
    mfa: boolean;
    actions_30d: number;
    last_action_at: string | null;
    median_hours: number | null;
    decisions_appealed: number;
    decisions_overturned: number;
  }>;
  founding: Array<{ username: string; until: string; rater_impact: number }>;
  stewards: Array<{ username: string; karma: number; mod_xp: number }>;
  reports_by_reason_30d: Partial<Record<ReportReason, number>>;
  abusive_reports_30d: number;
  resolved_reports_30d: number;
};

export type AdminNotesHealth = {
  open: Record<NoteStatus, number>;
  locked: Record<NoteStatus, number>;
  hidden: number;
  waiting: Array<{ id: string; post_id: string; post_title: string; created_at: string; ratings: number; min_ratings: number }>;
  recently_locked: Array<{ id: string; post_id: string; post_title: string; locked_status: NoteStatus; locked_at: string; hidden: boolean }>;
  scoring: {
    mode: 'bootstrap' | 'bridging';
    switch_min_raters: number;
    runs: Array<{ at: string; mode: string; scored: number; transitions: number; locked: number; agreement: number | null; established_raters: number | null }>;
  };
  raters: { probation: number; active: number; founding: number };
  writer_locks: Array<{ username: string; until: string }>;
  strikes_30d: number;
  corrections_30d: number;
  young_rater_notes: Array<{ id: string; post_id: string; post_title: string; young_share: number }>;
  lockstep_pairs: Array<{ a: string; b: string; shared: number; agreement: number }>;
};

export type AdminConfigEntry = {
  key: string;
  value: unknown;
  description: string;
  is_public: boolean;
  bounds: { min: number; max: number } | null;
  updated_at: string;
  last_change: { by: string | null; at: string; reason: string } | null;
};

export type AdminConfigChange = { id: string; old: unknown; new: unknown; reason: string; by: string | null; at: string };

export type AdminSystemStatus = {
  jobs: Array<{ job: JobName; last_at: string; ok: boolean; summary: Record<string, unknown>; last_failure_at: string | null; runs_24h: number; failures_24h: number }>;
  last_scoring_run: { at: string; mode: string; scored: number; transitions: number; locked: number } | null;
  security_audit: Array<{ check: string; object: string; detail: string }>;
  staff_without_mfa: string[];
  deletions: { pending: number; oldest: string | null; processed_30d: number };
  signups_by_provider_30d: Record<string, number>;
  busiest_24h: Array<{ username: string; action: string; count: number }>;
};

export type AdminShield = {
  domains: Array<{ domain: string; reason: string; created_by: string | null; created_at: string }>;
  phrases: Array<{ phrase: string; action: ShieldAction; created_by: string | null; created_at: string; holds_30d: number }>;
  held_now: number;
  recent_holds: Array<{ username: string | null; rule: string; rule_kind: 'domain' | 'phrase'; target_kind: 'post' | 'comment'; created_at: string }>;
};

export type ShieldMatch = { rule_kind: 'domain' | 'phrase'; rule: string; action: ShieldAction };

export type TransparencyStats = {
  month: string;
  months: string[];
  removals: Partial<Record<Violation, number>>;
  restored: number;
  sanctions: Partial<Record<SanctionKind, number>>;
  appeals: { filed: number; upheld: number; denied: number };
  reports: { filed: number; actioned: number; dismissed: number };
  collapses: { collapsed: number; reopened: number };
  notes: { written: number; shown: number; locked_helpful: number; locked_not_helpful: number; hidden: number };
  held_by_shield: number;
};

export type SiteAnnouncement = { en: string; fr: string; tone: 'info' | 'warn'; until: string | null };
