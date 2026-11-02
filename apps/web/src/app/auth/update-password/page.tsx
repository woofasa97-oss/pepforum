import { redirect } from 'next/navigation';

import { UpdatePasswordForm } from '@/components/auth/AuthForms';
import { pick } from '@/lib/i18n';
import { getT, getViewer } from '@/server/context';

/** Reached from the password-reset email (via /auth/confirm, which establishes the session). */
export default async function UpdatePasswordPage() {
  const [t, viewer] = await Promise.all([getT(), getViewer()]);
  if (!viewer) redirect('/auth/sign-in?error=confirm');
  return (
    <div className="card card-p">
      <h1 className="mb16" tabIndex={-1}>{t('auth.updatePassword')}</h1>
      <UpdatePasswordForm labels={pick(t, ['auth.newPassword', 'auth.passwordHint', 'auth.updatePassword'])} />
    </div>
  );
}
