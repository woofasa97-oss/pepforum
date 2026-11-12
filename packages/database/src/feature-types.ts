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
  CoaMethod,
  CoaScope,
  CoaStatus,
  ImageContentType,
  Locale,
  MediaKind,
  MediaStatus,
  NotificationKind,
  PriceAvailability,
  PriceCompoundType,
  PriceCurrency,
  PriceOrigin,
  PriceVendorStatus,
  LabTier,
  StoreAuditCriterion,
  StoreAuditResult,
  StoreKind,
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
    country: string;
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
  country: string;
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
  billing_country: string;
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
  id: string; name: string; website: string; billing_email: string; billing_country: string; status: AdvertiserStatus; review_note: string;
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

// ── Price tracking (…030–…033) ──────────────────────────────────────────────
export type PriceRate = { base: PriceCurrency; quote: PriceCurrency; rate: number; provider: string; rate_date: string };
export type PriceCompound = {
  slug: string;
  name: string;
  type: PriceCompoundType;
  aliases: string[];
  formulation: string;
  blend_components: Array<{ name: string; mg?: number | null }> | null;
};
/** A certificate of analysis as the vendor published it. The document's address is never sent; link through price_link('coa', id). */
export type PriceCoa = {
  id: string;
  compound: string | null;
  scope: CoaScope;
  batch: string | null;
  lab: string;
  lab_accreditation: string | null;
  method: CoaMethod | null;
  test_date: string | null;
  stated_purity_pct: number;
  checked: string;
};
export type PriceQuantityTier = { vials: number; percent: number; blends: boolean; any_product: boolean; checked: string };
export type PriceVendor = {
  slug: string;
  name: string;
  domain: string;
  origin_country: PriceOrigin;
  ships_to: string[];
  native_currency: string | null;
  coa_scope: CoaScope | 'none' | 'unknown';
  last_ingested_at: string | null;
  coas: PriceCoa[];
  quantity_tiers: PriceQuantityTier[];
};
export type PriceOffer = {
  id: string;
  vendor: string;
  compound: string;
  product_name: string;
  variant_label: string | null;
  currency: PriceCurrency;
  /** Integer minor units (cents) in `currency`. */
  price_minor: number;
  list_price_minor: number | null;
  on_sale: boolean;
  price_kind: 'per_pack' | 'fixed_kit';
  mg_per_vial: number | null;
  vials_per_pack: number;
  total_mg: number | null;
  /** Minor units per mg × 10^4; null for blends. */
  per_mg_minor_e4: number | null;
  availability: PriceAvailability;
  observed_at: string;
  price_changed_at: string;
  recipe_key: string | null;
  is_blend: boolean;
};
/** get_price_catalog(): everything the Prices section shows. Null while features.prices is off. */
export type PriceCatalog = {
  stale_hours: number;
  lead_vials: number;
  publication: { published_at: string; run_finished_at: string | null } | null;
  rates: PriceRate[];
  compounds: PriceCompound[];
  vendors: PriceVendor[];
  offers: PriceOffer[];
};
export type PriceHistoryPoint = { day: string; vendor: string; currency: PriceCurrency; per_mg_minor_e4: number };

