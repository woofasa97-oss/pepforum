import type { Translate } from '@/lib/i18n';

export function relativeTime(iso: string, t: Translate, now: Date = new Date()): string {
  const seconds = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t('time.justNow');
  if (seconds < 3600) return t('time.minutes', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('time.hours', { n: Math.floor(seconds / 3600) });
  return t('time.days', { n: Math.floor(seconds / 86400) });
}

export function compactNumber(n: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(iso));
}
