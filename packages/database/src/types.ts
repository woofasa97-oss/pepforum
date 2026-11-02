/**
 * Supabase schema types for supabase-js (`createClient<Database>()`).
 *
 * Row shapes are type aliases, not interfaces: supabase-js constrains rows to
 * Record<string, unknown>, which interfaces (no implicit index signature) fail.
 *
 * Hand-maintained to match supabase/migrations. Once a Supabase project is
 * linked, regenerate with `pnpm db:types` and diff against this file (see
 * docs/DEPLOYMENT.md). Only objects the apps actually use are typed; direct
 * writes are intentionally absent because API roles have no write grants —
 * mutations go through the RPCs under `Functions`.
 */
import type {
  ContentStatus,
  Locale,
  NoteClassification,
  NoteStatus,
  PostType,
  RaterStatus,
  RatingValue,
  SourceKind,
} from './domain.ts';

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type ReadOnlyTable<Row> = {
  Row: Row;
  Insert: Record<string, never>;
  Update: Record<string, never>;
  Relationships: [];
};

export type ZoneRow = {
  id: string;
  name_en: string;
  name_fr: string;
  short_name: string;
  description_en: string;
  description_fr: string;
  sort_order: number;
};

export type CityRow = {
  id: string;
  zone_id: string;
  name: string;
  sort_order: number;
};

export type CategoryRow = {
  id: string;
  name_en: string;
  name_fr: string;
  icon: string;
  description_en: string;
  description_fr: string;
  rules_en: string[];
  rules_fr: string[];
  min_note_ratings: number | null;
  sort_order: number;
  archived_at: string | null;
};

/**
 * Full row (service_role). API roles may select only: id, username, locale,
 * home_zone_id, bio, coi, karma, tier, created_at, deleted_at.
 */
