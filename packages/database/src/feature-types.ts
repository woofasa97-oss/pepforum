/**
 * Shapes returned by the RPCs added in migrations …021–…025 (SEO,
 * notifications, media, clinician verification, advertising). Hand-maintained
 * like types.ts; see docs/DEPLOYMENT.md for regenerating.
 */
import type {
  AdCampaignStatus,
  AdPackage,
  AdReportReason,
  AdvertiserStatus,
  ClinicianProfession,
  ClinicianStatus,
  ImageContentType,
  Locale,
  MediaKind,
  MediaStatus,
  NotificationKind,
  Province,
} from './domain.ts';

// ── SEO (…021) ──────────────────────────────────────────────────────────────
export type RedirectTarget = { to: string; permanent: boolean };
export type AdminRedirect = { from: string; to: string; permanent: boolean; reason: string; by: string | null; created_at: string; updated_at: string };
export type SitemapCounts = { posts: number; notes: number; profiles: number; page_size: number };
export type SitemapEntry = { path: string; updated_at: string };

// ── Notifications (…022) ────────────────────────────────────────────────────
export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  created_at: string;
  read: boolean;
  /** Only for replies, where the author is public anyway. */
  actor: string | null;
  post: { id: string; title: string } | null;
  comment_excerpt: string | null;
  note_status: string | null;
  /** mod_action: the moderation action; clinician_review / ad_review: the decision. */
  action: string | null;
  reason: string | null;
  ticket: { id: string; subject: string } | null;
};

export type NotificationSettings = {
  replies: boolean;
  notes: boolean;
  moderation: boolean;
  team: boolean;
  push: boolean;
  /** Browsers registered for push. */
  subscriptions: number;
};

/** One unpushed notification with the browsers to send it to (worker only). */
export type PendingPush = {
  id: string;
  kind: NotificationKind;
  locale: Locale;
  post_title: string | null;
  url: string;
  subscriptions: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
};

export type PushResult = { notification_id: string; subscription_id: string | null; ok: boolean; gone: boolean };

// ── Media (…023) ────────────────────────────────────────────────────────────
export type RegisteredUpload = { id: string; bucket: string; path: string };
export type PostImage = { id: string; alt: string; width: number | null; height: number | null; content_type: ImageContentType };
export type PendingImage = { id: string; alt: string; width: number | null; height: number | null; created_at: string };
export type MediaAccess = { bucket: string; path: string; content_type: string; kind: MediaKind; public: boolean };
export type AdminMediaRow = {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string;
  created_at: string;
  owner: string;
  owner_tier: number;
  post: { id: string; title: string; status: string } | null;
  removed_reason: string | null;
  purged: boolean;
};
export type AdminMedia = {
  rows: AdminMediaRow[];
  has_more: boolean;
  counts: { ready: number; pending: number; removed_30d: number; bytes: number };
};
export type MediaToPurge = { id: string; bucket: string; path: string };

// ── Clinician verification (…024) ───────────────────────────────────────────
export type MyClinicianVerification = {
  badge: ClinicianProfession | null;
  latest: {
    id: string;
    profession: ClinicianProfession;
    regulator: string;
    province_id: string;
    status: ClinicianStatus | 'expired';
    submitted_at: string;
    reviewed_at: string | null;
    review_note: string;
    expires_at: string | null;
    document_id: string | null;
  } | null;
  valid_days: number;
};

export type AdminClinicianRow = {
  id: string;
  member: string;
  member_tier: number;
  user_id: string;
  joined: string;
  profession: ClinicianProfession;
  regulator: string;
  province_id: string;
  registration_number: string;
  document_id: string | null;
  statement: string;
  status: ClinicianStatus | 'expired';
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string;
  expires_at: string | null;
  previous: number;
};
export const CLINICIAN_FILTERS = ['pending', 'approved', 'expiring', 'rejected', 'revoked'] as const;
export type ClinicianFilter = (typeof CLINICIAN_FILTERS)[number];
export type AdminClinicians = { rows: AdminClinicianRow[]; counts: Record<ClinicianFilter, number> };

// ── Advertising (…025) ──────────────────────────────────────────────────────
export type AdRateCard = {
  enabled: boolean;
  cpm: Record<AdPackage, number>;
  min_booking: number;
  flight_days: number;
};

export type AdDay = { day: string; impressions: number; clicks: number; charged: number; settled: boolean };

export type MyCampaign = {
  id: string;
  name: string;
  package: AdPackage;
  zone_id: string | null;
  category_id: string | null;
  budget: number;
  cpm: number;
  reserved: number;
  spent: number;
  status: AdCampaignStatus;
  headline: string;
  body: string;
  cta: string;
  headline_fr: string;
  body_fr: string;
  cta_fr: string;
  landing_url: string;
  image_id: string | null;
  starts_on: string | null;
  ends_on: string | null;
  review_note: string;
  reviewed_at: string | null;
  submitted_at: string | null;
  impressions: number;
  clicks: number;
  created_at: string;
  updated_at: string;
  days: AdDay[];
};

export type AdLedgerEntry = { id: number; kind: 'payment' | 'charge' | 'refund' | 'adjustment'; amount: number; campaign_id: string | null; reference: string; note: string; created_at: string };

export type MyAdvertiser = {
  id: string;
  name: string;
  website: string;
  billing_email: string;
  billing_address: string;
  billing_province: Province;
  status: AdvertiserStatus;
  review_note: string;
  created_at: string;
  balance: number;
  reserved: number;
  available: number;
  campaigns: MyCampaign[];
  ledger: AdLedgerEntry[];
};

/** What the slot renders. The click goes through /ads/go/<id>. */
export type ServedAd = { id: string; advertiser: string; headline: string; body: string; cta: string; image_id: string | null };

export type AdminAdvertiserRow = {
  id: string; name: string; website: string; billing_email: string; billing_province: Province; status: AdvertiserStatus; review_note: string;
  owner: string; owner_tier: number; created_at: string; balance: number; reserved: number; campaigns: number; in_review: number;
};
export type AdminCampaignRow = Omit<MyCampaign, 'days' | 'created_at' | 'updated_at' | 'reviewed_at'> & {
  advertiser_id: string; advertiser: string; owner: string; reviewed_by: string | null; open_reports: number;
};
export type AdminAdReport = { id: string; campaign_id: string; campaign: string; advertiser: string; reason: AdReportReason; details: string; reporter: string; created_at: string };
export type AdminAds = {
  rate_card: AdRateCard;
  advertisers: AdminAdvertiserRow[];
  campaigns: AdminCampaignRow[];
  reports: AdminAdReport[];
  ledger: Array<{ id: number; advertiser: string; kind: AdLedgerEntry['kind']; amount: number; reference: string; note: string; by: string | null; created_at: string }>;
  totals: { balance: number; reserved: number; charged_30d: number; pending_advertisers: number; campaigns_in_review: number; open_reports: number };
};

export type SettleAdsResult = { days_settled: number; charged_microcad: number; completed: number; deliveries_purged: number };

/** microCAD → "1,234.56" in the member's locale. */
export function formatCad(microcad: number, locale: string = 'en-CA'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'CAD' }).format(microcad / 1_000_000);
}
