'use server';

/**
 * Following (…027). The database checks the member, the target and the rate
 * limit; this validates input and refreshes the profiles involved.
 */
import { revalidatePath } from 'next/cache';

import type { ActionState } from '@/lib/action-state';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import { FollowSchema, formToObject } from '@/lib/validation';
import { getSupabase, getStanding, getT } from '@/server/context';

export async function followAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const standing = await getStanding();
  if (!standing) return { ok: false, message: t('errors.signInRequired') };
  const parsed = FollowSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid') };

  const supabase = await getSupabase();
  const { error } = await supabase.rpc('set_follow', { p_username: parsed.data.username, p_follow: parsed.data.follow === 'true' });
  if (error) {
    logUnexpected('set_follow', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath(`/u/${parsed.data.username}`, 'layout');
  revalidatePath(`/u/${standing.username}`, 'layout');
  return { ok: true };
}
