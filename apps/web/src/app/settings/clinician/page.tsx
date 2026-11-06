import { CLINICIAN_PROFESSIONS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ClinicianBadge } from '@/components/clinician/ClinicianBadge';
import { ClinicianForm } from '@/components/clinician/ClinicianForm';
import { Icon } from '@/components/ui/Icon';
import { canApplyForVerification } from '@/lib/clinician';
import { formatDate } from '@/lib/format';
import { type MessageKey, pick } from '@/lib/i18n';
import { withdrawClinicianAction } from '@/server/actions/features';
import { getLocale, getT, getViewer } from '@/server/context';
import { getMyClinicianVerification, getTaxonomy } from '@/server/queries';

export const metadata: Metadata = { title: 'Clinician verification', robots: { index: false } };

const FORM_LABEL_KEYS = [
  'clinician.profession', 'clinician.province', 'clinician.regulator', 'clinician.regulatorHint', 'clinician.registration', 'clinician.registrationHint',
  'clinician.statement', 'clinician.statementHint', 'clinician.submit',
  'media.document', 'media.documentHint', 'media.chooseDocument', 'media.viewDocument', 'media.remove', 'media.uploading',
  'media.err.tooLarge', 'media.err.type', 'media.err.denied', 'media.err.rateLimited', 'media.err.failed',
  ...CLINICIAN_PROFESSIONS.map((p) => `clinician.profession.${p}` as const),
] satisfies MessageKey[];

export default async function ClinicianSettingsPage() {
  const [t, locale, viewer, taxonomy] = await Promise.all([getT(), getLocale(), getViewer(), getTaxonomy()]);
  if (!viewer) redirect('/auth/sign-in?next=/settings/clinician');
  const mine = await getMyClinicianVerification();
  const latest = mine?.latest ?? null;
  const canSubmit = canApplyForVerification(latest);

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="xs faint mb8"><Link className="link" href="/settings">{t('settings.title')}</Link></p>
        <h1 className="mb8" tabIndex={-1}>{t('clinician.title')}</h1>
        <p className="muted mb16">{t('clinician.intro')}</p>
        <div className="banner mb16"><Icon name="info" /><div>{t('clinician.privacy')}</div></div>

        {latest ? (
          <section className="card card-p mb16" aria-labelledby="status-h">
            <h2 id="status-h" className="row mb8">{t('clinician.statusTitle')} <span className={`pill ${latest.status === 'approved' ? 'green' : latest.status === 'pending' ? 'amber' : ''}`}>{t(`clinician.status.${latest.status}` as MessageKey)}</span></h2>
            <p className="small">
              {t(`clinician.profession.${latest.profession}` as MessageKey)} · {latest.regulator} · {t('clinician.submittedOn', { date: formatDate(latest.submitted_at, locale) })}
            </p>
            {mine?.badge ? <p className="mt8"><ClinicianBadge profession={mine.badge} t={t} size="md" /></p> : null}
            {latest.status === 'approved' && latest.expires_at ? <p className="small muted mt8">{t('clinician.validUntil', { date: formatDate(latest.expires_at, locale) })}</p> : null}
            {latest.review_note && latest.status !== 'pending' ? <p className="small mt8"><b>{t('clinician.teamNote')}:</b> {latest.review_note}</p> : null}
            {latest.status === 'pending' ? (
              <form action={withdrawClinicianAction} className="mt12">
                <p className="small muted mb8">{t('clinician.pendingBody')}</p>
                <button type="submit" className="btn sm">{t('clinician.withdraw')}</button>
              </form>
            ) : null}
          </section>
        ) : null}

        {canSubmit ? (
          <section className="card card-p" aria-labelledby="form-h">
            <h2 id="form-h" className="mb8">{latest ? t('clinician.renew') : t('clinician.apply')}</h2>
            <p className="small muted mb12">{t('clinician.applyBody', { days: mine?.valid_days ?? 730 })}</p>
            <ClinicianForm labels={pick(t, FORM_LABEL_KEYS)}
              provinces={taxonomy.zones.filter((z) => z.id !== 'national').map((z) => ({ id: z.id, name: locale === 'fr' ? z.name_fr : z.name_en }))} />
          </section>
        ) : null}
      </main>
    </div>
  );
}
