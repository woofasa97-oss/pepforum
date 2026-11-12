import type { PriceCoa, PriceCompound, PriceHistoryPoint, PriceVendor } from '@pepforum/database';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { type SeriesPoint, Sparkline } from '@/components/admin/Charts';
import { formatDay } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { type CadRate, formatCad, toCad } from '@/lib/prices/model';

type Locale = 'en' | 'fr';

/**
 * A link out to a store or a document. The address is never in the page: the
 * link goes to /prices/go/<kind>-<id>, which redirects with no referrer.
 * Plain links only (ADR-0009): Pepforums earns nothing from them, so they are
 * nofollow but not "sponsored".
 */
export function GoLink({ kind, id, className = 'link', children, label }: {
  kind: 'offer' | 'vendor' | 'coa' | 'store' | 'evidence' | 'lab' | 'listing' | 'document'; id: string; className?: string; children: ReactNode; label?: string;
}) {
  const prefix = { offer: 'o', vendor: 'v', coa: 'c', store: 's', evidence: 'e', lab: 'l', listing: 'p', document: 'd' }[kind];
  return (
    <a className={className} href={`/prices/go/${prefix}-${id}`} target="_blank" rel="nofollow noopener noreferrer" aria-label={label}>
      {children}
    </a>
  );
}

/** Vendor name linking to its page. */
export function VendorName({ vendor }: { vendor: PriceVendor; t?: Translate }) {
  return <Link className="link" href={`/prices/vendor/${vendor.slug}`}><b>{vendor.name}</b></Link>;
}

/** What every price page says about the numbers on it. */
export function PriceNotes({ rate, publishedAt, staleHours, locale, t }: {
  rate: CadRate | null; publishedAt: string | null; staleHours: number; locale: Locale; t: Translate;
}) {
  const when = publishedAt
    ? new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto' }).format(new Date(publishedAt))
    : null;
  return (
    <div className="card card-p small muted">
      <p>{t('prices.notes.currency')} {rate ? t('prices.notes.rate', { rate: rate.rate.toFixed(4), provider: rate.provider, date: formatDay(rate.date, locale) }) : t('prices.notes.noRate')}</p>
      <p className="mt8">{t('prices.notes.excluded')} {t('prices.notes.stale', { hours: staleHours })}</p>
      {when ? <p className="mt8">{t('prices.notes.published', { when })}</p> : null}
      <p className="mt8">{t('prices.notes.research')}</p>
      <p className="mt8">
        <Link className="link" href="/legal/price-methodology">{t('prices.methodology')}</Link>
      </p>
    </div>
  );
}

/** The purity a certificate states, exactly as recorded: never rounded up. */
export const purityText = (pct: number, locale: Locale): string =>
  `${new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: 3 }).format(pct)}${locale === 'fr' ? '\u00a0%' : '%'}`;

/** A vendor's published certificates of analysis. Always labelled as the vendor's own documents. */
export function CoaTable({ coas, compounds, locale, t, showCompound = true }: {
  coas: readonly PriceCoa[]; compounds: readonly PriceCompound[]; locale: Locale; t: Translate; showCompound?: boolean;
}) {
  if (coas.length === 0) return <p className="small muted">{t('prices.coa.none')}</p>;
  const name = (slug: string | null) => compounds.find((c) => c.slug === slug)?.name ?? t('prices.coa.anyProduct');
  return (
    <>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {showCompound ? <th scope="col">{t('prices.col.compound')}</th> : null}
              <th scope="col" className="num">{t('prices.coa.purity')}</th>
              <th scope="col">{t('prices.coa.lab')}</th>
              <th scope="col">{t('prices.coa.method')}</th>
              <th scope="col">{t('prices.coa.covers')}</th>
              <th scope="col">{t('prices.coa.tested')}</th>
              <th scope="col">{t('prices.coa.document')}</th>
            </tr>
          </thead>
          <tbody>
            {coas.map((c) => (
              <tr key={c.id}>
                {showCompound ? <td>{name(c.compound)}</td> : null}
                <td className="num"><b>{purityText(c.stated_purity_pct, locale)}</b></td>
                <td>{c.lab}{c.lab_accreditation ? <span className="muted xs">{t('prices.coa.accreditation', { text: c.lab_accreditation })}</span> : null}</td>
                <td>{c.method ? t(`prices.coa.method.${c.method}` as MessageKey) : '—'}</td>
                <td>{t(`prices.coa.scope.${c.scope}` as MessageKey)}{c.batch ? <span className="muted xs">{t('prices.coa.batch', { batch: c.batch })}</span> : null}</td>
                <td>{c.test_date ? formatDay(c.test_date, locale) : '—'}<span className="muted xs">{t('prices.coa.checked', { date: formatDay(c.checked, locale) })}</span></td>
                <td><GoLink kind="coa" id={c.id}>{t('prices.coa.open')}</GoLink></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="xs faint mt8">{t('prices.coa.disclaimer')}</p>
    </>
  );
}

/** The lowest in-stock price per mg on each day, across vendors, in CAD. */
export function HistoryChart({ points, rate, locale, t }: { points: readonly PriceHistoryPoint[]; rate: CadRate | null; locale: Locale; t: Translate }) {
  const byDay = new Map<string, number>();
  for (const p of points) {
    const cad = toCad(p.per_mg_minor_e4 / 10_000, p.currency, rate);
    if (cad !== null && cad < (byDay.get(p.day) ?? Infinity)) byDay.set(p.day, cad);
  }
  const days = [...byDay].sort(([a], [b]) => a.localeCompare(b));
  if (days.length < 2) return <p className="small muted">{t('prices.history.none')}</p>;
  // Charts draw whole numbers: tenths of a cent keep small per-mg prices apart.
  const series: SeriesPoint[] = days.map(([day, cad]) => ({ label: `${formatDay(day, locale)} · ${formatCad(cad, locale)}`, value: Math.round(cad * 10) }));
  const values = days.map(([, cad]) => cad);
  const first = days[0] as [string, number];
  const last = days[days.length - 1] as [string, number];
  return (
    <>
      <Sparkline points={series} label={t('prices.history.label')} />
      <ul className="caps mt8">
        <li><span>{t('prices.history.first', { date: formatDay(first[0], locale) })}</span><b>{formatCad(first[1], locale)}</b></li>
        <li><span>{t('prices.history.latest', { date: formatDay(last[0], locale) })}</span><b>{formatCad(last[1], locale)}</b></li>
        <li><span>{t('prices.history.range')}</span><b>{formatCad(Math.min(...values), locale)} – {formatCad(Math.max(...values), locale)}</b></li>
      </ul>
    </>
  );
}

/** Shown in place of a price page while the section is switched off. */
export function PricesOff({ t }: { t: Translate }) {
  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="card empty">
          <b>{t('prices.off.title')}</b>
          <p>{t('prices.off.body')}</p>
          <Link className="btn dark mt16" href="/">{t('notFound.back')}</Link>
        </div>
      </main>
    </div>
  );
}
