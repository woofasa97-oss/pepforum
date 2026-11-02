import { redirect } from 'next/navigation';

import { MfaChallengeForm } from '@/components/auth/AuthForms';
import { pick } from '@/lib/i18n';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { getSupabase, getT, getViewer } from '@/server/context';

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [t, viewer, params] = await Promise.all([getT(), getViewer(), searchParams]);
  if (!viewer) redirect('/auth/sign-in');
  const next = safeRedirectPath(params.next);
  if (viewer.aal === 'aal2') redirect(next);

  const supabase = await getSupabase();
  const { data } = await supabase.auth.mfa.listFactors();
  const factor = (data?.totp ?? []).find((f) => f.status === 'verified');
  if (!factor) redirect(next);

  return (
    <div className="card card-p">
      <h1 className="mb8" tabIndex={-1}>{t('auth.mfaTitle')}</h1>
      <p className="small muted mb16">{t('auth.mfaSub')}</p>
      <MfaChallengeForm labels={pick(t, ['auth.mfaCode', 'auth.mfaVerify'])} factorId={factor.id} next={next} />
    </div>
  );
}