// ── Stores directory (…035, ADR-0011) ──────────────────────────────────────
type StoreBase = {
  slug: string;
  name: string;
  domain: string;
  kind: StoreKind;
  /** ISO 3166-1 alpha-2, or null when the store's own site doesn't say. */
  country: string | null;
  ships_to: string[];
  ships_worldwide: boolean;
  currency: string | null;
  /** Its prices are on the Prices pages (the section is on and the store is active with published offers). */
  has_prices: boolean;
};
export type StoreListItem = StoreBase & {
  /** Listings in its latest catalogue read (…037). */
  listings: number;
  /** Compound slugs in its latest catalogue read. */
  compounds: string[];
  /** Certificate documents it links. */
  documents: number;
  audit: {
    audited_on: string;
    standard_version: string;
    reachable: boolean;
    results: Partial<Record<StoreAuditCriterion, StoreAuditResult>>;
  } | null;
};
export type LabListItem = {
  slug: string;
  name: string;
  country: string | null;
  tier: LabTier;
  accreditation_body: string | null;
  accreditation_number: string | null;
  verify_how: string | null;
  has_website: boolean;
  has_evidence: boolean;
  evidence_quote: string | null;
  checked_on: string;
};
/** get_store_directory(): null unless features.stores is on or the caller is an admin (then `preview`). */
export type StoreDirectory = { preview: boolean; stores: StoreListItem[]; labs: LabListItem[]; compounds: Array<{ slug: string; name: string }> };
export type StoreAuditCheck = {
  id: string;
  criterion: StoreAuditCriterion;
  result: StoreAuditResult;
  value: string | null;
  quote: string | null;
  has_source: boolean;
  quote_verified_on: string | null;
};
/** get_store(slug): one listed store and its latest audit. */
export type StoreListing = {
  id: string;
  compound: string;
  compound_name: string;
  product_name: string;
  variant_label: string | null;
  form: string;
  mg_per_vial: number | null;
  vials_per_pack: number | null;
  total_mg: number | null;
  is_blend: boolean;
  currency: string;
  /** Integer minor units of `currency`. */
  price_minor: number;
  list_price_minor: number | null;
  on_sale: boolean;
  /** Minor units per mg × 10^4. */
  per_mg_minor_e4: number | null;
  availability: PriceAvailability;
  has_url: boolean;
};
export type StoreDocument = { id: string; label: string; compound: string | null; compound_name: string | null; found_on: string };
/** get_store(slug): one listed store, its latest audit, catalogue read and certificate documents. */
export type StoreDetail = StoreBase & {
  preview: boolean;
  audits: number;
  audit: { audited_on: string; standard_version: string; method: 'public_pages'; reachable: boolean; checks: StoreAuditCheck[] } | null;
  catalogue: { observed_on: string; source: string; complete: boolean; products_seen: number; listings: StoreListing[] } | null;
  documents: StoreDocument[];
};

export type AdminPriceVendor = {
  slug: string;
  name: string;
  website_url: string;
  origin_country: PriceOrigin;
  origin_source: string | null;
  platform: string | null;
  status: PriceVendorStatus;
  status_note: string | null;
  unreadable: boolean;
  coa_scope: string;
  last_ingested_at: string | null;
  offers: number;
  coas: number;
  coa_candidates: number;
  last_outcome: string | null;
  last_http_status: number | null;
};
export type AdminPriceRun = {
  run_label: string;
  mode: string;
  dry_run: boolean;
  status: string;
  verdict: string | null;
  started_at: string;
  finished_at: string | null;
  vendors_read: number;
  vendors_tried: number;
};
export type AdminPriceOverview = {
  enabled: boolean;
  publication: { published_at: string; offers: number; vendors: number; compounds: number; waiting: number; run_label: string } | null;
  runs: AdminPriceRun[];
  vendors: AdminPriceVendor[];
  compounds: Array<{ slug: string; name: string }>;
};
export type AdminPriceCoa = {
  id: string;
  vendor: string;
  vendor_name: string;
  compound: string | null;
  compound_name: string | null;
  url: string;
  scope: CoaScope;
  batch: string | null;
  lab: string | null;
  lab_accreditation: string | null;
  method: CoaMethod | null;
  test_date: string | null;
  stated_purity_pct: number | null;
  evidence_quote: string | null;
  status: CoaStatus;
  checked_at: string | null;
  checked_by: string | null;
  created_at: string;
};
/** Clicks per store (plain links only; ADR-0009). */
export type AdminPriceLinks = {
  clicks: Array<{ vendor: string; vendor_name: string; clicks_7d: number; clicks_30d: number }>;
};
