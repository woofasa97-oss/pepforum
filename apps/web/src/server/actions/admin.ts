'use server';

/**
 * Admin console actions. Thin by design: the database decides who may do
 * what (admin + MFA), checks every rule, requires the reason and writes the
 * moderation log. These functions validate input, call one RPC and map the
 * outcome to a message. Logs carry error codes only.
 */
import { CONFIG_FIELD_BY_KEY, type Json } from '@pepforum/database';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/lib/action-state';
import { type DbErrorLike, logUnexpected, messageForDbError } from '@/lib/errors';
import {
  AdAdjustmentSchema,
  AdPaymentSchema,
  AdminRemoveSchema,
  AdvertiserDecisionSchema,
  AnnouncementSchema,
  ArchiveCategorySchema,
  CampaignDecisionSchema,
  CategorySchema,
  ClinicianDecisionSchema,
  CitySchema,
  ConfigChangeSchema,
  ContentReasonSchema,
  DeleteRedirectSchema,
  FindByEmailSchema,
  FoundingSchema,
  IdReasonSchema,
  LinkDecisionSchema,
  LinkSiteSchema,
  MemberReasonSchema,
  RedirectSchema,
  RenameMemberSchema,
  ResolveMemberReportsSchema,
  RevealEmailSchema,
  RevokeSanctionSchema,
  RevokeStrikeSchema,
  SanctionSchema,
  SetModeratorSchema,
  SetRoleSchema,
  ShieldAddSchema,
  ShieldRemoveSchema,
  ShieldTestSchema,
  StaffNoteSchema,
  TicketClosedSchema,
  TicketReplySchema,
  ToggleSchema,
  ZoneSchema,
  fieldErrors,
  formToObject,
} from '@/lib/validation';
import { getSupabase, getT } from '@/server/context';

type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: DbErrorLike | null }>;

async function rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: DbErrorLike | null }> {
  const supabase = await getSupabase();
  // Admin RPC names are validated by the database; a typed overload per call adds nothing here.
  return (supabase.rpc.bind(supabase) as unknown as Rpc)(fn, args);
}

/** Runs one admin RPC and turns the outcome into an ActionState. */
async function run(fn: string, args: Record<string, unknown>, done?: string): Promise<ActionState> {
  const t = await getT();
  const { error } = await rpc(fn, args);
  if (error) {
    logUnexpected(fn, error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/admin', 'layout');
  return { ok: true, message: done ?? t('admin.done') };
}

async function invalid(error: Parameters<typeof fieldErrors>[0]): Promise<ActionState> {
  const t = await getT();
  return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(error) };
}

/** Username → id through the admin read (works for any member, deleted or not). */
async function memberId(username: string): Promise<string | null> {
  const { data } = await rpc('admin_member', { p_username: username });
  return (data as { id?: string } | null)?.id ?? null;
}

// ── People ────────────────────────────────────────────────────────────────
export async function revealEmailAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = RevealEmailSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  const { data, error } = await rpc('admin_reveal_email', { p_user: parsed.data.userId, p_reason: parsed.data.reason });
  if (error) {
    logUnexpected('admin_reveal_email', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  return { ok: true, message: t('admin.people.revealed', { email: String(data) }) };
}

export async function findByEmailAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = FindByEmailSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: { email: t('errors.invalid') } };
  const { data, error } = await rpc('admin_find_by_email', { p_email: parsed.data.email });
  if (error) {
    logUnexpected('admin_find_by_email', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  if (!data) return { ok: false, message: t('admin.people.noEmailMatch') };
  redirect(`/admin/people/${encodeURIComponent(String(data))}`);
}

export async function sanctionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = SanctionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const { userId, kind, days, reason } = parsed.data;
  return run('apply_sanction', { p_user: userId, p_kind: kind, p_reason: reason, p_days: kind === 'freeze' || kind === 'suspension' ? days : null });
}

export async function revokeSanctionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = RevokeSanctionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('revoke_sanction', { p_sanction_id: parsed.data.sanctionId, p_reason: parsed.data.reason });
}

export async function staffNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = StaffNoteSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('add_staff_note', { p_user: parsed.data.userId, p_label: parsed.data.label, p_body: parsed.data.body });
}

