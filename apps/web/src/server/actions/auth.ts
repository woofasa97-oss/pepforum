'use server';

/**
 * Account flows. Security notes:
 *   * Generic messages on sign-in and reset: no account enumeration.
 *   * CAPTCHA token (Turnstile) is forwarded to Supabase Auth, which verifies
 *     it when CAPTCHA protection is enabled in the project.
 *   * After password sign-in, members with a TOTP factor are sent to the MFA
 *     step; moderator powers require the resulting aal2 session (enforced in
 *     the database, not here).
 *   * `next` redirects are restricted to same-site paths.
 *   * Sign-in links (magic links) never create accounts: new members go through
 *     the sign-up form or social onboarding, which collect username and age.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/lib/action-state';
import { env } from '@/lib/env';
import { logUnexpected, messageForDbError } from '@/lib/errors';
import { safeRedirectPath } from '@/lib/safe-redirect';
import {
  EmailOnlySchema,
  MfaCodeSchema,
  NewPasswordSchema,
  OnboardingSchema,
  SignInSchema,
  SignUpSchema,
  fieldErrors,
  formToObject,
} from '@/lib/validation';
import { getSupabase, getT, getViewer } from '@/server/context';

const captchaToken = (form: FormData): string | undefined => {
  const token = form.get('cf-turnstile-response');
  return typeof token === 'string' && token.length > 0 ? token : undefined;
};

export async function signUpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = SignUpSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };
  const input = parsed.data;
  const supabase = await getSupabase();

  const { data: available } = await supabase.rpc('username_available', { p_username: input.username });
  if (!available) return { ok: false, fieldErrors: { username: t('auth.usernameTaken') } };

  const { error } = await supabase.auth.signUp({
    email: input.email,
    password: input.password,
    options: {
      emailRedirectTo: `${env().SITE_URL}/auth/confirm`,
      captchaToken: captchaToken(form),
      // Read (and re-validated) by the sign-up trigger; never used for privileges.
      data: { username: input.username, locale: input.locale, home_zone: input.homeZone || undefined },
    },
  });
  if (error) {
    // Weak/leaked password is the only error worth surfacing specifically.
    if (error.code === 'weak_password') return { ok: false, fieldErrors: { password: error.message } };
    return { ok: false, message: t('errors.unexpected') };
  }
  // Same response whether or not the email already had an account.
  return { ok: true, message: t('auth.checkEmail') };
}

export async function signInAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = SignInSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('auth.invalidCredentials') };
  const supabase = await getSupabase();

  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { captchaToken: captchaToken(form) },
  });
  if (error) {
    return { ok: false, message: error.code === 'email_not_confirmed' ? t('auth.emailNotConfirmed') : t('auth.invalidCredentials') };
  }

  const next = safeRedirectPath(parsed.data.next);
  revalidatePath('/', 'layout'); // header shows the signed-in member
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
    redirect(`/auth/mfa?next=${encodeURIComponent(next)}`);
  }
  redirect(next);
}

export async function sendSignInLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = EmailOnlySchema.safeParse(formToObject(form));
  if (parsed.success) {
    const supabase = await getSupabase();
    await supabase.auth.signInWithOtp({
      email: parsed.data.email,
      options: { shouldCreateUser: false, emailRedirectTo: `${env().SITE_URL}/auth/confirm`, captchaToken: captchaToken(form) },
    });
  }
  // Identical response for unknown emails.
  return { ok: true, message: t('auth.linkSent') };
}

const USERNAME_ERRORS = new Set(['username_taken', 'invalid_username', 'reserved_username']);

export async function completeOnboardingAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = OnboardingSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('errors.invalid'), fieldErrors: fieldErrors(parsed.error) };
  const input = parsed.data;
  const supabase = await getSupabase();

  const { error } = await supabase.rpc('complete_onboarding', {
    p_username: input.username,
    p_home_zone: input.homeZone || null,
    p_adult: true, // OnboardingSchema requires the checkbox
  });
  if (error && USERNAME_ERRORS.has(error.message)) return { ok: false, fieldErrors: { username: t('auth.usernameTaken') } };
  if (error && error.message !== 'already_onboarded') {
    logUnexpected('complete_onboarding', error);
    return { ok: false, message: messageForDbError(error, t) };
  }
  revalidatePath('/', 'layout'); // header drops the "finish setting up" banner
  redirect(safeRedirectPath(input.next));
}

export async function forgotPasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  const parsed = EmailOnlySchema.safeParse(formToObject(form));
  if (parsed.success) {
    const supabase = await getSupabase();
    await supabase.auth.resetPasswordForEmail(parsed.data.email, {
      redirectTo: `${env().SITE_URL}/auth/confirm?next=/auth/update-password`,
      captchaToken: captchaToken(form),
    });
  }
  // Identical response for unknown emails.
  return { ok: true, message: t('auth.resetSent') };
}

export async function updatePasswordAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = NewPasswordSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, fieldErrors: fieldErrors(parsed.error) };
  const supabase = await getSupabase();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return { ok: false, message: error.code === 'weak_password' ? error.message : t('errors.unexpected') };
  return { ok: true, message: t('auth.passwordUpdated') };
}

export async function verifyMfaAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const t = await getT();
  if (!(await getViewer())) return { ok: false, message: t('errors.signInRequired') };
  const parsed = MfaCodeSchema.safeParse(formToObject(form));
  if (!parsed.success) return { ok: false, message: t('auth.mfaInvalid') };
  const supabase = await getSupabase();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: parsed.data.factorId, code: parsed.data.code });
  if (error) return { ok: false, message: t('auth.mfaInvalid') };
  revalidatePath('/', 'layout');
  redirect(safeRedirectPath(parsed.data.next));
}

export interface MfaEnrollment {
  readonly factorId: string;
  readonly qrCode: string;
  readonly secret: string;
}

export async function startMfaEnrollmentAction(): Promise<MfaEnrollment | { error: string }> {
  const t = await getT();
  if (!(await getViewer())) return { error: t('errors.signInRequired') };
  const supabase = await getSupabase();

  // Discard unfinished enrolments so they don't accumulate.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const factor of factors?.all ?? []) {
    if (factor.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Pepforum ${Date.now()}` });
  if (error || !data) return { error: t('errors.unexpected') };
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

export async function signOutAction(): Promise<void> {
  const supabase = await getSupabase();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/');
}
