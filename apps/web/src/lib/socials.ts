import 'server-only';

import { createHash, createHmac, randomBytes } from 'node:crypto';

import { SOCIAL_PLATFORMS, type SocialPlatform } from '@pepforum/database';

import { type ServerEnv, env } from '@/lib/env';

/**
 * Verified social accounts (…028). A member signs in to X, YouTube,
 * Instagram, TikTok or Reddit; this server swaps the code for a token, reads
 * the account's id, handle and audience from the network's own API, throws
 * the token away and signs the result for the database (HMAC with
 * SOCIAL_ATTESTATION_KEY, which the database also holds). Members can't
 * forge or inflate numbers by calling the RPC themselves.
 *
 * API details follow each network's public OAuth documentation; if a network
 * changes an endpoint, only its adapter below needs updating.
 */
export interface SocialProfile {
  readonly externalId: string;
  readonly handle: string;
  /** Followers (X, Instagram, TikTok, Reddit) or subscribers (YouTube). */
  readonly audience: number;
  readonly url: string;
  readonly metrics: Readonly<Record<string, number | string>>;
}

export type SocialErrorCode = 'exchange_failed' | 'profile_failed' | 'no_channel';

export class SocialError extends Error {
  readonly code: SocialErrorCode;
  constructor(code: SocialErrorCode) {
    super(code);
    this.code = code;
  }
}

interface Credentials { readonly id: string; readonly secret: string }

interface Adapter {
  readonly credentials: (e: ServerEnv) => Credentials | null;
  readonly authorizeUrl: string;
  readonly scope: string;
  readonly pkce: boolean;
  /** TikTok names its client id `client_key`. */
  readonly clientIdParam?: string;
  readonly extraParams?: Readonly<Record<string, string>>;
  readonly exchange: (code: string, redirectUri: string, verifier: string, c: Credentials) => Promise<string>;
  readonly profile: (token: string) => Promise<SocialProfile>;
}

const TIMEOUT = 10_000;
const REDDIT_UA = 'web:ca.pepforum:1.0 (account verification)';
const basic = (c: Credentials) => `Basic ${Buffer.from(`${encodeURIComponent(c.id)}:${encodeURIComponent(c.secret)}`).toString('base64')}`;
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0);
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

async function json(url: string, init: RequestInit, error: SocialErrorCode): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new SocialError(error);
  }
  if (!response.ok) {
    console.error(JSON.stringify({ level: 'error', context: 'social_api', code: response.status }));
    throw new SocialError(error);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function tokenFrom(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<string> {
  const data = await json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
    body: new URLSearchParams(body),
  }, 'exchange_failed');
  const nested = Array.isArray(data.data) ? (data.data[0] as Record<string, unknown> | undefined) : undefined;
  const token = str(data.access_token) || str(nested?.access_token);
  if (!token) throw new SocialError('exchange_failed');
  return token;
}

const googleCredentials = (e: ServerEnv) => (e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { id: e.GOOGLE_CLIENT_ID, secret: e.GOOGLE_CLIENT_SECRET } : null);

