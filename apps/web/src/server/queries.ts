import 'server-only';

import type {
  AppealRow,
  AppealView,
  CategoryRow,
  CityRow,
  CommentRow,
  FeedRow,
  LedgerEventRow,
  ModActionRow,
  ModQueueItem,
  MyTicketSummary,
  MyTicketView,
  NoteDetailView,
  NoteView,
  PostDetailRow,
  ProfileView,
  SiteAnnouncement,
  TransparencyStats,
  ZoneRow,
} from '@pepforum/database';
import { cache } from 'react';

import { OAUTH_PROVIDERS, type OAuthProvider } from '@/lib/auth-providers';
import { env } from '@/lib/env';
import { type DbErrorLike, logUnexpected } from '@/lib/errors';

import { getSupabase, getViewer } from './context';

/**
 * Read-side data access. Every call runs as the current member through RLS or
 * a read-API function; nothing here uses elevated credentials.
 */

function unwrap<T>(context: string, result: { data: T | null; error: DbErrorLike | null }): T {
  if (result.error) {
    logUnexpected(context, result.error);
    throw new Error(`${context} failed`);
  }
  return result.data as T;
}

export interface Taxonomy {
  readonly zones: ZoneRow[];
  readonly categories: CategoryRow[];
  readonly cities: CityRow[];
}

export const getTaxonomy = cache(async (): Promise<Taxonomy> => {
  const supabase = await getSupabase();
  const [zones, categories, cities] = await Promise.all([
    supabase.from('zones').select('*').order('sort_order'),
    supabase.from('categories').select('*').is('archived_at', null).order('sort_order'),
    supabase.from('cities').select('*').order('sort_order'),
  ]);
  return {
    zones: unwrap('zones', zones),
    categories: unwrap('categories', categories),
    cities: unwrap('cities', cities),
  };
});

/**
 * Social providers switched on in the Supabase dashboard, read from the public
 * Auth settings endpoint (cached for a minute). Turning a provider on or off
 * there adds or removes its button without a deploy.
 */
export const getEnabledOAuthProviders = cache(async (): Promise<OAuthProvider[]> => {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = env();
  try {
    const response = await fetch(new URL('/auth/v1/settings', SUPABASE_URL), {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
      next: { revalidate: 60 },
    });
    if (!response.ok) {
      console.error(`[auth] provider settings unavailable: HTTP ${response.status}`);
      return [];
    }
    const settings = (await response.json()) as { external?: Record<string, unknown> };
    return OAUTH_PROVIDERS.filter((provider) => settings.external?.[provider] === true);
  } catch (error) {
    // Auth unreachable: email and password still work.
    console.error(`[auth] provider settings unavailable: ${error instanceof Error ? error.name : 'unknown'}`);
    return [];
  }
});

/** Every category, archived ones included (for the admin editor). */
export const getAllCategories = cache(async (): Promise<CategoryRow[]> => {
  const supabase = await getSupabase();
  return unwrap('categories', await supabase.from('categories').select('*').order('sort_order'));
});

/** The site-wide banner, if one is set and not past its end date. Fails soft. */
export const getAnnouncement = cache(async (): Promise<SiteAnnouncement | null> => {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('app_config').select('value').eq('key', 'site.announcement').maybeSingle();
  if (error || !data) return null;
  const value = data.value as SiteAnnouncement;
  if (!value.en && !value.fr) return null;
  if (value.until && value.until < new Date().toISOString().slice(0, 10)) return null;
  return value;
});

/** Whether links wait for an admin (…018). Assumes yes if the setting can't be read. */
export const getLinkReview = cache(async (): Promise<boolean> => {
  const supabase = await getSupabase();
  const { data, error } = await supabase.from('app_config').select('value').eq('key', 'links.require_approval').maybeSingle();
  return error || !data ? true : data.value !== false;
});

/** Public monthly transparency numbers; null if unavailable. */
export const getTransparency = cache(async (month: string | null): Promise<TransparencyStats | null> => {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('transparency_stats', { p_month: month });
  if (error) {
    logUnexpected('transparency_stats', error);
    return null;
  }
  return data;
});

export interface FeedQuery {
  readonly zone?: string;
  readonly category?: string;
  readonly city?: string;
  readonly author?: string;
  readonly sort?: 'hot' | 'new' | 'top';
  readonly page?: number;
}

export const FEED_PAGE_SIZE = 25;

export async function getFeed(query: FeedQuery): Promise<FeedRow[]> {
  const supabase = await getSupabase();
  return unwrap(
    'get_feed',
    await supabase.rpc('get_feed', {
      p_zone: query.zone ?? null,
      p_category: query.category ?? null,
      p_city: query.city ?? null,
      p_author_username: query.author ?? null,
      p_sort: query.sort ?? 'hot',
      p_limit: FEED_PAGE_SIZE,
      p_offset: Math.max(0, (query.page ?? 0) * FEED_PAGE_SIZE),
    }),
  );
}

