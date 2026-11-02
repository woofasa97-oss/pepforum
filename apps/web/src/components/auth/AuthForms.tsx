'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import {
  completeOnboardingAction,
  forgotPasswordAction,
  sendSignInLinkAction,
  signInAction,
  signUpAction,
  updatePasswordAction,
  verifyMfaAction,
} from '@/server/actions/auth';

import { Turnstile } from './Turnstile';

type Labels = Record<string, string>;
interface Captcha {
  readonly siteKey: string | undefined;
  readonly nonce: string | undefined;
}

export function SignInForm({ labels, next, captcha }: { labels: Labels; next: string; captcha: Captcha }) {
  const [state, action] = useActionState(signInAction, initialActionState);
  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="si-email">{labels['auth.email']}</label>
        <input id="si-email" name="email" type="email" className="input" autoComplete="email" required />
      </div>
      <div className="field">
        <label htmlFor="si-pw">{labels['auth.password']}</label>
        <input id="si-pw" name="password" type="password" className="input" autoComplete="current-password" required />
        <span className="hint"><Link className="link" href="/auth/forgot">{labels['auth.forgot']}</Link></span>
      </div>
      <Turnstile {...captcha} />
      <SubmitButton className="btn dark block">{labels['auth.submitSignIn']}</SubmitButton>
      <p className="small muted mt12"><Link className="link" href="/auth/sign-up">{labels['auth.noAccount']}</Link></p>
    </form>
  );
}

export function SignUpForm({ labels, zones, locale, captcha }: { labels: Labels; zones: Array<{ id: string; name: string }>; locale: 'en' | 'fr'; captcha: Captcha }) {
  const [state, action] = useActionState(signUpAction, initialActionState);
  if (state.ok) return <FormMessage ok message={state.message} />;
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action}>
      <FormMessage ok={false} message={state.message} />
      <div className="field">
        <label htmlFor="su-email">{labels['auth.email']}</label>
        <input id="su-email" name="email" type="email" className="input" autoComplete="email" required aria-invalid={Boolean(errors.email)} />
        <FieldError message={errors.email} />
      </div>
      <div className="field">
        <label htmlFor="su-pw">{labels['auth.password']}</label>
        <input id="su-pw" name="password" type="password" className="input" autoComplete="new-password" minLength={12} maxLength={128} required
          aria-invalid={Boolean(errors.password)} aria-describedby="su-pw-hint" />
        <span id="su-pw-hint" className="hint">{labels['auth.passwordHint']}</span>
        <FieldError message={errors.password} />
      </div>
      <div className="field">
        <label htmlFor="su-user">{labels['auth.username']}</label>
        <input id="su-user" name="username" className="input" autoComplete="username" pattern="[A-Za-z0-9_]{3,20}" required
          aria-invalid={Boolean(errors.username)} aria-describedby="su-user-hint" />
        <span id="su-user-hint" className="hint">{labels['auth.usernameHint']}</span>
        <FieldError message={errors.username} />
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="field grow">
          <label htmlFor="su-zone">{labels['auth.homeZone']}</label>
          <select id="su-zone" name="homeZone" className="input" defaultValue="">
            <option value="">—</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="su-locale">{labels['auth.locale']}</label>
          <select id="su-locale" name="locale" className="input" defaultValue={locale}>
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </div>
      </div>
      <label className="check mb12"><input type="checkbox" name="ageAck" required /><span>{labels['auth.ageAck']}</span></label>
      <label className="check mb16">
        <input type="checkbox" name="terms" required />
        <span>{labels['auth.terms']} <Link className="link" href="/legal/terms">↗</Link></span>
      </label>
      <Turnstile {...captcha} />
      <SubmitButton className="btn dark block">{labels['auth.submitSignUp']}</SubmitButton>
      <p className="small muted mt12"><Link className="link" href="/auth/sign-in">{labels['auth.haveAccount']}</Link></p>
    </form>
  );
}

/** Passwordless sign-in for existing accounts (it never creates one). */
export function SignInLinkForm({ labels, captcha }: { labels: Labels; captcha: Captcha }) {
  const [state, action] = useActionState(sendSignInLinkAction, initialActionState);
  if (state.ok) return <FormMessage ok message={state.message} />;
  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="link-email">{labels['auth.email']}</label>
        <input id="link-email" name="email" type="email" className="input" autoComplete="email" required />
      </div>
      <Turnstile {...captcha} />
      <SubmitButton className="btn block">{labels['auth.sendLink']}</SubmitButton>
    </form>
  );
}

/** First social sign-in: what the identity provider can't tell us. */
export function OnboardingForm({ labels, zones, next }: { labels: Labels; zones: Array<{ id: string; name: string }>; next: string }) {
  const [state, action] = useActionState(completeOnboardingAction, initialActionState);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action}>
      <FormMessage ok={false} message={state.message} />
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="ob-user">{labels['auth.username']}</label>
        <input id="ob-user" name="username" className="input" autoComplete="username" pattern="[A-Za-z0-9_]{3,20}" required
          aria-invalid={Boolean(errors.username)} aria-describedby="ob-user-hint" />
        <span id="ob-user-hint" className="hint">{labels['auth.usernameHint']}</span>
        <FieldError message={errors.username} />
      </div>
      <div className="field">
        <label htmlFor="ob-zone">{labels['auth.homeZone']}</label>
        <select id="ob-zone" name="homeZone" className="input" defaultValue="">
          <option value="">—</option>
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
      </div>
      <label className="check mb12"><input type="checkbox" name="ageAck" required /><span>{labels['auth.ageAck']}</span></label>
      <label className="check mb16">
        <input type="checkbox" name="terms" required />
        <span>{labels['auth.terms']} <Link className="link" href="/legal/terms">↗</Link></span>
      </label>
      <SubmitButton className="btn dark block">{labels['auth.finishSetup']}</SubmitButton>
    </form>
  );
}

export function ForgotForm({ labels, captcha }: { labels: Labels; captcha: Captcha }) {
  const [state, action] = useActionState(forgotPasswordAction, initialActionState);
  if (state.ok) return <FormMessage ok message={state.message} />;
  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="fp-email">{labels['auth.email']}</label>
        <input id="fp-email" name="email" type="email" className="input" autoComplete="email" required />
      </div>
      <Turnstile {...captcha} />
      <SubmitButton className="btn dark block">{labels['auth.sendReset']}</SubmitButton>
    </form>
  );
}

export function UpdatePasswordForm({ labels }: { labels: Labels }) {
  const [state, action] = useActionState(updatePasswordAction, initialActionState);
  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      <div className="field">
        <label htmlFor="up-pw">{labels['auth.newPassword']}</label>
        <input id="up-pw" name="password" type="password" className="input" autoComplete="new-password" minLength={12} maxLength={128} required
          aria-invalid={Boolean(state.fieldErrors?.password)} />
        <span className="hint">{labels['auth.passwordHint']}</span>
        <FieldError message={state.fieldErrors?.password} />
      </div>
      <SubmitButton className="btn dark block">{labels['auth.updatePassword']}</SubmitButton>
    </form>
  );
}

export function MfaChallengeForm({ labels, factorId, next }: { labels: Labels; factorId: string; next: string }) {
  const [state, action] = useActionState(verifyMfaAction, initialActionState);
  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      <input type="hidden" name="factorId" value={factorId} />
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="mfa-code">{labels['auth.mfaCode']}</label>
        <input id="mfa-code" name="code" className="input" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus />
      </div>
      <SubmitButton className="btn dark block">{labels['auth.mfaVerify']}</SubmitButton>
    </form>
  );
}
