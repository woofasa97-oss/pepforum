'use server';

import { revalidatePath } from 'next/cache';

import type { ActionState } from '@/lib/action-state';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import { DecideAppealSchema, ResolveReportsSchema, fieldErrors, formToObject } from '@/lib/validation';
import { getSupabase, getT, getViewer } from '@/server/context';

/**
 * Moderator actions. The database requires a (site-wide) moderator AND an MFA
 * (aal2) session, and records every action in the append-only mod log.
 */
export async function resolveReportsAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const raw = formToObject(form);
  const parsed = ResolveReportsSchema.safeParse({ ...raw, abusive: form.getAll('abusive').map(String) });
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };

  const supabase = await getSupabase();
  const { error } = await supabase.rpc('resolve_reports', {
    p_target_kind: parsed.data.kind,
    p_target_id: parsed.data.targetId,
    p_decision: parsed.data.decision,
    p_violation: parsed.data.violation || null,
    p_reason: parsed.data.reason,
    p_abusive_report_ids: parsed.data.abusive,
  });
  if (error) {
    logUnexpected('resolve_reports', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/mod');
  revalidatePath('/admin', 'layout');
  return { ok: true, message: t('mod.done') };
}

export async function decideAppealAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = DecideAppealSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('decide_appeal', {
    p_appeal_id: parsed.data.appealId,
    p_uphold: parsed.data.uphold === 'true',
    p_note: parsed.data.note,
  });
  if (error) {
    logUnexpected('decide_appeal', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/mod');
  revalidatePath('/admin', 'layout');
  return { ok: true, message: t('mod.done') };
}

export async function submitAppealAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const actionId = String(form.get('modActionId') ?? '');
  const body = String(form.get('body') ?? '').trim();
  if (body.length < 10 || body.length > 2000) return { ok: false, fieldErrors: { body: t('errors.invalid') } };
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('submit_appeal', { p_mod_action_id: actionId, p_body: body });
  if (error) {
    logUnexpected('submit_appeal', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/karma');
  return { ok: true, message: t('mod.done') };
}
