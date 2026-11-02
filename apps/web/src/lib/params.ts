import { z } from 'zod';

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Untrusted query string → safe feed options (invalid values fall back to defaults). */
export function parseFeedParams(params: SearchParams): { sort: 'hot' | 'new' | 'top'; page: number; city: string | undefined } {
  const sort = z.enum(['hot', 'new', 'top']).catch('hot').parse(first(params.sort));
  const page = z.coerce.number().int().min(0).max(40).catch(0).parse(first(params.page));
  const city = z.string().regex(/^[a-z0-9-]{2,40}$/).optional().catch(undefined).parse(first(params.city));
  return { sort, page, city };
}

export const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;
