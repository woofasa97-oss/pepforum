import { SOCIAL_PLATFORMS } from '@pepforum/database';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import Link from 'next/link';

import { DeleteAccountForm, MfaSetup, ProfileForm } from '@/components/settings/SettingsForms';
import { Avatar } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { Icon } from '@/components/ui/Icon';
import { hasPassword } from '@/lib/auth-providers';
import { compactNumber, formatDate } from '@/lib/format';
import { type MessageKey, pick } from '@/lib/i18n';
import { PLATFORM_NAMES, audienceKey, displayHandle } from '@/lib/social-names';
import { configuredPlatforms } from '@/lib/socials';
import { unlinkSocialAction } from '@/server/actions/social';
import { getLocale, getStanding, getSupabase, getT, getViewer } from '@/server/context';
import { getMySocialAccounts, getSocialBonusRules } from '@/server/queries';

export const metadata: Metadata = { title: 'Settings', robots: { index: false } };

const PICTURE_RESULTS = ['saved', 'removed', 'invalid', 'too_large', 'unsupported', 'rate_limited', 'not_allowed', 'failed'] as const;
const SOCIAL_RESULTS = ['linked', 'removed', 'cancelled', 'failed', 'taken', 'no_channel', 'rate_limited', 'unavailable'] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ avatar?: string; social?: string }> }) {
  const [t, locale, viewer, standing, query, socials, rules] = await Promise.all([
    getT(), getLocale(), getViewer(), getStanding(), searchParams, getMySocialAccounts(), getSocialBonusRules(),
  ]);
  if (!viewer) redirect('/auth/sign-in?next=/settings');
  const pictureResult = PICTURE_RESULTS.find((r) => r === query.avatar);
  const socialResult = SOCIAL_RESULTS.find((r) => r === query.social);
  const verifiable = configuredPlatforms();

  const supabase = await getSupabase();
  const [{ data: profile }, { data: factors }, { data: account }] = await Promise.all([
    supabase.from('profiles').select('bio, coi, locale').eq('id', viewer.id).single(),
    supabase.auth.mfa.listFactors(),
    supabase.auth.getUser(),
  ]);
  const mfaEnabled = (factors?.totp ?? []).some((f) => f.status === 'verified');

  return (
    <div className="page">
      <main id="main" className="narrow">
        <h1 className="mb16" tabIndex={-1}>{t('settings.title')}</h1>

        <section className="card card-p mb16" aria-labelledby="picture-h" id="picture">
          <h2 id="picture-h" className="mb12">{t('settings.picture')}</h2>
          {pictureResult ? (
            <div className={`banner ${pictureResult === 'saved' || pictureResult === 'removed' ? 'ok' : 'danger'} mb12`} role="status">
              {t(`settings.picture.${pictureResult}` as MessageKey)}
            </div>
          ) : null}
          <div className="row wrap" style={{ gap: 16, alignItems: 'center' }}>
            <Avatar name={standing?.username ?? '?'} size="lg" src={standing?.avatar ?? null} />
            {/* A plain form post: works without JavaScript; the server re-encodes the picture and strips its metadata. */}
            <form action="/api/avatar" method="post" encType="multipart/form-data" className="row wrap" style={{ gap: 8 }}>
              <label htmlFor="avatar-file" className="vh">{t('settings.pictureChoose')}</label>
              <input id="avatar-file" name="file" type="file" accept="image/jpeg,image/png,image/webp" required className="input" style={{ maxWidth: 300 }} />
              <button type="submit" className="btn dark sm">{t('settings.pictureUpload')}</button>
            </form>
            {standing?.avatar ? (
              <form action="/api/avatar" method="post">
                <input type="hidden" name="action" value="remove" />
                <button type="submit" className="btn sm">{t('settings.pictureRemove')}</button>
              </form>
            ) : null}
          </div>
          <p className="xs faint mt8">{t('settings.pictureHint')}</p>
        </section>

        <section className="card card-p mb16" aria-labelledby="socials-h" id="socials">
          <h2 id="socials-h" className="mb8">{t('socials.title')}</h2>
          <p className="small muted mb12">
            {t('socials.intro', { min: rules.min.toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA'), max: rules.max })}
          </p>
          {socialResult ? (
            <div className={`banner ${socialResult === 'linked' || socialResult === 'removed' ? 'ok' : 'danger'} mb12`} role="status">
              {t(`socials.result.${socialResult}` as MessageKey)}
            </div>
          ) : null}
          <ul className="site-list">
            {SOCIAL_PLATFORMS.map((platform) => {
              const account = socials?.accounts.find((a) => a.platform === platform);
              return (
                <li key={platform}>
                  <span className="row wrap" style={{ gap: 8 }}>
                    <b>{PLATFORM_NAMES[platform]}</b>
                    {account ? (
                      <>
                        <a className="link" href={account.url} rel="nofollow ugc noopener noreferrer">{displayHandle(platform, account.handle)}</a>
                        <span className="xs muted">{t(audienceKey(platform), { n: compactNumber(account.audience, locale) })}</span>
                        <span className="pill green">{t('socials.verifiedOn', { date: formatDate(account.verified_at, locale) })}</span>
                      </>
                    ) : null}
                  </span>
                  {account ? (
                    <form action={unlinkSocialAction}>
                      <input type="hidden" name="platform" value={platform} />
                      <SubmitButton className="btn sm">{t('socials.remove')}</SubmitButton>
                    </form>
                  ) : verifiable.includes(platform) ? (
                    <a className="btn sm dark" href={`/social/${platform}/start`}>{t('socials.verify')}</a>
                  ) : (
                    <span className="xs faint">{t('socials.soon')}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {socials && socials.bonus > 0 ? <p className="small mt8"><b>{t('socials.bonusNow', { n: socials.bonus })}</b></p> : null}
          <p className="xs faint mt8">{t('socials.privacy')}</p>
        </section>

        <section className="card card-p mb16" aria-labelledby="profile-h">
          <h2 id="profile-h" className="mb12">{t('settings.profile')}</h2>
          <ProfileForm
            labels={pick(t, ['settings.bio', 'settings.coi', 'settings.coiHint', 'settings.save', 'auth.locale'])}
            defaults={{ bio: profile?.bio ?? '', coi: profile?.coi ?? '', locale: profile?.locale ?? locale }}
          />
        </section>

        <section className="card card-p mb16" aria-labelledby="more-h">
          <h2 id="more-h" className="mb8">{t('settings.more')}</h2>
          {/* Title with its hint underneath, so it reads cleanly on a phone. */}
          <ul className="sidelist more-links">
            <li><Link href="/settings/notifications"><span>{t('notifications.settings')}</span><span className="xs muted">{t('settings.notificationsHint')}</span></Link></li>
            <li><Link href="/settings/clinician"><span>{t('clinician.title')}</span><span className="xs muted">{t('settings.clinicianHint')}</span></Link></li>
            <li><Link href="/advertiser"><span>{t('ads.workspace')}</span><span className="xs muted">{t('settings.advertiserHint')}</span></Link></li>
          </ul>
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
              <DeleteAccountForm
                labels={pick(t, ['settings.deleteBody', 'settings.deleteErase', 'settings.deleteConfirm', 'settings.deleteSubmit', 'settings.deleteSocial', 'settings.deleteSocialConfirm', 'settings.deleteReauthLink'])}
                hasPassword={hasPassword(account.user?.identities)}
              />
            </div>
          </details>
        </section>
      </main>
    </div>
  );
}
