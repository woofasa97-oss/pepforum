'use server';

/**
 * Contact the team (…020): members open tickets, reply and close them. The
 * database checks ownership, capability and rate limits; these actions
 * validate input and map failures to messages. Logs carry codes, never text.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/lib/action-state';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import { OpenTicketSchema, TicketIdSchema, TicketReplySchema, fieldErrors, formToObject } from '@/lib/validation';
import { getSupabase, getT, getViewer } from '@/server/context';

export async function openTicketAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = OpenTicketSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };
  const p = parsed.data;

  const supabase = await getSupabase();
  const { data: ticketId, error } = await supabase.rpc('open_ticket', {
    p_kind: p.kind,
    p_subject: p.subject,
    p_body: p.body,
    p_about_username: p.kind === 'report_member' ? p.aboutUsername || null : null,
    p_about_url: p.aboutUrl || null,
  });
  if (error) {
    logUnexpected('open_ticket', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/contact');
  redirect(`/contact/${ticketId}?sent=1`);
}

export async function replyTicketAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = TicketReplySchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('reply_ticket', { p_ticket: parsed.data.ticketId, p_body: parsed.data.body });
  if (error) {
    logUnexpected('reply_ticket', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath(`/contact/${parsed.data.ticketId}`);
  return { ok: true, message: t('contact.replySent') };
}

export async function closeMyTicketAction(form: FormData): Promise<void> {
  const parsed = TicketIdSchema.safeParse(formToObject(form));
  if (!parsed.success) return;
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('close_my_ticket', { p_ticket: parsed.data.ticketId });
  if (error) logUnexpected('close_my_ticket', error);
  revalidatePath('/contact');
  redirect(`/contact/${parsed.data.ticketId}`);
}
