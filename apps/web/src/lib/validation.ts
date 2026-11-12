/**
 * Input validation for every form. These mirror the SQL constraints and RPC
 * checks — the database remains the final authority; validating here gives
 * members precise field errors and keeps junk off the wire.
 */
import {
  AD_PACKAGES,
  AD_REPORT_REASONS,
  CLINICIAN_PROFESSIONS,
  COA_METHODS,
  COA_SCOPES,
  COA_STATUSES,
  LINK_DECISIONS,
  LOCALES,
  MEMBER_REPORT_OUTCOMES,
  MEMBER_REPORT_REASONS,
  NOTE_CLASSIFICATIONS,
  POST_TYPES,
  PRICE_ORIGINS,
  PRICE_VENDOR_STATUSES,
  PROVINCES,
  RATING_REASONS,
  RATING_VALUES,
  REPORT_REASONS,
  SANCTION_KINDS,
  SHIELD_ACTIONS,
  SITE_DECISIONS,
  SOCIAL_PLATFORMS,
  SOURCE_KINDS,
  STAFF_NOTE_LABELS,
  TICKET_KINDS,
  VIOLATIONS,
} from '@pepforum/database';
import { z } from 'zod';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const slug = z.string().regex(/^[a-z0-9-]{2,40}$/);
const id = z.uuid();
const checkbox = z.literal('on');

export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;
export const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/\S*)?$/;
/** Note sources must point at a specific page, not a homepage. */
export const HTTPS_URL_WITH_PATH = /^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/\S+$/;

export const SignUpSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  username: z.string().regex(USERNAME_PATTERN),
  locale: z.enum(LOCALES),
  homeZone: z.union([z.literal(''), z.string().regex(/^[a-z]{2,16}$/)]).optional(),
  ageAck: checkbox,
  terms: checkbox,
});

/** Social sign-ups: the parts of SignUpSchema the identity provider can't supply. */
export const OnboardingSchema = z.object({
  username: z.string().regex(USERNAME_PATTERN),
  homeZone: z.union([z.literal(''), z.string().regex(/^[a-z]{2,16}$/)]).optional(),
  ageAck: checkbox,
  terms: checkbox,
  next: z.string().max(512).optional(),
});

export const SignInSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  next: z.string().max(512).optional(),
});

export const EmailOnlySchema = z.object({ email: z.email().max(254) });
export const NewPasswordSchema = z.object({ password: z.string().min(12).max(128) });
export const MfaCodeSchema = z.object({ factorId: id, code: z.string().regex(/^\d{6}$/), next: z.string().max(512).optional() });

const postFields = {
  title: trimmed(8, 140),
  body: z.string().trim().max(10_000),
  link: z.union([z.literal(''), z.string().trim().max(2048).regex(HTTPS_URL)]).optional(),
};

export const CreatePostSchema = z
  .object({
    zone: z.string().regex(/^[a-z]{2,16}$/),
    city: z.union([z.literal(''), slug]).optional(),
    category: slug,
    type: z.enum(POST_TYPES),
    language: z.enum(LOCALES),
    ack: checkbox,
    ...postFields,
  })
  .refine((v) => v.type !== 'resource' || Boolean(v.link), { path: ['link'], message: 'link_required' })
  .refine((v) => v.type === 'resource' || v.body.length > 0, { path: ['body'], message: 'body_required' });

/** Images attached from the composer (…023): repeated hidden inputs, aligned with their alt texts. */
const idList = z.union([id, z.array(id)]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));
const altList = z.union([z.string().max(300), z.array(z.string().max(300))]).optional().transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]));
const mediaFields = { mediaIds: idList, mediaAlts: altList };

export const EditPostSchema = z.object({ postId: id, ...postFields, ...mediaFields });
export const CreatePostWithMediaSchema = CreatePostSchema.and(z.object(mediaFields));
export const MediaIdSchema = z.object({ mediaId: id });

export const CommentSchema = z.object({
  postId: id,
  parentId: z.union([z.literal(''), id]).optional(),
  body: trimmed(1, 5000),
});

export const VoteSchema = z.object({
  kind: z.enum(['post', 'comment']),
  targetId: id,
  value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
});

