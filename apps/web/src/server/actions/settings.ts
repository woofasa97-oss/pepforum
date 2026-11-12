'use server';

import { LOCALES } from '@pepforum/database';
import { revalidatePath } from 'next/cache';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/lib/action-state';
import { hasPassword } from '@/lib/auth-providers';
import { env } from '@/lib/env';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import { LOCALE_COOKIE } from '@/lib/i18n';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { DeleteAccountSchema, ProfileSchema, fieldErrors, formToObject } from '@/lib/validation';
import { getSupabase, getT, getViewer } from '@/server/context';

const preferenceCookie = () =>
  ({ httpOnly: true, sameSite: 'lax', secure: env().NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 365 }) as const;

export async function updateProfileAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const viewer = await getViewer();
  if (!viewer) return { ok: false, message: t('errors.signInRequired') };
  const parsed = ProfileSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error) };

  const supabase = await getSupabase();
  // Direct table update is allowed only for these columns (column-level grant + RLS).
  const { error } = await supabase
    .from('profiles')
    .update({ bio: parsed.data.bio, coi: parsed.data.coi, locale: parsed.data.locale })
    .eq('id', viewer.id);
  if (error) {
    logUnexpected('update_profile', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  (await cookies()).set(LOCALE_COOKIE, parsed.data.locale, preferenceCookie());
  revalidatePath('/', 'layout');
  return { ok: true, message: t('settings.saved') };
}

/** Back to the page the form was submitted from (same-origin path only). */
async function backToReferrer(): Promise<never> {
  const referer = (await headers()).get('referer');
  let path = '/';
  if (referer) {
    try {
      const url = new URL(referer);
      path = url.pathname + url.search;
    } catch {
      // ignore malformed referer
    }
  }
  redirect(safeRedirectPath(path));
}

export async function setLocaleAction(form: FormData): Promise<void> {
  const locale = String(form.get('locale'));
  if ((LOCALES as readonly string[]).includes(locale)) {
    (await cookies()).set(LOCALE_COOKIE, locale, preferenceCookie());
  }
  await backToReferrer();
}

export async function setThemeAction(form: FormData): Promise<void> {
  const theme = String(form.get('theme'));
  if (theme === 'light' || theme === 'dark') (await cookies()).set('pf-theme', theme, preferenceCookie());
  await backToReferrer();
}

/**
 * Account deletion re-authenticates with the password first: a stolen session
 * cookie alone can't erase an account.
 */
const RECENT_SIGN_IN_SECONDS = 10 * 60;

export async function deleteAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = DeleteAccountSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error) };

  const supabase = await getSupabase();
  const { data: userData } = await supabase.auth.getUser();
  const account = userData.user;
  if (!account) return { ok: false, message: t('errors.unexpected') };

  // Re-authenticate: the password if the account has one, otherwise a sign-in
  // (e.g. with Google) within the last few minutes, so a stolen or forgotten
  // session alone can't erase the account.
  if (hasPassword(account.identities)) {
    if (!account.email || !parsed.data.password) return { ok: false, fieldErrors: { password: t('auth.invalidCredentials') } };
    const { error: reauthError } = await supabase.auth.signInWithPassword({ email: account.email, password: parsed.data.password });
    if (reauthError) return { ok: false, fieldErrors: { password: t('auth.invalidCredentials') } };
  } else {
    if (parsed.data.confirm !== 'on') return { ok: false, fieldErrors: { confirm: t('errors.invalid') } };
    const { data: session } = await supabase.auth.getClaims();
    const signedInAt = Math.max(0, ...(session?.claims.amr ?? []).map((m) => (typeof m === 'string' ? 0 : m.timestamp)));
    if (Date.now() / 1000 - signedInAt > RECENT_SIGN_IN_SECONDS) return { ok: false, message: t('settings.deleteReauth') };
  }

  const { error } = await supabase.rpc('request_account_deletion', { p_erase_content: parsed.data.erase === 'on' });
  if (error) {
    logUnexpected('request_account_deletion', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  await supabase.auth.signOut();
  redirect('/?deleted=1');
}
