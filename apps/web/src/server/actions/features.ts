'use server';

/**
 * Member-facing actions for the features ported from the prototype:
 * notifications and push (…022), images (…023), clinician verification (…024)
 * and the advertiser workspace (…025). Each validates with zod, calls one RPC
 * as the signed-in member (the database re-checks everything) and maps the
 * outcome to a message. Logs carry codes only.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/lib/action-state';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import {
  AdvertiserSchema,
  CampaignIdSchema,
  CampaignPauseSchema,
  CampaignSchema,
  ClinicianSubmitSchema,
  MarkReadSchema,
  MediaIdSchema,
  NotificationSettingsSchema,
  PushEndpointSchema,
  PushSubscriptionSchema,
  ReportAdSchema,
  fieldErrors,
  formToObject,
} from '@/lib/validation';
import { getSupabase, getT, getViewer } from '@/server/context';

type RpcResult = { data: unknown; error: { code?: string | null; message?: string | null; details?: string | null } | null };
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;

async function rpc(fn: string, args: Record<string, unknown>): Promise<RpcResult> {
  const supabase = await getSupabase();
  return (supabase.rpc.bind(supabase) as unknown as Rpc)(fn, args);
}

async function run(fn: string, args: Record<string, unknown>, done?: string, paths: string[] = []): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const { error } = await rpc(fn, args);
  if (error) {
    logUnexpected(fn, error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  for (const path of paths) revalidatePath(path);
  return { ok: true, ...(done ? { message: done } : {}) };
}

async function invalid(error: Parameters<typeof fieldErrors>[0]): Promise<ActionState> {
  const t = await getT();
  return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(error) };
}

// ── Notifications ─────────────────────────────────────────────────────────
export async function markNotificationsReadAction(form: FormData): Promise<void> {
  const parsed = MarkReadSchema.safeParse(formToObject(form));
  if (!(await getViewer())) return;
  const ids = parsed.success && parsed.data.id ? [parsed.data.id] : null;
  const { error } = await rpc('mark_notifications_read', { p_ids: ids });
  if (error) logUnexpected('mark_notifications_read', error);
  revalidatePath('/', 'layout');
}

export async function updateNotificationSettingsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = NotificationSettingsSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const s = parsed.data;
  const t = await getT();
  return run('set_notification_settings', {
    p_replies: s.replies === 'on', p_notes: s.notes === 'on', p_moderation: s.moderation === 'on', p_team: s.team === 'on', p_push: s.push === 'on',
  }, t('settings.saved'), ['/settings/notifications']);
}

/** Called by the PushSettings client component after the browser granted permission. */
export async function savePushSubscriptionAction(input: { endpoint: string; p256dh: string; auth: string; userAgent?: string }): Promise<ActionState> {
  const parsed = PushSubscriptionSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  return run('save_push_subscription', {
    p_endpoint: parsed.data.endpoint, p_p256dh: parsed.data.p256dh, p_auth: parsed.data.auth, p_user_agent: (input.userAgent ?? '').slice(0, 200),
  }, t('notifications.pushEnabled'), ['/settings/notifications']);
}

export async function deletePushSubscriptionAction(input: { endpoint: string }): Promise<ActionState> {
  const parsed = PushEndpointSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  return run('delete_push_subscription', { p_endpoint: parsed.data.endpoint }, t('notifications.pushDisabled'), ['/settings/notifications']);
}

// ── Media ─────────────────────────────────────────────────────────────────
export async function deleteMediaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = MediaIdSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('delete_my_media', { p_id: parsed.data.mediaId }, undefined, ['/', '/submit']);
}

// ── Clinician verification ────────────────────────────────────────────────
export async function submitClinicianAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ClinicianSubmitSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const c = parsed.data;
  const t = await getT();
  return run('submit_clinician_verification', {
    p_profession: c.profession, p_regulator: c.regulator, p_province: c.province, p_registration_number: c.registrationNumber,
    p_document_id: c.documentId, p_statement: c.statement ?? '',
  }, t('clinician.submitted'), ['/settings/clinician']);
}

export async function withdrawClinicianAction(): Promise<void> {
  const t = await getT();
  await run('withdraw_clinician_verification', {}, t('clinician.withdrawn'), ['/settings/clinician']);
}

// ── Advertiser workspace ──────────────────────────────────────────────────
const MICRO = 1_000_000;

export async function createAdvertiserAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = AdvertiserSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const a = parsed.data;
  const t = await getT();
  return run('create_advertiser', {
    p_name: a.name, p_website: a.website, p_billing_email: a.billingEmail, p_billing_address: a.billingAddress, p_billing_province: a.billingProvince,
  }, t('ads.orgCreated'), ['/advertiser']);
}

export async function upsertCampaignAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = CampaignSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const c = parsed.data;
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const { data, error } = await rpc('upsert_campaign', {
    p_id: c.id || null, p_name: c.name, p_package: c.package, p_zone: c.zone || null, p_category: c.category || null,
    p_budget_microcad: c.budgetCad * MICRO,
    p_headline: c.headline, p_body: c.body, p_cta: c.cta, p_headline_fr: c.headlineFr, p_body_fr: c.bodyFr, p_cta_fr: c.ctaFr,
    p_landing_url: c.landingUrl, p_image_id: c.imageId || null,
  });
  if (error) {
    logUnexpected('upsert_campaign', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/advertiser');
  redirect(`/advertiser/campaign?id=${encodeURIComponent(String(data))}&saved=1`);
}

export async function submitCampaignAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = CampaignIdSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  return run('submit_campaign', { p_id: parsed.data.id }, t('ads.submitted'), ['/advertiser', '/advertiser/campaign']);
}

export async function pauseCampaignAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = CampaignPauseSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  return run('set_campaign_paused', { p_id: parsed.data.id, p_paused: parsed.data.paused === 'true' }, undefined, ['/advertiser', '/advertiser/campaign']);
}

export async function withdrawCampaignAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = CampaignIdSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const result = await run('withdraw_campaign', { p_id: parsed.data.id }, undefined, ['/advertiser']);
  if (result.ok) redirect('/advertiser');
  return result;
}

export async function reportAdAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const parsed = ReportAdSchema.safeParse(formToObject(form));
  if (!parsed.success) return invalid(parsed.error);
  const t = await getT();
  return run('report_ad', { p_id: parsed.data.id, p_reason: parsed.data.reason, p_details: parsed.data.details ?? '' }, t('ads.reported'));
}