export type ProfileRow = {
  id: string;
  username: string;
  locale: Locale;
  home_zone_id: string | null;
  bio: string;
  coi: string;
  karma: number;
  mod_xp: number;
  tier: number;
  rater_status: RaterStatus;
  rater_impact: number;
  writer_impact: number;
  founding_until: string | null;
  writing_locked_until: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type LedgerEventRow = {
  id: number;
  user_id: string;
  track: 'karma' | 'mod_xp';
  delta: number;
  reason: string;
  source_kind: string;
  source_id: string | null;
  event_key: string;
  created_at: string;
};

export type AppConfigRow = {
  key: string;
  value: Json;
  description: string;
  is_public: boolean;
  updated_at: string;
};

export type NoteRow = {
  id: string;
  post_id: string;
  post_revision: number;
  author_id: string;
  classification: NoteClassification;
  language: Locale;
  body: string;
  status: NoteStatus;
  status_since: string;
  first_shown_at: string | null;
  locked_at: string | null;
  locked_status: NoteStatus | null;
  intercept: number | null;
  factor: number | null;
  scoring_mode: 'bootstrap' | 'bridging' | null;
  scored_at: string | null;
  post_corrected_at: string | null;
  created_at: string;
};

export type NoteRatingRow = {
  note_id: string;
  rater_id: string;
  value: RatingValue;
  reasons: string[];
  weight: number;
  cast_while_public: boolean;
  created_at: string;
  updated_at: string;
};

export type ZoneModeratorRow = {
  zone_id: string;
  user_id: string;
  appointed_by: string | null;
  created_at: string;
};

/** Member-visible columns (actor_id is withheld by column grants). */
export type ModActionRow = {
  id: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  target_user_id: string | null;
  zone_id: string | null;
  reason: string;
  metadata: Json;
  created_at: string;
};

export type AppealRow = {
  id: string;
  mod_action_id: string;
  appellant_id: string;
  body: string;
  status: 'open' | 'upheld' | 'denied';
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

export type AccountDeletionRow = {
  user_id: string;
  erase_content: boolean;
  requested_at: string;
  processed_at: string | null;
};

export type FeedRow = {
  id: string;
  title: string;
  excerpt: string;
  post_type: PostType;
  link_url: string | null;
  language: Locale;
  status: ContentStatus;
  zone_id: string;
  city_id: string | null;
  category_id: string;
  author_username: string;
  author_tier: number;
  author_karma: number;
  score: number;
  comment_count: number;
  created_at: string;
  edited_at: string | null;
  my_vote: -1 | 1 | null;
  has_helpful_note: boolean;
  has_open_note: boolean;
};

export type PostDetailRow = {
  id: string;
  title: string;
  body: string;
  post_type: PostType;
  link_url: string | null;
  language: Locale;
  status: ContentStatus;
  removal_reason: string | null;
  zone_id: string;
  city_id: string | null;
  category_id: string;
  author_username: string;
  author_tier: number;
  author_karma: number;
  is_mine: boolean;
  score: number;
  comment_count: number;
  revision: number;
  created_at: string;
  edited_at: string | null;
  my_vote: -1 | 1 | null;
  can_moderate: boolean;
};

export type CommentRow = {
  id: string;
  parent_id: string | null;
  depth: number;
  author_username: string;
  author_tier: number;
  is_op: boolean;
  is_mine: boolean;
  body: string;
  status: ContentStatus;
  score: number;
  created_at: string;
  edited_at: string | null;
  my_vote: -1 | 1 | null;
};

export type NoteView = {
  id: string;
  post_id: string;
  post_revision: number;
  classification: NoteClassification;
  language: Locale;
  body: string;
  status: NoteStatus;
  locked: boolean;
  locked_at: string | null;
  first_shown_at: string | null;
  post_corrected: boolean;
  created_at: string;
  author_alias: string;
  is_mine: boolean;
  rating_count: number;
  min_ratings: number;
  breakdown: { helpful: number; somewhat: number; not_helpful: number } | null;
  my_rating: { value: RatingValue; reasons: string[] } | null;
  sources: Array<{ url: string; kind: SourceKind }>;
  post_title?: string;
};

export type NoteDetailView = NoteView & {
  post: { id: string; title: string; body: string; post_type: PostType; category_id: string; zone_id: string; is_mine: boolean };
  history: Array<{ event: string; from: NoteStatus | null; to: NoteStatus | null; at: string }>;
  can_rate: boolean;
};

export type StandingView = {
  user_id: string;
  username: string;
  karma: number;
  mod_xp: number;
  tier: number;
  integrity: number;
  rater_status: RaterStatus;
  rater_impact: number;
  writer_impact: number;
  writing_locked_until: string | null;
  is_moderator: boolean;
  is_admin: boolean;
  /** null = allowed, otherwise a reason key such as "tier:2". */
  capabilities: Record<string, string | null>;
  tier_thresholds: number[];
  active_strikes: Array<{ reason: string; points: number; expires_at: string }>;
  active_sanctions: Array<{ kind: string; reason: string; ends_at: string | null }>;
};

export type ProfileView = {
  username: string;
  bio: string;
  coi: string;
  home_zone_id: string | null;
  karma: number;
  tier: number;
  /** Moderation-track fields: null unless the viewer is the profile owner. */
  mod_xp: number | null;
  rater_status: RaterStatus | null;
  rater_impact: number | null;
  writer_impact: number | null;
  joined_at: string;
  deleted: boolean;
  is_me: boolean;
  moderates: string[];
  post_count: number;
  comment_count: number;
};

export type ModQueueItem = {
  target_kind: 'post' | 'comment';
  target_id: string;
  post_id: string;
  excerpt: string;
  body: string;
  status: ContentStatus;
  author_username: string;
  author_tier: number;
  author_integrity: number;
  author_prior_actions: number;
  total_weight: number;
  report_count: number;
  first_reported_at: string;
  reports: Array<{ id: string; reason: string; details: string; weight: number; reporter: string; created_at: string }>;
};

export type AppealView = {
  id: string;
  body: string;
  created_at: string;
  appellant: string;
  action: string;
  target_kind: string;
  target_id: string;
  reason: string;
  acted_by: string | null;
  acted_at: string;
  can_decide: boolean;
};

export type Database = {
  public: {
    Tables: {
      zones: ReadOnlyTable<ZoneRow>;
      cities: ReadOnlyTable<CityRow>;
      categories: ReadOnlyTable<CategoryRow>;
      app_config: ReadOnlyTable<AppConfigRow>;
      ledger_events: ReadOnlyTable<LedgerEventRow>;
      notes: ReadOnlyTable<NoteRow>;
      note_ratings: ReadOnlyTable<NoteRatingRow>;
      zone_moderators: ReadOnlyTable<ZoneModeratorRow>;
      mod_actions: ReadOnlyTable<ModActionRow>;
      appeals: ReadOnlyTable<AppealRow>;
      profiles: {
        Row: ProfileRow;
        Insert: Record<string, never>;
        /** Mirrors the column-level grant: members may update only these. */
        Update: Partial<Pick<ProfileRow, 'bio' | 'locale' | 'home_zone_id' | 'coi'>>;
        Relationships: [];
      };
      account_deletions: {
        Row: AccountDeletionRow;
        Insert: Record<string, never>;
        /** service_role only. */
        Update: Partial<Pick<AccountDeletionRow, 'processed_at'>>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      username_available: { Args: { p_username: string }; Returns: boolean };
      my_standing: { Args: Record<string, never>; Returns: StandingView };
      create_post: {
        Args: {
          p_zone_id: string;
          p_category_id: string;
          p_post_type: PostType;
          p_title: string;
          p_body: string;
          p_link_url?: string | null;
          p_city_id?: string | null;
          p_language?: Locale;
        };
        Returns: string;
      };
      edit_post: { Args: { p_post_id: string; p_title: string; p_body: string; p_link_url?: string | null }; Returns: number };
      delete_own_post: { Args: { p_post_id: string }; Returns: undefined };
      create_comment: { Args: { p_post_id: string; p_body: string; p_parent_id?: string | null }; Returns: string };
      delete_own_comment: { Args: { p_comment_id: string }; Returns: undefined };
      cast_vote: {
        Args: { p_target_kind: 'post' | 'comment'; p_target_id: string; p_value: -1 | 0 | 1 };
        Returns: { score: number; my_vote: -1 | 0 | 1 };
      };
      propose_note: {
        Args: {
          p_post_id: string;
          p_classification: NoteClassification;
          p_body: string;
          p_sources: Array<{ url: string; kind: SourceKind }>;
          p_language?: Locale;
        };
        Returns: string;
      };
      next_note_to_rate: { Args: Record<string, never>; Returns: string | null };
      rate_note: { Args: { p_note_id: string; p_value: RatingValue; p_reasons: string[] }; Returns: undefined };
      /** service_role only. Validated by the worker (apps/worker/src/config.ts). */
      scoring_input: { Args: { p_window_days?: number }; Returns: Json };
      apply_note_scores: {
        Args: { p_run_id: string; p_snapshot: string; p_mode: 'bootstrap' | 'bridging'; p_results: Json; p_shadow?: Json | null };
        Returns: { run_id: string; scored?: number; transitions?: number; locked?: number; skipped_stale?: number; already_applied?: boolean };
      };
      file_report: {
        Args: { p_target_kind: 'post' | 'comment'; p_target_id: string; p_reason: string; p_details?: string };
        Returns: { collapsed: boolean };
      };
      resolve_reports: {
        Args: {
          p_target_kind: 'post' | 'comment';
          p_target_id: string;
          p_decision: 'remove' | 'keep';
          p_violation?: string | null;
          p_reason?: string;
          p_abusive_report_ids?: string[];
        };
        Returns: string;
      };
      moderate_remove: { Args: { p_target_kind: 'post' | 'comment'; p_target_id: string; p_violation: string; p_reason: string }; Returns: string };
      apply_sanction: { Args: { p_user: string; p_kind: string; p_reason: string; p_days?: number | null }; Returns: string };
      revoke_sanction: { Args: { p_sanction_id: string; p_reason: string }; Returns: undefined };
      submit_appeal: { Args: { p_mod_action_id: string; p_body: string }; Returns: string };
      decide_appeal: { Args: { p_appeal_id: string; p_uphold: boolean; p_note: string }; Returns: undefined };
      grant_founding_rater: { Args: { p_user: string; p_until: string; p_reason: string }; Returns: undefined };
      set_zone_moderator: { Args: { p_user: string; p_zone: string; p_appoint: boolean; p_reason: string }; Returns: undefined };
      admin_set_config: { Args: { p_key: string; p_value: Json; p_reason: string }; Returns: undefined };
      expire_stale_collapses: { Args: Record<string, never>; Returns: number };
      run_maintenance: { Args: Record<string, never>; Returns: { uncollapsed: number; rate_limit_purged: number; assignments_purged: number } };
      request_account_deletion: { Args: { p_erase_content?: boolean }; Returns: undefined };
      export_my_data: { Args: Record<string, never>; Returns: Json };
      get_feed: {
        Args: {
          p_zone?: string | null;
          p_category?: string | null;
          p_city?: string | null;
          p_author_username?: string | null;
          p_sort?: 'hot' | 'new' | 'top';
          p_limit?: number;
          p_offset?: number;
        };
        Returns: FeedRow[];
      };
      get_post: { Args: { p_post_id: string }; Returns: PostDetailRow[] };
      get_comments: { Args: { p_post_id: string }; Returns: CommentRow[] };
      get_post_notes: { Args: { p_post_id: string }; Returns: NoteView[] };
      get_note: { Args: { p_note_id: string }; Returns: NoteDetailView | null };
      list_notes: {
        Args: { p_tab?: 'needs_ratings' | 'helpful' | 'not_helpful' | 'mine'; p_category?: string | null; p_limit?: number; p_offset?: number };
        Returns: NoteView[];
      };
      get_profile: { Args: { p_username: string }; Returns: ProfileView | null };
      mod_queue: { Args: { p_zone: string }; Returns: ModQueueItem[] };
      open_appeals: { Args: { p_zone: string }; Returns: AppealView[] };
    };
  };
};