export async function getPost(postId: string): Promise<PostDetailRow | null> {
  const supabase = await getSupabase();
  const rows = unwrap('get_post', await supabase.rpc('get_post', { p_post_id: postId }));
  return rows[0] ?? null;
}

export async function getComments(postId: string): Promise<CommentRow[]> {
  const supabase = await getSupabase();
  return unwrap('get_comments', await supabase.rpc('get_comments', { p_post_id: postId }));
}

export async function getPostNotes(postId: string): Promise<NoteView[]> {
  const supabase = await getSupabase();
  return unwrap('get_post_notes', await supabase.rpc('get_post_notes', { p_post_id: postId }));
}

export async function getNote(noteId: string): Promise<NoteDetailView | null> {
  const supabase = await getSupabase();
  return unwrap('get_note', await supabase.rpc('get_note', { p_note_id: noteId }));
}

export async function listNotes(tab: 'needs_ratings' | 'helpful' | 'not_helpful' | 'mine', page = 0): Promise<NoteView[]> {
  const supabase = await getSupabase();
  return unwrap(
    'list_notes',
    await supabase.rpc('list_notes', { p_tab: tab, p_limit: 25, p_offset: page * 25 }),
  );
}

export async function getProfile(username: string): Promise<ProfileView | null> {
  const supabase = await getSupabase();
  return unwrap('get_profile', await supabase.rpc('get_profile', { p_username: username }));
}

export async function getMyLedger(limit = 50): Promise<LedgerEventRow[]> {
  const viewer = await getViewer();
  if (!viewer) return [];
  const supabase = await getSupabase();
  return unwrap(
    'ledger',
    await supabase.from('ledger_events').select('*').eq('user_id', viewer.id).order('id', { ascending: false }).limit(limit),
  );
}

/** Moderator actions taken on the current member (for appeals). */
export async function getActionsOnMe(): Promise<Array<ModActionRow & { appeal: AppealRow | null }>> {
  const viewer = await getViewer();
  if (!viewer) return [];
  const supabase = await getSupabase();
  const [actions, appeals] = await Promise.all([
    // Explicit columns: the acting moderator's identity is not granted to members.
    supabase.from('mod_actions').select('id, action, target_kind, target_id, target_user_id, zone_id, reason, metadata, created_at')
      .eq('target_user_id', viewer.id).in('action', ['remove', 'sanction'])
      .order('created_at', { ascending: false }).limit(20),
    supabase.from('appeals').select('id, mod_action_id, appellant_id, body, status, decided_at, decision_note, created_at')
      .eq('appellant_id', viewer.id),
  ]);
  const appealByAction = new Map(unwrap('appeals', appeals).map((a) => [a.mod_action_id, a]));
  return unwrap('mod_actions', actions).map((a) => ({ ...a, appeal: appealByAction.get(a.id) ?? null }));
}

export async function getMyModZones(): Promise<string[]> {
  const viewer = await getViewer();
  if (!viewer) return [];
  const supabase = await getSupabase();
  const rows = unwrap('zone_moderators', await supabase.from('zone_moderators').select('zone_id').eq('user_id', viewer.id));
  return rows.map((r) => r.zone_id);
}

export async function getModQueue(zone: string): Promise<{ items: ModQueueItem[]; appeals: AppealView[] } | { error: DbErrorLike }> {
  const supabase = await getSupabase();
  const [queue, appeals] = await Promise.all([
    supabase.rpc('mod_queue', { p_zone: zone }),
    supabase.rpc('open_appeals', { p_zone: zone }),
  ]);
  if (queue.error) return { error: queue.error };
  if (appeals.error) return { error: appeals.error };
  return { items: queue.data, appeals: appeals.data };
}

/** A read-API function that doesn't exist yet: the code was deployed before `supabase db push`. */
const isMissingFunction = (error: DbErrorLike) => error.code === 'PGRST202' || error.code === '42883';

/** The member's own tickets to the team (…020). Empty until the migration is applied. */
export async function getMyTickets(): Promise<MyTicketSummary[]> {
  if (!(await getViewer())) return [];
  const supabase = await getSupabase();
  const result = await supabase.rpc('my_tickets');
  if (result.error && isMissingFunction(result.error)) return [];
  return unwrap('my_tickets', result);
}

/** One of the member's tickets with its thread; opening it marks the team's replies read. */
export async function getMyTicket(ticketId: string): Promise<MyTicketView | null> {
  if (!(await getViewer())) return null;
  const supabase = await getSupabase();
  const result = await supabase.rpc('my_ticket', { p_ticket: ticketId });
  if (result.error && isMissingFunction(result.error)) return null;
  return unwrap('my_ticket', result);
}
