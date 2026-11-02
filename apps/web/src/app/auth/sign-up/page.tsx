import { SignUpForm } from '@/components/auth/AuthForms';
import { env } from '@/lib/env';
import { pick } from '@/lib/i18n';
import { getLocale, getNonce, getT } from '@/server/context';
import { getTaxonomy } from '@/server/queries';

export default async function SignUpPage() {
  const [t, locale, nonce, taxonomy] = await Promise.all([getT(), getLocale(), getNonce(), getTaxonomy()]);
  return (
    <div className="card card-p">
      <h1 className="mb16" tabIndex={-1}>{t('auth.signUpTitle')}</h1>
      <SignUpForm
        labels={pick(t, [
          'auth.email', 'auth.password', 'auth.passwordHint', 'auth.username', 'auth.usernameHint', 'auth.homeZone', 'auth.locale',
          'auth.ageAck', 'auth.terms', 'auth.submitSignUp', 'auth.haveAccount',
        ])}
        zones={taxonomy.zones.filter((z) => z.id !== 'national').map((z) => ({ id: z.id, name: locale === 'fr' ? z.name_fr : z.name_en }))}
        locale={locale}
        captcha={{ siteKey: env().TURNSTILE_SITE_KEY, nonce }}
      />
      <p className="xs faint mt16">{t('auth.trust')}</p>
    </div>
  );
}
