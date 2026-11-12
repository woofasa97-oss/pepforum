import { SignUpForm } from '@/components/auth/AuthForms';
import { SocialSignIn } from '@/components/auth/SocialSignIn';
import { env } from '@/lib/env';
import { pick } from '@/lib/i18n';
import { getLocale, getNonce, getT } from '@/server/context';
import { getEnabledOAuthProviders } from '@/server/queries';

export default async function SignUpPage() {
  const [t, locale, nonce, providers] = await Promise.all([getT(), getLocale(), getNonce(), getEnabledOAuthProviders()]);
  return (
    <div className="card card-p">
      <h1 className="mb16" tabIndex={-1}>{t('auth.signUpTitle')}</h1>
      <SocialSignIn providers={providers} hint={t('auth.socialHint')} t={t} />
      <SignUpForm
        labels={pick(t, [
          'auth.email', 'auth.password', 'auth.passwordHint', 'auth.username', 'auth.usernameHint', 'auth.locale',
          'auth.ageAck', 'auth.terms', 'auth.submitSignUp', 'auth.haveAccount',
        ])}
        locale={locale}
        captcha={{ siteKey: env().TURNSTILE_SITE_KEY, nonce }}
      />
      <p className="xs faint mt16">{t('auth.trust')}</p>
    </div>
  );
}
