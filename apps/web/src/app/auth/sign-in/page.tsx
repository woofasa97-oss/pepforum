import { SignInForm, SignInLinkForm } from '@/components/auth/AuthForms';
import { SocialSignIn } from '@/components/auth/SocialSignIn';
import { env } from '@/lib/env';
import { pick } from '@/lib/i18n';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { getNonce, getT } from '@/server/context';
import { getEnabledOAuthProviders } from '@/server/queries';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const [t, nonce, providers, params] = await Promise.all([getT(), getNonce(), getEnabledOAuthProviders(), searchParams]);
  const next = safeRedirectPath(params.next);
  const captcha = { siteKey: env().TURNSTILE_SITE_KEY, nonce };
  return (
    <div className="card card-p">
      <h1 className="mb16" tabIndex={-1}>{t('auth.signInTitle')}</h1>
      {params.error === 'confirm' ? <div className="banner danger mb12" role="alert">{t('auth.confirmFailed')}</div> : null}
      {params.error === 'provider' ? <div className="banner danger mb12" role="alert">{t('auth.providerFailed')}</div> : null}
      <SocialSignIn providers={providers} next={next} t={t} />
      <SignInForm
        labels={pick(t, ['auth.email', 'auth.password', 'auth.forgot', 'auth.submitSignIn', 'auth.noAccount'])}
        next={next}
        captcha={captcha}
      />
      <details className="mt16">
        <summary className="link small" style={{ cursor: 'pointer' }}>{t('auth.useLink')}</summary>
        <div className="mt12">
          <SignInLinkForm labels={pick(t, ['auth.email', 'auth.sendLink'])} captcha={captcha} />
        </div>
      </details>
      <p className="xs faint mt16">{t('auth.trust')}</p>
    </div>
  );
}
