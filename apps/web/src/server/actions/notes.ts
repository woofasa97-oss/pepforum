'use server';

import { inferSourceKind } from '@pepforum/database';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/lib/action-state';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import { ProposeNoteSchema, RateNoteSchema, fieldErrors } from '@/lib/validation';
import { getSupabase, getT, getViewer } from '@/server/context';

export async function proposeNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };

  const urls = form.getAll('sourceUrl').map(String).map((u) => u.trim()).filter(Boolean);
  const parsed = ProposeNoteSchema.safeParse({
    postId: form.get('postId'),
    classification: form.get('classification'),
    body: form.get('body'),
    language: form.get('language'),
    sources: urls.map((url) => ({ url, kind: inferSourceKind(url) })),
  });
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };

  const supabase = await getSupabase();
  const { data: noteId, error } = await supabase.rpc('propose_note', {
    p_post_id: parsed.data.postId,
    p_classification: parsed.data.classification,
    p_body: parsed.data.body,
    p_sources: parsed.data.sources,
    p_language: parsed.data.language,
  });
  if (error) {
    logUnexpected('propose_note', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath(`/post/${parsed.data.postId}`);
  redirect(`/notes/${noteId}`);
}

export async function rateNoteAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = RateNoteSchema.safeParse({
    noteId: form.get('noteId'),
    value: form.get('value'),
    reasons: form.getAll('reasons').map(String),
  });
  if (!parsed.success) return { ok: false, message: t('rate.why'), fieldErrors: fieldErrors(parsed.error) };

  const supabase = await getSupabase();
  const { error } = await supabase.rpc('rate_note', {
    p_note_id: parsed.data.noteId,
    p_value: parsed.data.value,
    p_reasons: parsed.data.reasons,
  });
  if (error) {
    logUnexpected('rate_note', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath(`/notes/${parsed.data.noteId}`);
  return { ok: true, message: t('rate.submitted') };
}

/** Assigns the next note from the randomised queue (assignment = full rating weight). */
export async function nextNoteAction(): Promise<void> {
  const supabase = await getSupabase();
  const { data: noteId, error } = await supabase.rpc('next_note_to_rate');
  if (error) {
    logUnexpected('next_note_to_rate', error);
    redirect(`/notes?error=${encodeURIComponent(error.details || error.message || 'unexpected')}`);
  }
  redirect(noteId ? `/notes/${noteId}` : '/notes?queue=empty');
}
