import { COUNTRIES } from '@pepforum/database';

type Locale = 'en' | 'fr';

/** Country name in the reader's language (ISO 3166-1 alpha-2 code → "Canada" / "Canada"). */
export function countryName(code: string, locale: Locale): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Every country as select options, sorted by name in the reader's language (…034). */
export function countryOptions(locale: Locale): Array<{ id: string; name: string }> {
  const names = new Intl.DisplayNames([locale], { type: 'region' });
  return COUNTRIES.map((id) => ({ id, name: names.of(id) ?? id })).sort((a, b) => a.name.localeCompare(b.name, locale));
}
