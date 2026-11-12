import { CLINICIAN_FILTERS, type ClinicianFilter } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState, TierBadge } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { countryName } from '@/lib/countries';
import { reviewClinicianAction, revokeClinicianAction } from '@/server/actions/admin';
import { adminClinicians } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Clinicians' };

/** Clinician verification queue (…024): approve or reject with a reason; revoke later. */
export default async function AdminCliniciansPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const [t, locale, params] = await Promise.all([getT(), getLocale(), searchParams]);
  const filter: ClinicianFilter = CLINICIAN_FILTERS.find((f) => f === params.filter) ?? 'pending';
  const result = await adminClinicians({ p_filter: filter });
  const header = <PageHeader title={t('admin.clin.title')} sub={t('admin.clin.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const { rows, counts } = result.data;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };

  return (
    <>
      {header}
      <div className="banner mb16"><Icon name="info" /><div>{t('admin.clin.checklist')}</div></div>
      <nav className="tabs" aria-label={t('admin.clin.tabs')}>
        {CLINICIAN_FILTERS.map((f) => (
          <Link key={f} href={f === 'pending' ? '/admin/clinicians' : `/admin/clinicians?filter=${f}`} aria-current={f === filter ? 'page' : undefined}>
            {t(`admin.clin.filter.${f}` as MessageKey)} ({counts[f]})
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? <div className="card"><EmptyState title={t('admin.clin.none')} /></div> : (
        <ul className="link-queue">
          {rows.map((v) => (
            <li key={v.id} className="card card-p">
              <div className="row between wrap mb8" style={{ gap: 8 }}>
                <span className="row wrap" style={{ gap: 6 }}>
                  <Link className="link bold" href={`/admin/people/${encodeURIComponent(v.member)}`}>u/{v.member}</Link>
                  <TierBadge tier={v.member_tier} t={t} />
                  <span className="pill">{t(`clinician.profession.${v.profession}` as MessageKey)}</span>
                  <span className={`pill ${v.status === 'approved' ? 'green' : v.status === 'pending' ? 'amber' : ''}`}>{t(`clinician.status.${v.status}` as MessageKey)}</span>
                  {v.previous > 0 ? <span className="xs muted">{t('admin.clin.previous', { n: v.previous })}</span> : null}
                </span>
                <span className="xs muted">{t('admin.links.waitingSince', { time: relativeTime(v.submitted_at, t) })}</span>
              </div>
              <dl className="facts">
                <div><dt>{t('clinician.regulator')}</dt><dd>{v.regulator} · {countryName(v.country, locale)}</dd></div>
                <div><dt>{t('clinician.registration')}</dt><dd><code>{v.registration_number}</code></dd></div>
                <div><dt>{t('media.document')}</dt><dd>{v.document_id ? <a className="link" href={`/media/${v.document_id}`} target="_blank" rel="noopener noreferrer">{t('media.viewDocument')}</a> : '—'}</dd></div>
                <div><dt>{t('admin.inbox.joined')}</dt><dd>{formatDate(v.joined, locale)}</dd></div>
                {v.expires_at ? <div><dt>{t('admin.clin.expires')}</dt><dd>{formatDate(v.expires_at, locale)}</dd></div> : null}
                {v.reviewed_by ? <div><dt>{t('admin.clin.reviewedBy')}</dt><dd>u/{v.reviewed_by} · {v.review_note}</dd></div> : null}
              </dl>
              {v.statement ? <p className="small mt8" style={{ overflowWrap: 'anywhere' }}>“{v.statement}”</p> : null}
              <div className="row wrap mt12" style={{ gap: 8 }}>
                {v.status === 'pending' ? (
                  <>
                    <ActionForm action={reviewClinicianAction} label={t('admin.clin.approve')} submit={t('admin.clin.approve')} tone="primary"
                      consequence={t('admin.clin.approveConsequence')} hidden={{ id: v.id, decision: 'approve' }}
                      reasons={[t('admin.clin.reason.registerMatch')]} labels={labels} />
                    <ActionForm action={reviewClinicianAction} label={t('admin.clin.reject')} submit={t('admin.clin.reject')} tone="danger"
                      consequence={t('admin.clin.rejectConsequence')} hidden={{ id: v.id, decision: 'reject' }}
                      reasons={[t('admin.clin.reason.notFound'), t('admin.clin.reason.unreadable'), t('admin.clin.reason.mismatch')]} labels={labels} />
                  </>
                ) : null}
                {v.status === 'approved' ? (
                  <ActionForm action={revokeClinicianAction} label={t('admin.clin.revoke')} submit={t('admin.clin.revoke')} tone="danger"
                    consequence={t('admin.clin.revokeConsequence')} hidden={{ userId: v.user_id }} labels={labels} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