export const ProposeNoteSchema = z.object({
  postId: id,
  classification: z.enum(NOTE_CLASSIFICATIONS),
  body: trimmed(20, 500),
  language: z.enum(LOCALES),
  sources: z
    .array(z.object({ url: z.string().trim().max(2048).regex(HTTPS_URL_WITH_PATH), kind: z.enum(SOURCE_KINDS) }))
    .min(1)
    .max(5),
});

export const RateNoteSchema = z
  .object({
    noteId: id,
    value: z.enum(RATING_VALUES),
    reasons: z.array(z.string()).min(1).max(6),
  })
  .refine((v) => v.reasons.every((r) => (RATING_REASONS[v.value] as readonly string[]).includes(r)), {
    path: ['reasons'],
    message: 'invalid_reason',
  })
  .refine((v) => new Set(v.reasons).size === v.reasons.length, { path: ['reasons'], message: 'duplicate_reason' });

export const ReportSchema = z.object({
  kind: z.enum(['post', 'comment']),
  targetId: id,
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(500).optional(),
});

export const ReportMemberSchema = z.object({
  username: z.string().regex(USERNAME_PATTERN),
  reason: z.enum(MEMBER_REPORT_REASONS),
  details: z.string().trim().max(1000).optional(),
});

/** Contact the team (…020). The about-fields are optional: the RPC requires a username only for report_member. */
export const OpenTicketSchema = z.object({
  kind: z.enum(TICKET_KINDS),
  subject: trimmed(3, 120),
  body: trimmed(10, 4000),
  aboutUsername: z.union([z.literal(''), z.string().trim().regex(USERNAME_PATTERN)]).optional(),
  aboutUrl: z.union([z.literal(''), z.string().trim().max(500).regex(/^https:\/\/\S+$/)]).optional(),
}).refine((v) => v.kind !== 'report_member' || Boolean(v.aboutUsername), { path: ['aboutUsername'] });

/** Follow or unfollow (…027). */
export const FollowSchema = z.object({ username: z.string().regex(USERNAME_PATTERN), follow: z.enum(['true', 'false']) });

export const TicketReplySchema = z.object({ ticketId: z.uuid(), body: trimmed(1, 4000), close: z.literal('on').optional() });
export const TicketIdSchema = z.object({ ticketId: z.uuid() });

export const ProfileSchema = z.object({
  bio: z.string().trim().max(500),
  coi: z.string().trim().max(300),
  locale: z.enum(LOCALES),
  homeZone: z.union([z.literal(''), z.string().regex(/^[a-z]{2,16}$/)]),
});

export const ResolveReportsSchema = z
  .object({
    kind: z.enum(['post', 'comment']),
    targetId: id,
    decision: z.enum(['remove', 'keep']),
    violation: z.union([z.literal(''), z.enum(VIOLATIONS)]).optional(),
    reason: z.string().trim().max(500),
    abusive: z.array(id).max(50),
  })
  .refine((v) => v.decision !== 'remove' || Boolean(v.violation), { path: ['violation'], message: 'violation_required' });

export const DecideAppealSchema = z.object({ appealId: id, uphold: z.enum(['true', 'false']), note: trimmed(3, 500) });

/** `password` for accounts that have one; social-only accounts confirm with a checkbox after a recent sign-in. */
export const DeleteAccountSchema = z.object({
  password: z.string().min(1).max(128).optional(),
  confirm: checkbox.optional(),
  erase: z.literal('on').optional(),
});

// ── Admin console (every action carries a logged reason) ────────────────────
const reason = trimmed(3, 500);
const username = z.string().regex(USERNAME_PATTERN);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const onOff = z.enum(['true', 'false']);

export const RevealEmailSchema = z.object({ userId: id, reason });
export const FindByEmailSchema = z.object({ email: z.email().max(254) });
export const SanctionSchema = z
  .object({ userId: id, kind: z.enum(SANCTION_KINDS), days: z.coerce.number().int().min(1).max(365).optional(), reason })
  .refine((v) => !(v.kind === 'freeze' || v.kind === 'suspension') || v.days !== undefined, { path: ['days'] });
