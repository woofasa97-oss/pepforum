import { STORE_AUDIT_GROUPS, STORE_AUDIT_RESULTS, type StoreAuditResult } from '@pepforum/database';
import Link from 'next/link';

import { Icon } from '@/components/ui/Icon';
import type { MessageKey, Translate } from '@/lib/i18n';
import { resultTone } from '@/lib/stores';

/** The Standard section each check comes from (docs/QUALITY_ASSURANCE.md). */
export const CHECK_SECTION: Record<string, string> = {
  identity_name: '9.1', identity_country: '9.1', identity_address: '9.1', ships_to: '9.1',
  coa_published: '4', coa_lab_named: '4', coa_lab_tier: '3', coa_verifiable: '4', coa_identity_ms: '5', coa_endotoxin: '5', coa_current: '9.2',
  independent_results: '9.3', no_human_use_claims: '9.6', lot_notice_process: '9.7',
};

export function ResultPill({ result, t }: { result: StoreAuditResult | undefined; t: Translate }) {
  if (!result) return <span className="pill xs">{t('stores.notAudited')}</span>;
  return <span className={`pill xs ${resultTone(result)}`.trim()}>{t(`stores.result.${result}` as MessageKey)}</span>;
}

/** Shown in place of a store page while the directory is off for this viewer. */
export function StoresOff({ t }: { t: Translate }) {
  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="card empty">
          <b>{t('stores.off.title')}</b>
          <p>{t('stores.off.body')}</p>
          <Link className="btn dark mt16" href="/">{t('notFound.back')}</Link>
        </div>
      </main>
    </div>
  );
}

/** Admins see the directory while it is off; say so on every page of it. */
export function PreviewBanner({ t }: { t: Translate }) {
  return (
    <div className="banner warn mb16" role="status">
      <Icon name="alert" />
      <span>{t('stores.preview')}</span>
    </div>
  );
}

/** The fourteen checks, what each result means, and what an audit is not. */
export function HowWeAudit({ t, version }: { t: Translate; version: string }) {
  return (
    <section className="card card-p mb16" aria-labelledby="how-h">
      <h2 id="how-h" className="mb8" style={{ fontSize: 16 }}>{t('stores.how.title')}</h2>
      <p className="small mb12">{t('stores.how.body')}</p>
      <p className="small mb12"><b>{t('stores.how.notGrade', { version })}</b></p>
      {(Object.keys(STORE_AUDIT_GROUPS) as Array<keyof typeof STORE_AUDIT_GROUPS>).map((group) => (
        <div key={group} className="mb12">
          <h3 className="small mb4">{t(`stores.group.${group}` as MessageKey)}</h3>
          <dl className="facts">
            {STORE_AUDIT_GROUPS[group].map((c) => (
              <div key={c}>
                <dt>{t(`stores.check.${c}` as MessageKey)} <span className="faint xs">§{CHECK_SECTION[c]}</span></dt>
                <dd className="small">{t(`stores.checkHelp.${c}` as MessageKey)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <h3 className="small mb4">{t('stores.how.results')}</h3>
      <dl className="facts mb12">
        {STORE_AUDIT_RESULTS.map((r) => (
          <div key={r}>
            <dt><ResultPill result={r} t={t} /></dt>
            <dd className="small">{t(`stores.resultHelp.${r}` as MessageKey)}</dd>
          </div>
        ))}
      </dl>
      <p className="xs faint">{t('stores.how.disclaimer')}</p>
    </section>
  );
}
