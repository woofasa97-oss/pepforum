import { STORE_AUDIT_CRITERIA, STORE_AUDIT_GROUPS, STORE_AUDIT_RESULTS, type StoreAuditCheck, type StoreAuditResult } from '@pepforum/database';
import Link from 'next/link';

import { GoLink } from '@/components/prices/PriceBits';
import { Icon } from '@/components/ui/Icon';
import { formatDay } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { brandOf, monogram, resultTone } from '@/lib/stores';

/** The Standard section each check comes from (docs/QUALITY_ASSURANCE.md). */
export const CHECK_SECTION: Record<string, string> = {
  identity_name: '9.1', identity_country: '9.1', identity_address: '9.1', ships_to: '9.1',
  coa_published: '4', coa_lab_named: '4', coa_lab_tier: '3', coa_verifiable: '4', coa_identity_ms: '5', coa_endotoxin: '5', coa_current: '9.2',
  independent_results: '9.3', no_human_use_claims: '9.6', lot_notice_process: '9.7',
};

const RESULT_ICON: Record<StoreAuditResult, 'check' | 'alert' | 'x' | 'search' | 'help'> = {
  met: 'check', partly: 'alert', not_met: 'x', not_found: 'search', unchecked: 'help',
};

export function ResultPill({ result, t }: { result: StoreAuditResult | undefined; t: Translate }) {
  if (!result) return <span className="pill xs">{t('stores.notAudited')}</span>;
  return <span className={`pill xs ${resultTone(result)}`.trim()}>{t(`stores.result.${result}` as MessageKey)}</span>;
}

/** The store's logo on its tile, or its initials. Decorative: the name is always beside it. */
export function BrandTile({ slug, name, size = 'card' }: { slug: string; name: string; size?: 'card' | 'hero' }) {
  const brand = brandOf(slug);
  if (brand) {
    return (
      <span className={`brand-tile ${size} bg-${brand.bg} ${brand.kind}`} aria-hidden="true">
        {/* A logo converted by stores:brand and served from our own origin (img-src 'self'). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={brand.src} alt="" width={brand.w} height={brand.h} loading="lazy" decoding="async" />
      </span>
    );
  }
  const m = monogram(name);
  return (
    <span className={`brand-tile ${size} mono`} aria-hidden="true" style={{ ['--hue' as string]: m.hue }}>
      <span>{m.initials}</span>
    </span>
  );
}

/** Fourteen segments, one per check, coloured by result: the audit at a glance. */
export function Scorecard({ results, t, compact = false }: { results: Partial<Record<string, StoreAuditResult>>; t: Translate; compact?: boolean }) {
  const met = STORE_AUDIT_CRITERIA.filter((c) => results[c] === 'met').length;
  return (
    <span className={`scorecard${compact ? ' compact' : ''}`}>
      <span className="sc-bar" role="img" aria-label={t('stores.metCount', { met, total: STORE_AUDIT_CRITERIA.length })}>
        {STORE_AUDIT_CRITERIA.map((c) => <span key={c} className={`sc-seg r-${results[c] ?? 'none'}`} title={`${t(`stores.check.${c}` as MessageKey)}: ${results[c] ? t(`stores.result.${results[c]}` as MessageKey) : '—'}`} />)}
      </span>
      <span className="sc-label">{t('stores.metShort', { met, total: STORE_AUDIT_CRITERIA.length })}</span>
    </span>
  );
}

/** One check, folded: its name and result; open it for what it checks and the store's own words. */
export function CheckRow({ c, criterion, t, locale, valueText }: {
  c: StoreAuditCheck | undefined; criterion: string; t: Translate; locale: string; valueText?: (criterion: string, value: string) => string;
}) {
  const result = c?.result;
  const evidence = c && (c.value || c.quote);
  return (
    <details className={`check-row r-${result ?? 'none'}`}>
      <summary>
        <span className={`cr-icon r-${result ?? 'none'}`} aria-hidden="true"><Icon name={result ? RESULT_ICON[result] : 'help'} /></span>
        <span className="cr-name">{t(`stores.check.${criterion}` as MessageKey)}</span>
        {c?.value ? <span className="cr-value muted">{valueText ? valueText(criterion, c.value) : c.value}</span> : null}
        <ResultPill result={result} t={t} />
        <Icon name="chevron" className="i chev" />
      </summary>
      <div className="cr-body">
        <p className="xs muted">{t(`stores.checkHelp.${criterion}` as MessageKey)} <span className="faint">§{CHECK_SECTION[criterion]}</span></p>
        {evidence && c?.quote ? <blockquote lang="und">“{c.quote}”</blockquote> : null}
        {c?.has_source ? (
          <p className="xs muted">
            <GoLink kind="evidence" id={c.id} label={t('stores.sourceLabel')}>{t('stores.source')}</GoLink>
            {c.quote ? ` · ${c.quote_verified_on ? t('stores.quoteVerified', { date: formatDay(c.quote_verified_on, locale) }) : t('stores.quoteUnverified')}` : ''}
          </p>
        ) : null}
      </div>
    </details>
  );
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

/** The fourteen checks, what each result means, and what an audit is not — folded away until asked for. */
export function HowWeAudit({ t, version }: { t: Translate; version: string }) {
  return (
    <details className="card card-p mb16 how-audit">
      <summary><Icon name="info" /><b>{t('stores.how.title')}</b><Icon name="chevron" className="i chev" /></summary>
      <p className="small mt12 mb12">{t('stores.how.body')}</p>
      <p className="small mb12"><b>{t('stores.how.notGrade', { version })}</b></p>
      <div className="how-grid">
        {(Object.keys(STORE_AUDIT_GROUPS) as Array<keyof typeof STORE_AUDIT_GROUPS>).map((group) => (
          <div key={group}>
            <h3 className="small mb4">{t(`stores.group.${group}` as MessageKey)}</h3>
            <ul className="how-list">
              {STORE_AUDIT_GROUPS[group].map((c) => (
                <li key={c}><b>{t(`stores.check.${c}` as MessageKey)}</b> <span className="faint xs">§{CHECK_SECTION[c]}</span><br /><span className="xs muted">{t(`stores.checkHelp.${c}` as MessageKey)}</span></li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <h3 className="small mt12 mb4">{t('stores.how.results')}</h3>
      <ul className="how-results">
        {STORE_AUDIT_RESULTS.map((r) => <li key={r}><ResultPill result={r} t={t} /> <span className="xs muted">{t(`stores.resultHelp.${r}` as MessageKey)}</span></li>)}
      </ul>
      <p className="xs faint mt12">{t('stores.how.disclaimer')}</p>
    </details>
  );
}
