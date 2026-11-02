import type { Locale } from '@pepforum/database';

import { type MessageKey, en } from './en.ts';
import { fr } from './fr.ts';

export type { MessageKey };
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export const LOCALE_COOKIE = 'pf-locale';

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, fr };

export function translator(locale: Locale): Translate {
  const messages = dictionaries[locale];
  return (key, vars) => {
    let text = messages[key] ?? en[key] ?? key;
    if (vars) for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
}

/** Cookie wins; otherwise the browser's preferred language; otherwise English. */
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (cookieValue === 'fr' || cookieValue === 'en') return cookieValue;
  const preferred = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return preferred.startsWith('fr') ? 'fr' : 'en';
}

export { en, fr };

/** Pre-translates a set of keys for a Client Component (functions can't cross the boundary). */
export function pick<K extends MessageKey>(t: Translate, keys: readonly K[]): Record<K, string> {
  return Object.fromEntries(keys.map((key) => [key, t(key)])) as Record<K, string>;
}
