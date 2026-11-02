import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { DeleteAccountForm, MfaSetup, ProfileForm } from '@/components/settings/SettingsForms';
import { Icon } from '@/components/ui/Icon';
import { pick } from '@/lib/i18n';
import { getLocale, getSupabase, getT, getViewer } from '@/server/context';
import { getTaxonomy } from '@/server/queries';

export const metadata: Metadata = { title: 'Settings', robots: { index: false } };

export default async function SettingsPage() {
  const [t, locale, viewer, taxonomy] = await Promise.all([getT(), getLocale(), getViewer(), getTaxonomy()]);
  if (!viewer) redirect('/auth/sign-in?next=/settings');

  const supabase = await getSupabase();
  const [{ data: profile }, { data: factors }] = await Promise.all([
    supabase.from('profiles').select('bio, coi, locale, home_zone_id').eq('id', viewer.id).single(),
    supabase.auth.mfa.listFactors(),
  ]);
  const mfaEnabled = (factors?.totp ?? []).some((f) => f.status === 'verified');

  return (
    <div className="page">
      <main id="main" className="narrow">
        <h1 className="mb16" tabIndex={-1}>{t('settings.title')}</h1>

        <section className="card card-p mb16" aria-labelledby="profile-h">
          <h2 id="profile-h" className="mb12">{t('settings.profile')}</h2>
          <ProfileForm
            labels={pick(t, ['settings.bio', 'settings.coi', 'settings.coiHint', 'settings.save', 'auth.homeZone', 'auth.locale'])}
            defaults={{ bio: profile?.bio ?? '', coi: profile?.coi ?? '', locale: profile?.locale ?? locale, homeZone: profile?.home_zone_id ?? '' }}
            zones={taxonomy.zones.filter((z) => z.id !== 'national').map((z) => ({ id: z.id, name: locale === 'fr' ? z.name_fr : z.name_en }))}
          />
        </section>

        <section className="card card-p mb16" aria-labelledby="security-h">
          <h2 id="security-h" className="mb8">{t('settings.security')}</h2>
          <p className="small muted mb12">{t('settings.mfa')}</p>
          {mfaEnabled ? (
            <div className="banner ok"><Icon name="check" /><div>{t('settings.mfaEnabled')}</div></div>
          ) : (
            <MfaSetup labels={pick(t, ['settings.mfaEnroll', 'settings.mfaScan', 'settings.mfaSecret', 'auth.mfaCode', 'auth.mfaVerify'])} />
          )}
        </section>

        <section className="card card-p" aria-labelledby="privacy-h">
          <h2 id="privacy-h" className="mb8">{t('settings.privacy')}</h2>
          <p className="small muted mb12">{t('settings.privacyBody')}</p>
          <a className="btn mb16" href="/api/export" download>{t('settings.export')}</a>
          <details className="mt16">
            <summary className="bold" style={{ cursor: 'pointer', color: 'var(--accent)' }}>{t('settings.delete')}</summary>
            <div className="mt12">
              <DeleteAccountForm labels={pick(t, ['settings.deleteBody', 'settings.deleteErase', 'settings.deleteConfirm', 'settings.deleteSubmit'])} />
            </div>
          </details>
        </section>
      </main>
    </div>
  );
}
