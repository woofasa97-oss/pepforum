import { ForgotForm } from '@/components/auth/AuthForms';
import { env } from '@/lib/env';
import { pick } from '@/lib/i18n';
import { getNonce, getT } from '@/server/context';

export default async function ForgotPasswordPage() {
  const [t, nonce] = await Promise.all([getT(), getNonce()]);
  return (
    <div className="card card-p">
      <h1 className="mb16" tabIndex={-1}>{t('auth.resetTitle')}</h1>
      <ForgotForm labels={pick(t, ['auth.email', 'auth.sendReset'])} captcha={{ siteKey: env().TURNSTILE_SITE_KEY, nonce }} />
    </div>
  );
}
