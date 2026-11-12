import 'server-only';

import type { Database } from '@pepforum/database';
import { cache } from 'react';

import { type DbErrorLike, logUnexpected } from '@/lib/errors';

import { getSupabase } from './context';

/**
 * Reads for /admin. Every function here is an admin RPC that the database
 * gates (admin + MFA); this module only shapes the result. A missing function
 * (code PGRST202) means the console was deployed before `supabase db push`.
 */
type Functions = Database['public']['Functions'];
type AdminFn = Extract<keyof Functions, `admin_${string}` | 'mod_queue' | 'open_appeals'>;

export type AdminResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly missingMigration: boolean; readonly error: DbErrorLike };

type Rpc = (fn: string, args: unknown) => PromiseLike<{ data: unknown; error: DbErrorLike | null }>;

async function call<K extends AdminFn>(fn: K, args: Functions[K]['Args']): Promise<AdminResult<Functions[K]['Returns']>> {
  const supabase = await getSupabase();
  // The generic overloads of rpc() don't narrow over a union of names.
  const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;
  const { data, error } = await rpc(fn, args);
  if (error) {
    const missingMigration = error.code === 'PGRST202' || error.code === '42883';
    if (!missingMigration) logUnexpected(fn, error);
    return { ok: false, missingMigration, error };
  }
  return { ok: true, data: data as Functions[K]['Returns'] };
}

export const adminOverview = cache(() => call('admin_overview', {}));
export const adminMetrics = cache((days: 7 | 30 | 90) => call('admin_metrics', { p_days: days }));
export const adminPeople = (args: Functions['admin_people']['Args']) => call('admin_people', args);
export const adminMember = cache((username: string) => call('admin_member', { p_username: username }));
export const adminContent = (args: Functions['admin_content']['Args']) => call('admin_content', args);
export const adminModLog = (args: Functions['admin_mod_log']['Args']) => call('admin_mod_log', args);
export const adminTeam = cache(() => call('admin_team', {}));
export const adminNotesHealth = cache(() => call('admin_notes_health', {}));
export const adminConfig = cache(() => call('admin_config', {}));
export const adminConfigHistory = (key: string) => call('admin_config_history', { p_key: key });
export const adminSystemStatus = cache(() => call('admin_system_status', {}));
export const adminShield = cache(() => call('admin_shield', {}));
export const adminLinks = cache(() => call('admin_links', {}));
export const adminMemberReports = cache(() => call('admin_member_reports', {}));
export const adminTickets = (args: Functions['admin_tickets']['Args']) => call('admin_tickets', args);
export const adminTicket = cache((id: string) => call('admin_ticket', { p_ticket: id }));
export const adminQueue = cache(() => call('mod_queue', { p_zone: null }));
export const adminAppeals = cache(() => call('open_appeals', { p_zone: null }));
// Ported features (…021–…025)
export const adminRedirects = cache(() => call('admin_redirects', {}));
export const adminMedia = (args: Functions['admin_media']['Args']) => call('admin_media', args);
export const adminClinicians = (args: Functions['admin_clinician_verifications']['Args']) => call('admin_clinician_verifications', args);
export const adminAds = cache(() => call('admin_ads', {}));
// Price tracking (…031, …032)
export const adminPriceOverview = cache(() => call('admin_price_overview', {}));
export const adminPriceCoas = cache(() => call('admin_price_coas', { p_status: null }));
export const adminPriceLinks = cache(() => call('admin_price_links', {}));
