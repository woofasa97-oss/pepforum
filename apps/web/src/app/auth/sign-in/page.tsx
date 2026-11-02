import { SignInForm } from '@/components/auth/AuthForms';
import { env } from '@/lib/env';
import { pick } from '@/lib/i18n';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { getNonce, getT } from '@/server/context';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const [t, nonce, params] = await Promise.all([getT(), getNonce(), searchParams]);
  return (
    <div className="card card-p">
      <h1 className="mb16" tabIndex={-1}>{t('auth.signInTitle')}</h1>
      {params.error === 'confirm' ? <div className="banner danger mb12" role="alert">{t('auth.confirmFailed')}</div> : null}
      <SignInForm
        labels={pick(t, ['auth.email', 'auth.password', 'auth.forgot', 'auth.submitSignIn', 'auth.noAccount'])}
        next={safeRedirectPath(params.next)}
        captcha={{ siteKey: env().TURNSTILE_SITE_KEY, nonce }}
      />
      <p className="xs faint mt16">{t('auth.trust')}</p>
    </div>
  );
}
