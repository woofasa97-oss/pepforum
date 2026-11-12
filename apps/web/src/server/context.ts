import 'server-only';

import type { Locale, StandingView } from '@pepforum/database';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

import { LOCALE_COOKIE, type Translate, resolveLocale, translator } from '@/lib/i18n';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Per-request context, memoised with React cache(): the Supabase client, the
 * verified viewer, their standing, locale and translator.
 */

export const getSupabase = cache(createSupabaseServerClient);

export interface Viewer {
  readonly id: string;
  /** 'aal2' after a TOTP challenge in this session. */
  readonly aal: 'aal1' | 'aal2';
}

/**
 * The signed-in member, from a *verified* JWT (getClaims validates the
 * signature; getSession would merely trust the cookie).
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const supabase = await getSupabase();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return { id: data.claims.sub, aal: data.claims.aal === 'aal2' ? 'aal2' : 'aal1' };
});

export const getStanding = cache(async (): Promise<StandingView | null> => {
  if (!(await getViewer())) return null;
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('my_standing');
  return error ? null : data;
});

export const getLocale = cache(async (): Promise<Locale> => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  return resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'));
});

export const getT = cache(async (): Promise<Translate> => translator(await getLocale()));

export const getNonce = cache(async (): Promise<string | undefined> => (await headers()).get('x-nonce') ?? undefined);

/** The request's clock: one reading shared by everything rendered for it, so "checked 3 h ago" and "stale" agree. */
export const getNow = cache(async (): Promise<number> => Date.now());
