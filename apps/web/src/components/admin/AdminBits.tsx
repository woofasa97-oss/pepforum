import type { ReactNode } from 'react';

import { Icon } from '@/components/ui/Icon';
import { messageForDbError } from '@/lib/errors';
import { compactNumber } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import type { AdminResult } from '@/server/admin';

import { type SeriesPoint, Sparkline } from './Charts';

/** Title, one-sentence explanation, optional actions on the right. */
export function PageHeader({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <div className="page-h">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{sub}</p>
      </div>
      {children ? <div className="row wrap">{children}</div> : null}
    </div>
  );
}

/** Shown in place of a section when its data couldn't be loaded. */
export function DataUnavailable({ result, t }: { result: Extract<AdminResult<unknown>, { ok: false }>; t: Translate }) {
  return (
    <div className="banner danger" role="alert">
      <Icon name="alert" />
      <div>{result.missingMigration ? t('admin.missingMigration') : messageForDbError(result.error, t)}</div>
    </div>
  );
}

/**
 * A number with its change versus the previous period and a trend line.
 * The arrow carries the direction, so the colour is never the only signal.
 */
export function StatTile({ label, value, previous, points, goodWhenUp = true, sub, hint, locale, t }: {
  label: string;
  value: number;
  previous?: number;
  points?: readonly SeriesPoint[];
  goodWhenUp?: boolean;
  sub?: string;
  hint?: string;
  locale: string;
  t: Translate;
}) {
  let delta: ReactNode = null;
  if (previous !== undefined) {
    const diff = value - previous;
    const pct = previous > 0 ? Math.round((diff / previous) * 100) : null;
    const tone = diff === 0 ? 'flat' : (diff > 0) === goodWhenUp ? 'good' : 'bad';
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '■';
    delta = (
      <span className={`delta ${tone}`}>
        {arrow} {pct === null ? (diff > 0 ? `+${diff}` : String(diff)) : `${pct > 0 ? '+' : ''}${pct}%`}
        <span className="faint"> {t('admin.vsPrevious')}</span>
      </span>
    );
  }
  return (
    <div className="stat" title={hint}>
      <div className="l">{label}</div>
      <div className="v">{compactNumber(value, locale)}</div>
      {delta}
      {sub ? <div className="xs muted">{sub}</div> : null}
      {points ? <Sparkline points={points} label={label} /> : null}
    </div>
  );
}

/** Two-column facts list. */
export function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Content status as a coloured pill with its name (never colour alone). */
export function StatusPill({ status, t }: { status: string; t: Translate }) {
  const tone = status === 'removed' ? 'red' : status === 'collapsed' || status === 'held' ? 'amber' : status === 'deleted' ? '' : 'green';
  return <span className={`pill ${tone}`}>{t(`admin.status.${status}` as MessageKey)}</span>;
}