export async function setRoleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = SetRoleSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const id = await memberId(parsed.data.username);
  if (!id) return { ok: false, fieldErrors: { username: (await getT())('errors.notFound') } };
  return run('admin_set_role', { p_user: id, p_admin: parsed.data.admin === 'true', p_reason: parsed.data.reason });
}

// ── Member reports ───────────────────────────────────────────────────────
export async function resolveMemberReportsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ResolveMemberReportsSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  const id = await memberId(parsed.data.username);
  if (!id) return { ok: false, message: t('errors.notFound') };
  const { data, error } = await rpc('admin_resolve_member_reports', { p_user: id, p_outcome: parsed.data.outcome, p_reason: parsed.data.reason });
  if (error) {
    logUnexpected('admin_resolve_member_reports', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/admin', 'layout');
  return { ok: true, message: t('admin.reports.closedDone', { n: Number(data) }) };
}

// ── Inbox (…020) ──────────────────────────────────────────────────────────
export async function adminReplyTicketAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = TicketReplySchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  const close = parsed.data.close === 'on';
  const { error } = await rpc('admin_reply_ticket', { p_ticket: parsed.data.ticketId, p_body: parsed.data.body, p_close: close });
  if (error) {
    logUnexpected('admin_reply_ticket', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/admin', 'layout');
  return { ok: true, message: close ? t('admin.inbox.sentClosed') : t('admin.inbox.sent') };
}

export async function adminSetTicketClosedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = TicketClosedSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const closed = parsed.data.closed === 'true';
  const t = await getT();
  return run('admin_set_ticket_closed', { p_ticket: parsed.data.ticketId, p_closed: closed }, closed ? t('admin.inbox.closedDone') : t('admin.inbox.reopenedDone'));
}

export async function setModeratorAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = SetModeratorSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const id = await memberId(parsed.data.username);
  if (!id) return { ok: false, fieldErrors: { username: (await getT())('errors.notFound') } };
  return run('set_zone_moderator', { p_user: id, p_zone: parsed.data.zone, p_appoint: parsed.data.appoint === 'true', p_reason: parsed.data.reason });
}

export async function foundingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = FoundingSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const id = await memberId(parsed.data.username);
  if (!id) return { ok: false, fieldErrors: { username: (await getT())('errors.notFound') } };
  if (parsed.data.end) return run('admin_end_founding', { p_user: id, p_reason: parsed.data.reason });
  if (!parsed.data.until) return { ok: false, fieldErrors: { until: (await getT())('errors.invalid') } };
  return run('grant_founding_rater', { p_user: id, p_until: `${parsed.data.until}T23:59:59Z`, p_reason: parsed.data.reason });
}

export async function clearWritingLockAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = MemberReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_clear_writing_lock', { p_user: parsed.data.userId, p_reason: parsed.data.reason });
}

export async function renameMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = RenameMemberSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('admin_rename_user', { p_user: parsed.data.userId, p_username: parsed.data.username, p_reason: parsed.data.reason });
  if (result.ok) redirect(`/admin/people/${encodeURIComponent(parsed.data.username)}`);
  return result;
}

export async function revokeStrikeAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = RevokeStrikeSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_revoke_strike', { p_strike: parsed.data.strikeId, p_reason: parsed.data.reason });
}

// ── Content ───────────────────────────────────────────────────────────────
export async function restoreContentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ContentReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_restore_content', { p_kind: parsed.data.kind, p_id: parsed.data.id, p_reason: parsed.data.reason });
}

export async function removeContentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = AdminRemoveSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('moderate_remove', { p_target_kind: parsed.data.kind, p_target_id: parsed.data.id, p_violation: parsed.data.violation, p_reason: parsed.data.reason });
}

export async function setNoteHiddenAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ToggleSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_set_note_hidden', { p_note: parsed.data.id, p_hidden: parsed.data.on === 'true', p_reason: parsed.data.reason });
}

export async function setPinnedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ToggleSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_set_pinned', { p_post: parsed.data.id, p_pinned: parsed.data.on === 'true', p_reason: parsed.data.reason });
}

