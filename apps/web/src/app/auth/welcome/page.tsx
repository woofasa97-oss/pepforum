import { redirect } from 'next/navigation';

import { OnboardingForm } from '@/components/auth/AuthForms';
import { pick } from '@/lib/i18n';
import { safeRedirectPath } from '@/lib/safe-redirect';
import { getLocale, getStanding, getT } from '@/server/context';
import { getTaxonomy } from '@/server/queries';

/** After a first social sign-in: choose a username and confirm age and terms. */
export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [t, locale, standing, taxonomy, params] = await Promise.all([getT(), getLocale(), getStanding(), getTaxonomy(), searchParams]);
  const next = safeRedirectPath(params.next);
  if (!standing) redirect(`/auth/sign-in?next=${encodeURIComponent('/auth/welcome')}`);
  if (!standing.needs_onboarding) redirect(next);

  return (
    <div className="card card-p">
      <h1 className="mb8" tabIndex={-1}>{t('auth.welcomeTitle')}</h1>
      <p className="small muted mb16">{t('auth.welcomeBody')}</p>
      <OnboardingForm
        labels={pick(t, ['auth.username', 'auth.usernameHint', 'auth.homeZone', 'auth.ageAck', 'auth.terms', 'auth.finishSetup'])}
        zones={taxonomy.zones.filter((z) => taxonomy.regions && z.id !== 'national').map((z) => ({ id: z.id, name: locale === 'fr' ? z.name_fr : z.name_en }))}
        next={next}
      />
    </div>
  );
}
