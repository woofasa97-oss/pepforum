'use server';

/**
 * Posts, comments, votes and reports. Each action validates input, calls the
 * RPC as the signed-in member (the database re-checks capability, ownership
 * and rate limits) and maps failures to friendly messages.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/lib/action-state';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import { CommentSchema, CreatePostSchema, EditPostSchema, ReportSchema, VoteSchema, fieldErrors, formToObject } from '@/lib/validation';
import { getSupabase, getT, getViewer } from '@/server/context';

export async function createPostAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = CreatePostSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };
  const p = parsed.data;

  const supabase = await getSupabase();
  const { data: postId, error } = await supabase.rpc('create_post', {
    p_zone_id: p.zone,
    p_category_id: p.category,
    p_post_type: p.type,
    p_title: p.title,
    p_body: p.body,
    p_link_url: p.link || null,
    p_city_id: p.city || null,
    p_language: p.language,
  });
  if (error) {
    logUnexpected('create_post', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/');
  redirect(`/post/${postId}`);
}

export async function editPostAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = EditPostSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('edit_post', {
    p_post_id: parsed.data.postId,
    p_title: parsed.data.title,
    p_body: parsed.data.body,
    p_link_url: parsed.data.link || null,
  });
  if (error) {
    logUnexpected('edit_post', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  redirect(`/post/${parsed.data.postId}`);
}

export async function deletePostAction(form: FormData): Promise<void> {
  const postId = String(form.get('postId') ?? '');
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('delete_own_post', { p_post_id: postId });
  if (error) logUnexpected('delete_own_post', error);
  revalidatePath('/');
  redirect('/');
}

export async function createCommentAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = CommentSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error) };
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('create_comment', {
    p_post_id: parsed.data.postId,
    p_body: parsed.data.body,
    p_parent_id: parsed.data.parentId || null,
  });
  if (error) {
    logUnexpected('create_comment', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath(`/post/${parsed.data.postId}`);
  return { ok: true };
}

export interface VoteResult {
  readonly ok: boolean;
  readonly score?: number;
  readonly message?: string;
}

export async function voteAction(kind: 'post' | 'comment', targetId: string, value: -1 | 0 | 1): Promise<VoteResult> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = VoteSchema.safeParse({ kind, targetId, value });
  if (!parsed.success) return { ok: false, message: t('errors.invalid') };
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('cast_vote', {
    p_target_kind: parsed.data.kind,
    p_target_id: parsed.data.targetId,
    p_value: parsed.data.value,
  });
  if (error) {
    logUnexpected('cast_vote', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  return { ok: true, score: data.score };
}

export async function reportAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = ReportSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid') };
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('file_report', {
    p_target_kind: parsed.data.kind,
    p_target_id: parsed.data.targetId,
    p_reason: parsed.data.reason,
    p_details: parsed.data.details ?? '',
  });
  if (error) {
    logUnexpected('file_report', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  return { ok: true, message: data.collapsed ? t('report.collapsed') : t('report.sent') };
}
