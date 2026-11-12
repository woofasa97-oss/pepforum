import 'server-only';

import { env } from '@/lib/env';

/**
 * SEO helpers (ported from the prototype's src/lib/seo.ts and sitemaps.ts).
 * Everything public is derived from SITE_URL; nothing here reads member data.
 */

/** Absolute URL for a site-relative path. */
export function absoluteUrl(path: string): string {
  return new URL(path, env().SITE_URL).toString();
}

/** Public routes that aren't in the database (zones and categories are added by the caller). */
export const STATIC_PATHS = ['/', '/notes', '/transparency', '/advertise', '/legal/terms', '/legal/privacy', '/legal/content-policy', '/legal/community-notes', '/legal/loi-25'] as const;

const escapeXml = (value: string): string =>
  value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c);

export function urlsetXml(entries: ReadonlyArray<{ path: string; updated_at?: string | null }>): string {
  const items = entries
    .map((e) => `<url><loc>${escapeXml(absoluteUrl(e.path))}</loc>${e.updated_at ? `<lastmod>${e.updated_at.slice(0, 10)}</lastmod>` : ''}</url>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</urlset>`;
}

export function sitemapIndexXml(paths: readonly string[]): string {
  const items = paths.map((p) => `<sitemap><loc>${escapeXml(absoluteUrl(p))}</loc></sitemap>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${items}</sitemapindex>`;
}

/** Serialises JSON-LD for a <script type="application/ld+json"> text child (no HTML can break out). */
export function jsonLd(data: Record<string, unknown>): string {
  return JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c');
}

export function organizationJsonLd(): Record<string, unknown> {
  return {
    '@type': 'Organization',
    name: 'Pepforums',
    url: absoluteUrl('/'),
    logo: absoluteUrl('/icon.png'),
  };
}

export function websiteJsonLd(): Record<string, unknown> {
  return {
    '@type': 'WebSite',
    name: 'Pepforums',
    url: absoluteUrl('/'),
    inLanguage: ['en-CA', 'fr-CA'],
  };
}

export function discussionJsonLd(post: {
  id: string; title: string; body: string; author_username: string; created_at: string; edited_at: string | null; language: string;
  comment_count: number; score: number;
}): Record<string, unknown> {
  return {
    '@type': 'DiscussionForumPosting',
    '@id': absoluteUrl(`/post/${post.id}`),
    url: absoluteUrl(`/post/${post.id}`),
    headline: post.title,
    text: post.body.slice(0, 1000),
    inLanguage: post.language === 'fr' ? 'fr-CA' : 'en-CA',
    datePublished: post.created_at,
    ...(post.edited_at ? { dateModified: post.edited_at } : {}),
    author: { '@type': 'Person', name: `u/${post.author_username}`, url: absoluteUrl(`/u/${post.author_username}`) },
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.comment_count },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: Math.max(0, post.score) },
    ],
    isPartOf: { '@type': 'WebSite', url: absoluteUrl('/') },
  };
}
