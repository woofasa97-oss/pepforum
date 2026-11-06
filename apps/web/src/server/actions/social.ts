'use server';

/**
 * Following (…027). The database checks the member, the target and the rate
 * limit; this validates input and refreshes the profiles involved.
 */
import { SOCIAL_PLATFORMS } from '@pepforum/database';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

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

/** Remove one of your verified accounts (Settings). The bonus is recomputed by the database. */
export async function unlinkSocialAction(form: FormData): Promise<void> {
  const platform = SOCIAL_PLATFORMS.find((p) => p === form.get('platform'));
  if (!platform) redirect('/settings?social=failed#socials');
  const supabase = await getSupabase();
  const { error } = await supabase.rpc('unlink_social_account', { p_platform: platform });
  if (error) logUnexpected('unlink_social_account', error);
  const standing = await getStanding();
  if (standing) revalidatePath(`/u/${standing.username}`);
  redirect(`/settings?social=${error ? 'failed' : 'removed'}#socials`);
}
