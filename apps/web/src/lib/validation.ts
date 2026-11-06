/**
 * Input validation for every form. These mirror the SQL constraints and RPC
 * checks — the database remains the final authority; validating here gives
 * members precise field errors and keeps junk off the wire.
 */
import {
  LINK_DECISIONS,
  LOCALES,
  NOTE_CLASSIFICATIONS,
  POST_TYPES,
  RATING_REASONS,
  RATING_VALUES,
  REPORT_REASONS,
  SANCTION_KINDS,
  SHIELD_ACTIONS,
  SITE_DECISIONS,
  SOURCE_KINDS,
  STAFF_NOTE_LABELS,
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

export const EditPostSchema = z.object({ postId: id, ...postFields });

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
export const LinkSiteSchema = z.object({ host: trimmed(3, 253), decision: z.enum(SITE_DECISIONS), reason: reason.optional() });
/** `raw` (JSON) is used by Revert; otherwise the value is built from typed inputs. */
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
