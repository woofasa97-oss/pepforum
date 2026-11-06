import 'server-only';

import type {
  AdRateCard,
  AppealRow,
  AppealView,
  CategoryRow,
  FollowRow,
  CityRow,
  CommentRow,
  FeedRow,
  LedgerEventRow,
  ModActionRow,
  MediaAccess,
  ModQueueItem,
  MyAdvertiser,
  MyClinicianVerification,
  MyTicketSummary,
  MyTicketView,
  NotificationItem,
  NotificationSettings,
  PendingImage,
  PostImage,
  RedirectTarget,
  ServedAd,
  SitemapCounts,
  SitemapEntry,
  NoteDetailView,
  NoteView,
  PostDetailRow,
  ProfileView,
  SiteAnnouncement,
  TransparencyStats,
  ZoneRow,
} from '@pepforum/database';
import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
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
  /** features.regions: show provinces and cities to members (…026). Off if the setting can't be read. */
  readonly regions: boolean;
}

export const getTaxonomy = cache(async (): Promise<Taxonomy> => {
  const supabase = await getSupabase();
  const [zones, categories, cities, regions] = await Promise.all([
    supabase.from('zones').select('*').order('sort_order'),
    supabase.from('categories').select('*').is('archived_at', null).order('sort_order'),
    supabase.from('cities').select('*').order('sort_order'),
    supabase.from('app_config').select('value').eq('key', 'features.regions').maybeSingle(),
  ]);
  return {
    zones: unwrap('zones', zones),
    categories: unwrap('categories', categories),
    cities: unwrap('cities', cities),
    regions: !regions.error && regions.data?.value === true,
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

// ── SEO (…021) ──────────────────────────────────────────────────────────────
/** A managed redirect for a path, if an admin set one. Fails soft (no redirect). */
export async function resolveRedirect(path: string): Promise<RedirectTarget | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('resolve_redirect', { p_path: path });
  return error ? null : data;
}

/** The current username behind a former one (admin renames keep old links working). */
export async function resolveUsername(old: string): Promise<string | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('resolve_username', { p_old: old });
  return error ? null : data;
}

export async function getSitemapCounts(): Promise<SitemapCounts | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('sitemap_counts');
  if (error) {
    logUnexpected('sitemap_counts', error);
    return null;
  }
  return data;
}

export async function getSitemapEntries(kind: 'posts' | 'notes' | 'profiles', page: number): Promise<SitemapEntry[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('sitemap_entries', { p_kind: kind, p_page: page });
  if (error) {
    logUnexpected('sitemap_entries', error);
    return [];
  }
  return data;
}

// ── Notifications (…022) ────────────────────────────────────────────────────
export async function getMyNotifications(limit = 50): Promise<NotificationItem[]> {
  if (!(await getViewer())) return [];
  const supabase = await getSupabase();
  const result = await supabase.rpc('my_notifications', { p_limit: limit });
  if (result.error && isMissingFunction(result.error)) return [];
  return unwrap('my_notifications', result);
}

export async function getNotificationSettings(): Promise<NotificationSettings | null> {
  if (!(await getViewer())) return null;
  const supabase = await getSupabase();
  const result = await supabase.rpc('my_notification_settings');
  if (result.error && isMissingFunction(result.error)) return null;
  return unwrap('my_notification_settings', result);
}

// ── Media (…023) ────────────────────────────────────────────────────────────
export async function getPostMedia(postId: string): Promise<PostImage[]> {
  const supabase = await getSupabase();
  const result = await supabase.rpc('get_post_media', { p_post_id: postId });
  if (result.error && isMissingFunction(result.error)) return [];
  return unwrap('get_post_media', result);
}

export async function getMyPendingMedia(): Promise<PendingImage[]> {
  if (!(await getViewer())) return [];
  const supabase = await getSupabase();
  const result = await supabase.rpc('my_pending_media');
  if (result.error && isMissingFunction(result.error)) return [];
  return unwrap('my_pending_media', result);
}

/** Where an upload's bytes are, if the viewer may see them (used by /media/<id>). */
export async function getMediaAccess(id: string): Promise<MediaAccess | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('get_media_access', { p_id: id });
  if (error) {
    logUnexpected('get_media_access', error);
    return null;
  }
  return data;
}

// ── Clinician verification (…024) ───────────────────────────────────────────
export async function getMyClinicianVerification(): Promise<MyClinicianVerification | null> {
  if (!(await getViewer())) return null;
  const supabase = await getSupabase();
  const result = await supabase.rpc('my_clinician_verification');
  if (result.error && isMissingFunction(result.error)) return null;
  return unwrap('my_clinician_verification', result);
}

// ── Advertising (…025) ──────────────────────────────────────────────────────
export const getAdRateCard = cache(async (): Promise<AdRateCard | null> => {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('ad_rate_card');
  if (error) {
    if (!isMissingFunction(error)) logUnexpected('ad_rate_card', error);
    return null;
  }
  return data;
});

export async function getMyAdvertiser(): Promise<MyAdvertiser | null> {
  if (!(await getViewer())) return null;
  const supabase = await getSupabase();
  const result = await supabase.rpc('my_advertiser');
  if (result.error && isMissingFunction(result.error)) return null;
  return unwrap('my_advertiser', result);
}

/**
 * An opaque per-visitor token for ad frequency capping: a salted hash of the
 * request's network address and user agent that changes daily. Never stored
 * next to anything identifying, never reversible.
 */
async function visitorToken(): Promise<string> {
  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? '';
  const ua = h.get('user-agent') ?? '';
  const salt = env().AD_VISITOR_SALT ?? env().SUPABASE_PUBLISHABLE_KEY;
  return createHash('sha256').update(`${salt}:${ip}:${ua}:${new Date().toISOString().slice(0, 10)}`).digest('base64url').slice(0, 32);
}

/** One running campaign for a slot, or null (ads off, nothing booked, or an error). */
export async function getAd(pkg: 'national' | 'zone' | 'category', target: string | null, locale: 'en' | 'fr'): Promise<ServedAd | null> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('get_ad', { p_package: pkg, p_target: target, p_visitor: await visitorToken(), p_locale: locale });
  if (error) {
    if (!isMissingFunction(error)) logUnexpected('get_ad', error);
    return null;
  }
  return data;
}

/** Followers of a member, or the people they follow (…027). Null for an unknown member; empty before the migration. */
export async function getFollows(username: string, kind: 'followers' | 'following'): Promise<FollowRow[] | null> {
  const supabase = await getSupabase();
  const result = await supabase.rpc('get_follows', { p_username: username, p_kind: kind });
  if (result.error && isMissingFunction(result.error)) return [];
  return unwrap('get_follows', result);
}
