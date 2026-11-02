/**
 * Small server-rendered SVG charts for the admin console. Single series only,
 * one hue (text colours for text), 2px lines, hairline grid. Every point has a
 * native <title> tooltip, and every chart sits next to the numbers it draws
 * (a stat value, direct labels, or a table view).
 */

export interface SeriesPoint {
  readonly label: string;
  readonly value: number;
}

/** Trend line for a stat tile: muted line, the latest point in the accent colour. */
export function Sparkline({ points, label }: { points: readonly SeriesPoint[]; label: string }) {
  if (points.length < 2) return null;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = 100 / (points.length - 1);
  const y = (v: number) => 33 - (v / max) * 29;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)} ${y(p.value).toFixed(2)}`).join(' ');
  const last = points[points.length - 1] as SeriesPoint;
  return (
    <svg className="spark" viewBox="0 0 100 36" preserveAspectRatio="none" role="img" aria-label={label}>
      <line className="base" x1="0" y1="33" x2="100" y2="33" />
      <path className="line" d={path} />
      <line className="end" x1="100" y1={y(last.value)} x2="100" y2={y(last.value)} />
      {points.map((p, i) => (
        <rect key={p.label} className="hit" x={Math.max(0, i * step - step / 2)} y="0" width={step} height="36">
          <title>{`${p.label}: ${p.value.toLocaleString()}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** Horizontal bars with direct labels (label · bar · value). */
export function BarList({ rows, label }: { rows: ReadonlyArray<{ label: string; value: number }>; label: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="barlist" aria-label={label}>
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${r.value.toLocaleString()}`}>
          <span className="lbl">{r.label}</span>
          <span className="track"><span className="bar" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="num">{r.value.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A 0–100% line with a labelled target (e.g. scoring agreement vs the 85%
 * switch threshold). Gaps in the data are left out rather than drawn as zero.
 */
export function PercentLine({ points, target, targetLabel, label }: {
  points: ReadonlyArray<{ label: string; value: number | null }>;
  target?: number;
  targetLabel?: string;
  label: string;
}) {
  const known = points.map((p, i) => ({ ...p, i })).filter((p): p is { label: string; value: number; i: number } => p.value !== null);
  const W = 600;
  const H = 160;
  const left = 36;
  const plotW = W - left - 8;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const y = (v: number) => 8 + (1 - v / 100) * (H - 30);
  const x = (i: number) => left + i * step;
  const path = known.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  return (
    <svg className="pline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line className="grid" x1={left} x2={W - 8} y1={y(v)} y2={y(v)} />
          <text className="tick" x={left - 6} y={y(v) + 4} textAnchor="end">{v}%</text>
        </g>
      ))}
      {target !== undefined ? (
        <g>
          <line className="target" x1={left} x2={W - 8} y1={y(target)} y2={y(target)} />
          <text className="tick" x={W - 10} y={y(target) - 5} textAnchor="end">{targetLabel}</text>
        </g>
      ) : null}
      {known.length > 1 ? <path className="line" d={path} /> : null}
      {known.map((p) => (
        <g key={p.i}>
          <circle className="pt" cx={x(p.i)} cy={y(p.value)} r="4" />
          <rect className="hit" x={x(p.i) - Math.max(step, 24) / 2} y="0" width={Math.max(step, 24)} height={H}>
            <title>{`${p.label}: ${p.value}%`}</title>
          </rect>
        </g>
      ))}
    </svg>
  );
}