export async function setCommentsLockedAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ToggleSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_set_comments_locked', { p_post: parsed.data.id, p_locked: parsed.data.on === 'true', p_reason: parsed.data.reason });
}

// ── Sourcing shield ───────────────────────────────────────────────────────
export async function shieldAddAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ShieldAddSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const { kind, value, action, reason } = parsed.data;
  return run('admin_shield_add', { p_kind: kind, p_value: value, p_action: kind === 'phrase' ? (action ?? 'hold') : null, p_reason: reason });
}

export async function shieldRemoveAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ShieldRemoveSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_shield_remove', { p_kind: parsed.data.kind, p_value: parsed.data.value, p_reason: parsed.data.reason });
}

export async function shieldTestAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = ShieldTestSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const { data, error } = await rpc('admin_shield_test', { p_text: parsed.data.text });
  if (error) {
    logUnexpected('admin_shield_test', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  const matches = (data ?? []) as Array<{ rule: string; action: string }>;
  if (matches.length === 0) return { ok: true, message: t('admin.shield.testClean') };
  return {
    ok: false,
    message: t('admin.shield.testMatches', {
      rules: matches.map((m) => `“${m.rule}” (${t(m.action === 'block' ? 'admin.shield.block' : 'admin.shield.hold')})`).join(', '),
    }),
  };
}

// ── Links ─────────────────────────────────────────────────────────────────
// Approving is one click, so it carries a standard reason; declining, blocking
// and removing an approval need the admin's own.
export async function linkDecisionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = LinkDecisionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  const { kind, id, decision, reason } = parsed.data;
  return run('admin_link_decide', {
    p_kind: kind, p_id: id, p_decision: decision,
    p_reason: reason ?? (decision === 'approve' ? t('admin.links.approveReason') : ''),
  }, t(decision === 'approve' ? 'admin.links.approvedDone' : 'admin.links.declinedDone'));
}

export async function linkSiteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = LinkSiteSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  const { host, decision, reason } = parsed.data;
  const { data, error } = await rpc('admin_link_site', {
    p_host: host, p_decision: decision,
    p_reason: reason ?? (decision === 'approve' ? t('admin.links.approveSiteReason') : ''),
  });
  if (error) {
    logUnexpected('admin_link_site', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/admin', 'layout');
  const n = typeof data === 'number' ? data : 0;
  if (decision === 'approve') return { ok: true, message: t('admin.links.siteApprovedDone', { n }) };
  if (decision === 'block') return { ok: true, message: t('admin.links.siteBlockedDone', { n }) };
  return { ok: true, message: t('admin.done') };
}

// ── Settings ──────────────────────────────────────────────────────────────

/** Builds the JSON value for a config key from its typed inputs (see config-fields.ts). */
function configValue(key: string, form: FormData): Json | undefined {
  const field = CONFIG_FIELD_BY_KEY.get(key);
  const text = (name: string) => String(form.get(name) ?? '').trim();
  const num = (name: string) => (text(name) === '' ? Number.NaN : Number(text(name)));
  switch (field?.input) {
    case 'integer':
    case 'tier':
    case 'decimal': {
      const n = num('value');
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return text('value') === 'true';
    case 'tiers': {
      const values = [0, 1, 2, 3, 4].map((i) => num(`value${i}`));
      return values.every(Number.isFinite) ? values : undefined;
    }
    case 'rate_limit': {
      const limit = num('limit');
      const window = num('window');
      return Number.isFinite(limit) && Number.isFinite(window) ? { limit, window_seconds: window } : undefined;
    }
    case 'scoring_mode':
      return text('value');
    case 'classifications':
      return form.getAll('value').map(String);
    default:
      return undefined;
  }
}

export async function setConfigAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = ConfigChangeSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  let value: Json | undefined;
  if (parsed.data.raw !== undefined) {
    try {
      value = JSON.parse(parsed.data.raw) as Json;
    } catch {
      value = undefined;
    }
  } else {
    value = configValue(parsed.data.key, form);
  }
  if (value === undefined) return { ok: false, message: t('errors.invalid') };
  return run('admin_set_config', { p_key: parsed.data.key, p_value: value, p_reason: parsed.data.reason });
}

export async function announcementAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = AnnouncementSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const { en, fr, tone, until, reason } = parsed.data;
  const result = await run('admin_set_config', { p_key: 'site.announcement', p_value: { en, fr, tone, until: until || null }, p_reason: reason });
  if (result.ok) revalidatePath('/', 'layout'); // the banner is in the site header
  return result;
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10);

