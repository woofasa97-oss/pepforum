import type { ReactNode } from 'react';

import type { MessageKey, Translate } from '@/lib/i18n';

export function TierBadge({ tier, t }: { tier: number; t: Translate }) {
  const label = t(`tier.${tier}` as MessageKey);
  return (
    <span className={`tier t${tier}`} title={label} aria-label={label}>
      {tier}
    </span>
  );
}

/** Deterministic pastel avatar from the username (no uploaded photos by design). */
export function Avatar({ name, size = '' }: { name: string; size?: '' | 'sm' | 'lg' }) {
  let hue = 0;
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className={`avatar ${size}`}
      style={{ background: `hsl(${hue} 45% 86%)`, color: `hsl(${hue} 50% 26%)` }}
      aria-hidden="true"
    >
      {name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase()}
    </span>
  );
}

export function Progress({ value, max, tone = 'teal', label }: { value: number; max: number; tone?: 'teal' | 'green' | 'amber'; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={`prog ${tone === 'amber' ? '' : tone}`} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

export function FormMessage({ ok, message }: { ok: boolean; message?: string | undefined }) {
  if (!message) return null;
  return (
    <div className={`banner ${ok ? 'ok' : 'danger'} mb12`} role={ok ? 'status' : 'alert'}>
      {message}
    </div>
  );
}

export function FieldError({ message }: { message?: string | undefined }) {
  return message ? <span className="err-msg">{message}</span> : null;
}