export const RevokeSanctionSchema = z.object({ sanctionId: id, reason });
export const StaffNoteSchema = z.object({ userId: id, label: z.enum(STAFF_NOTE_LABELS), body: trimmed(3, 1000) });
export const SetRoleSchema = z.object({ username, admin: onOff, reason });
export const SetModeratorSchema = z.object({ username, zone: z.string().regex(/^[a-z]{2,16}$/), appoint: onOff, reason });
export const FoundingSchema = z.object({ username, until: isoDate.optional(), end: z.literal('true').optional(), reason });
export const MemberReasonSchema = z.object({ userId: id, reason });
export const RenameMemberSchema = z.object({ userId: id, username, reason });
export const RevokeStrikeSchema = z.object({ strikeId: id, reason });
export const ContentReasonSchema = z.object({ kind: z.enum(['post', 'comment']), id, reason });
export const AdminRemoveSchema = z.object({ kind: z.enum(['post', 'comment']), id, violation: z.enum(VIOLATIONS), reason });
export const ToggleSchema = z.object({ id, on: onOff, reason });
export const ShieldAddSchema = z.object({ kind: z.enum(['domain', 'phrase']), value: trimmed(2, 253), action: z.enum(SHIELD_ACTIONS).optional(), reason });
export const ShieldRemoveSchema = z.object({ kind: z.enum(['domain', 'phrase']), value: trimmed(2, 253), reason });
export const ShieldTestSchema = z.object({ text: trimmed(1, 10000) });
export const LinkDecisionSchema = z.object({
  kind: z.enum(['post', 'comment']), id, decision: z.enum(LINK_DECISIONS), reason: reason.optional(),
});
export const AdminUnlinkSocialSchema = z.object({ username, platform: z.enum(SOCIAL_PLATFORMS), reason });
export const TicketClosedSchema = z.object({ ticketId: id, closed: onOff });
export const ResolveMemberReportsSchema = z.object({ username, outcome: z.enum(MEMBER_REPORT_OUTCOMES), reason });
export const LinkSiteSchema = z.object({ host: trimmed(3, 253), decision: z.enum(SITE_DECISIONS), reason: reason.optional() });
/** `raw` (JSON) is used by Revert; otherwise the value is built from typed inputs. */
// ── Ported features (…021–…025) ──────────────────────────────────────────────
export const RedirectSchema = z.object({
  from: z.string().trim().min(1).max(500).regex(/^\/[A-Za-z0-9._~/-]*$/), to: z.string().trim().min(1).max(1000).regex(/^(\/\S*|https:\/\/\S+)$/),
  permanent: onOff, reason,
});
export const DeleteRedirectSchema = z.object({ from: z.string().trim().min(1).max(500), reason });

const onOffOptional = z.literal('on').optional();
export const NotificationSettingsSchema = z.object({ replies: onOffOptional, notes: onOffOptional, moderation: onOffOptional, team: onOffOptional, push: onOffOptional });
export const PushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048).regex(/^https:\/\/\S+$/), p256dh: z.string().min(16).max(512), auth: z.string().min(8).max(256),
});
export const PushEndpointSchema = z.object({ endpoint: z.string().max(2048).regex(/^https:\/\/\S+$/) });
export const MarkReadSchema = z.object({ id: id.optional() });

export const ClinicianSubmitSchema = z.object({
  profession: z.enum(CLINICIAN_PROFESSIONS), regulator: trimmed(2, 120), province: z.string().regex(/^[a-z]{2,16}$/),
  registrationNumber: trimmed(2, 60), documentId: id, statement: z.string().trim().max(1000).optional(),
});
export const ClinicianDecisionSchema = z.object({ id, decision: z.enum(['approve', 'reject']), reason });