export async function upsertCategoryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = CategorySchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const c = parsed.data;
  const result = await run('admin_upsert_category', {
    p_id: c.id, p_name_en: c.nameEn, p_name_fr: c.nameFr, p_icon: c.icon,
    p_description_en: c.descriptionEn, p_description_fr: c.descriptionFr,
    p_rules_en: lines(c.rulesEn), p_rules_fr: lines(c.rulesFr),
    p_min_note_ratings: c.minNoteRatings === '' ? null : c.minNoteRatings, p_sort_order: c.sortOrder, p_reason: c.reason,
  });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

export async function archiveCategoryAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ArchiveCategorySchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('admin_archive_category', { p_id: parsed.data.id, p_archived: parsed.data.archived === 'true', p_reason: parsed.data.reason });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

export async function upsertCityAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = CitySchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const c = parsed.data;
  return run('admin_upsert_city', { p_id: c.id, p_zone_id: c.zone, p_name: c.name, p_sort_order: c.sortOrder, p_reason: c.reason });
}

export async function updateZoneAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ZoneSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const z = parsed.data;
  const result = await run('admin_update_zone', {
    p_id: z.id, p_name_en: z.nameEn, p_name_fr: z.nameFr, p_short_name: z.shortName,
    p_description_en: z.descriptionEn, p_description_fr: z.descriptionFr, p_reason: z.reason,
  });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

// ── SEO: managed redirects (…021) ─────────────────────────────────────────
export async function setRedirectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = RedirectSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const r = parsed.data;
  return run('admin_set_redirect', { p_from: r.from, p_to: r.to, p_permanent: r.permanent === 'true', p_reason: r.reason });
}

export async function deleteRedirectAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = DeleteRedirectSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_delete_redirect', { p_from: parsed.data.from, p_reason: parsed.data.reason });
}

// ── Media (…023) ──────────────────────────────────────────────────────────
export async function removeMediaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = IdReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('admin_remove_media', { p_id: parsed.data.id, p_reason: parsed.data.reason });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

// ── Clinician verification (…024) ─────────────────────────────────────────
export async function reviewClinicianAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ClinicianDecisionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('admin_review_clinician', { p_id: parsed.data.id, p_decision: parsed.data.decision, p_reason: parsed.data.reason });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

export async function revokeClinicianAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = MemberReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('admin_revoke_clinician', { p_user: parsed.data.userId, p_reason: parsed.data.reason });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

// ── Advertising (…025) ────────────────────────────────────────────────────
const MICRO = 1_000_000;

export async function reviewAdvertiserAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = AdvertiserDecisionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_review_advertiser', { p_id: parsed.data.id, p_decision: parsed.data.decision, p_reason: parsed.data.reason });
}

export async function reviewCampaignAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = CampaignDecisionSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('admin_review_campaign', { p_id: parsed.data.id, p_decision: parsed.data.decision, p_reason: parsed.data.reason });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

export async function suspendCampaignAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = IdReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('admin_suspend_campaign', { p_id: parsed.data.id, p_reason: parsed.data.reason });
  if (result.ok) revalidatePath('/', 'layout');
  return result;
}

export async function recordAdPaymentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = AdPaymentSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const p = parsed.data;
  return run('admin_record_ad_payment', { p_advertiser: p.advertiserId, p_amount_microcad: Math.round(p.amountCad * MICRO), p_reference: p.reference, p_reason: p.reason });
}

export async function adAdjustmentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = AdAdjustmentSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const p = parsed.data;
  return run('admin_ad_adjustment', { p_advertiser: p.advertiserId, p_amount_microcad: Math.round(p.amountCad * MICRO), p_reference: p.reference, p_reason: p.reason });
}

export async function resolveAdReportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = IdReasonSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('admin_resolve_ad_report', { p_id: parsed.data.id, p_reason: parsed.data.reason });
}