const ADAPTERS: Readonly<Record<SocialPlatform, Adapter>> = {
  x: {
    credentials: (e) => (e.X_CLIENT_ID && e.X_CLIENT_SECRET ? { id: e.X_CLIENT_ID, secret: e.X_CLIENT_SECRET } : null),
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    scope: 'users.read tweet.read',
    pkce: true,
    exchange: (code, redirectUri, verifier, c) =>
      tokenFrom('https://api.x.com/2/oauth2/token', { code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: verifier }, { authorization: basic(c) }),
    async profile(token) {
      const body = await json('https://api.x.com/2/users/me?user.fields=public_metrics', { headers: { authorization: `Bearer ${token}` } }, 'profile_failed');
      const d = (body.data ?? {}) as { id?: string; username?: string; public_metrics?: Record<string, unknown> };
      if (!d.id || !d.username) throw new SocialError('profile_failed');
      const m = d.public_metrics ?? {};
      return { externalId: d.id, handle: d.username, audience: num(m.followers_count), url: `https://x.com/${d.username}`,
        metrics: { posts: num(m.tweet_count), following: num(m.following_count) } };
    },
  },
  youtube: {
    credentials: googleCredentials,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'https://www.googleapis.com/auth/youtube.readonly',
    pkce: true,
    extraParams: { prompt: 'select_account', access_type: 'online' },
    exchange: (code, redirectUri, verifier, c) =>
      tokenFrom('https://oauth2.googleapis.com/token', { code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
    async profile(token) {
      const body = await json('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { authorization: `Bearer ${token}` } }, 'profile_failed');
      const item = (Array.isArray(body.items) ? body.items[0] : undefined) as
        { id?: string; snippet?: { title?: string; customUrl?: string }; statistics?: Record<string, unknown> } | undefined;
      if (!item?.id) throw new SocialError('no_channel');
      const handle = item.snippet?.customUrl || item.snippet?.title || item.id;
      return { externalId: item.id, handle: handle.slice(0, 100),
        audience: item.statistics?.hiddenSubscriberCount === true ? 0 : num(item.statistics?.subscriberCount),
        url: item.snippet?.customUrl ? `https://www.youtube.com/${item.snippet.customUrl}` : `https://www.youtube.com/channel/${item.id}`,
        metrics: { videos: num(item.statistics?.videoCount) } };
    },
  },
  instagram: {
    credentials: (e) => (e.INSTAGRAM_CLIENT_ID && e.INSTAGRAM_CLIENT_SECRET ? { id: e.INSTAGRAM_CLIENT_ID, secret: e.INSTAGRAM_CLIENT_SECRET } : null),
    authorizeUrl: 'https://www.instagram.com/oauth/authorize',
    scope: 'instagram_business_basic',
    pkce: false,
    exchange: (code, redirectUri, _verifier, c) =>
      tokenFrom('https://api.instagram.com/oauth/access_token', { client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
    async profile(token) {
      const body = await json(`https://graph.instagram.com/me?fields=user_id,username,followers_count,media_count&access_token=${encodeURIComponent(token)}`, {}, 'profile_failed');
      const id = str(body.user_id) || str(body.id);
      const username = str(body.username);
      if (!id || !username) throw new SocialError('profile_failed');
      return { externalId: id, handle: username, audience: num(body.followers_count), url: `https://www.instagram.com/${username}`,
        metrics: { posts: num(body.media_count) } };
    },
  },
  tiktok: {
    credentials: (e) => (e.TIKTOK_CLIENT_KEY && e.TIKTOK_CLIENT_SECRET ? { id: e.TIKTOK_CLIENT_KEY, secret: e.TIKTOK_CLIENT_SECRET } : null),
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    scope: 'user.info.basic,user.info.profile,user.info.stats',
    pkce: false,
    clientIdParam: 'client_key',
    exchange: (code, redirectUri, _verifier, c) =>
      tokenFrom('https://open.tiktokapis.com/v2/oauth/token/', { client_key: c.id, client_secret: c.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    async profile(token) {
      const body = await json('https://open.tiktokapis.com/v2/user/info/?fields=open_id,username,display_name,follower_count,likes_count,video_count',
        { headers: { authorization: `Bearer ${token}` } }, 'profile_failed');
      const u = ((body.data ?? {}) as { user?: Record<string, unknown> }).user ?? {};
      const id = str(u.open_id);
      const username = str(u.username) || str(u.display_name);
      if (!id || !username) throw new SocialError('profile_failed');
      return { externalId: id, handle: username, audience: num(u.follower_count), url: `https://www.tiktok.com/@${encodeURIComponent(str(u.username) || username)}`,
        metrics: { likes: num(u.likes_count), videos: num(u.video_count) } };
    },
  },
  reddit: {
    credentials: (e) => (e.REDDIT_CLIENT_ID && e.REDDIT_CLIENT_SECRET ? { id: e.REDDIT_CLIENT_ID, secret: e.REDDIT_CLIENT_SECRET } : null),
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    scope: 'identity',
    pkce: false,
    extraParams: { duration: 'temporary' },
    exchange: (code, redirectUri, _verifier, c) =>
      tokenFrom('https://www.reddit.com/api/v1/access_token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, { authorization: basic(c), 'user-agent': REDDIT_UA }),
    async profile(token) {
      const body = await json('https://oauth.reddit.com/api/v1/me', { headers: { authorization: `Bearer ${token}`, 'user-agent': REDDIT_UA } }, 'profile_failed');
      const id = str(body.id);
      const name = str(body.name);
      if (!id || !name) throw new SocialError('profile_failed');
      const subreddit = (body.subreddit ?? {}) as Record<string, unknown>;
      return { externalId: `t2_${id}`, handle: name, audience: num(subreddit.subscribers), url: `https://www.reddit.com/user/${name}`,
        metrics: { karma: num(body.total_karma) } };
    },
  },
};

export const isSocialPlatform = (value: string): value is SocialPlatform => (SOCIAL_PLATFORMS as readonly string[]).includes(value);

/** Networks the server can verify right now: their app credentials and the attestation key are set. */
export function configuredPlatforms(): SocialPlatform[] {
  const e = env();
  if (!e.SOCIAL_ATTESTATION_KEY) return [];
  return SOCIAL_PLATFORMS.filter((p) => ADAPTERS[p].credentials(e) !== null);
}

export const socialRedirectUri = (platform: SocialPlatform) => `${env().SITE_URL}/social/${platform}/callback`;

export interface SocialFlow { readonly platform: SocialPlatform; readonly state: string; readonly verifier: string }
export const SOCIAL_COOKIE = 'pf-social';

export function newSocialFlow(platform: SocialPlatform): SocialFlow {
  return { platform, state: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url') };
}

export function encodeSocialFlow(flow: SocialFlow): string {
  return Buffer.from(JSON.stringify(flow)).toString('base64url');
}

export function decodeSocialFlow(value: string | undefined): SocialFlow | null {
  if (!value) return null;
  try {
    const f = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SocialFlow>;
    return typeof f.platform === 'string' && isSocialPlatform(f.platform) && typeof f.state === 'string' && f.state.length >= 20 && typeof f.verifier === 'string'
      ? (f as SocialFlow) : null;
  } catch {
    return null;
  }
}

export function authorizeUrl(flow: SocialFlow): string | null {
  const adapter = ADAPTERS[flow.platform];
  const creds = adapter.credentials(env());
  if (!creds) return null;
  const params = new URLSearchParams({
    [adapter.clientIdParam ?? 'client_id']: creds.id,
    redirect_uri: socialRedirectUri(flow.platform),
    response_type: 'code',
    scope: adapter.scope,
    state: flow.state,
    ...(adapter.pkce ? { code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256' } : {}),
    ...adapter.extraParams,
  });
  return `${adapter.authorizeUrl}?${params.toString()}`;
}

/** Code → token → profile. The token is used once here and never stored. */
export async function fetchSocialProfile(flow: SocialFlow, code: string): Promise<SocialProfile> {
  const adapter = ADAPTERS[flow.platform];
  const creds = adapter.credentials(env());
  if (!creds) throw new SocialError('exchange_failed');
  const token = await adapter.exchange(code, socialRedirectUri(flow.platform), flow.verifier, creds);
  return adapter.profile(token);
}

export interface Attestation {
  readonly platform: SocialPlatform;
  readonly externalId: string;
  readonly handle: string;
  readonly audience: number;
  readonly url: string;
  readonly metrics: string;
  readonly issuedAt: number;
  readonly signature: string;
}

/** The exact string link_social_account() recomputes (…028), signed for one member. */
export function attest(userId: string, platform: SocialPlatform, p: SocialProfile, key: string, issuedAt = Math.floor(Date.now() / 1000)): Attestation {
  const handle = p.handle.slice(0, 100);
  const audience = Math.max(0, Math.floor(p.audience));
  const metrics = JSON.stringify(p.metrics);
  const message = ['pepforum-social-v1', userId, platform, p.externalId, handle, String(audience), p.url, metrics, String(issuedAt)].join('|');
  return { platform, externalId: p.externalId, handle, audience, url: p.url, metrics, issuedAt, signature: createHmac('sha256', key).update(message).digest('hex') };
}