export const AdvertiserSchema = z.object({
  name: trimmed(2, 80), website: z.string().trim().max(500).regex(HTTPS_URL), billingEmail: z.email().max(254),
  billingAddress: z.string().trim().max(300), billingProvince: z.enum(PROVINCES),
});
export const CampaignSchema = z.object({
  id: z.union([z.literal(''), id]).optional(),
  name: trimmed(2, 80), package: z.enum(AD_PACKAGES),
  zone: z.union([z.literal(''), z.string().regex(/^[a-z]{2,16}$/)]).optional(),
  category: z.union([z.literal(''), slug]).optional(),
  /** Whole CAD; converted to microCAD by the action. */
  budgetCad: z.coerce.number().int().min(1).max(1_000_000),
  headline: trimmed(3, 60), body: trimmed(10, 160), cta: trimmed(2, 24),
  headlineFr: z.string().trim().max(60), bodyFr: z.string().trim().max(160), ctaFr: z.string().trim().max(24),
  landingUrl: z.string().trim().max(1000).regex(HTTPS_URL),
  imageId: z.union([z.literal(''), id]).optional(),
});
export const CampaignIdSchema = z.object({ id });
export const CampaignPauseSchema = z.object({ id, paused: onOff });
export const ReportAdSchema = z.object({ id, reason: z.enum(AD_REPORT_REASONS), details: z.string().trim().max(500).optional() });
export const AdvertiserDecisionSchema = z.object({ id, decision: z.enum(['approve', 'suspend']), reason });
export const CampaignDecisionSchema = z.object({ id, decision: z.enum(['approve', 'reject']), reason });
export const AdPaymentSchema = z.object({ advertiserId: id, amountCad: z.coerce.number().positive().max(1_000_000), reference: trimmed(3, 120), reason });
export const AdAdjustmentSchema = z.object({ advertiserId: id, amountCad: z.coerce.number().max(1_000_000).min(-1_000_000).refine((n) => n !== 0, 'nonzero'), reference: trimmed(3, 120), reason });
export const IdReasonSchema = z.object({ id, reason });

// Price tracking (…031, …032)
const priceSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60);
const httpsUrl = (max: number) => z.string().trim().max(max).regex(/^https:\/\/\S+$/);
const blankToNull = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullable());
export const PriceVendorSchema = z.object({
  slug: priceSlug, name: trimmed(1, 120), websiteUrl: httpsUrl(300), originCountry: z.enum(PRICE_ORIGINS),
  originSource: blankToNull(trimmed(1, 500)), reason,
});
export const PriceVendorStatusSchema = z.object({ slug: priceSlug, status: z.enum(PRICE_VENDOR_STATUSES), unreadable: z.literal('on').optional(), reason });
export const PriceCoaSchema = z.object({
  id: blankToNull(id), vendor: priceSlug, compound: blankToNull(priceSlug), url: httpsUrl(1000), scope: z.enum(COA_SCOPES),
  batch: blankToNull(trimmed(1, 80)), lab: blankToNull(trimmed(2, 120)), labAccreditation: blankToNull(trimmed(2, 120)),
  method: blankToNull(z.enum(COA_METHODS)), testDate: blankToNull(isoDate),
  purity: blankToNull(z.coerce.number().gt(0).max(100)), quote: blankToNull(trimmed(1, 500)), reason,
});
export const PriceCoaStatusSchema = z.object({ id, status: z.enum(COA_STATUSES), reason });

export const ConfigChangeSchema = z.object({ key: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/), raw: z.string().max(4000).optional(), reason });
export const AnnouncementSchema = z.object({
  en: z.string().trim().max(280), fr: z.string().trim().max(280), tone: z.enum(['info', 'warn']),
  until: z.union([z.literal(''), isoDate]), reason,
});
export const CategorySchema = z.object({
  id: slug, nameEn: trimmed(2, 60), nameFr: trimmed(2, 60), icon: z.string().regex(/^[a-z]{2,20}$/),
  descriptionEn: z.string().trim().max(500), descriptionFr: z.string().trim().max(500),
  rulesEn: z.string().max(2000), rulesFr: z.string().max(2000),
  minNoteRatings: z.union([z.literal(''), z.coerce.number().int().min(3).max(200)]),
  sortOrder: z.coerce.number().int().min(0).max(999), reason,
});
export const ArchiveCategorySchema = z.object({ id: slug, archived: onOff, reason });
export const CitySchema = z.object({ id: slug, zone: z.string().regex(/^[a-z]{2,16}$/), name: trimmed(2, 60), sortOrder: z.coerce.number().int().min(0).max(999), reason });
export const ZoneSchema = z.object({
  id: z.string().regex(/^[a-z]{2,16}$/), nameEn: trimmed(2, 60), nameFr: trimmed(2, 60), shortName: trimmed(2, 20),
  descriptionEn: z.string().trim().max(500), descriptionFr: z.string().trim().max(500), reason,
});

/** FormData → plain object; repeated keys become arrays. */
export function formToObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') continue; // no file uploads in v1
    if (key in out) {
      const existing = out[key];
      out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** First message per field, keyed by top-level field name. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}
