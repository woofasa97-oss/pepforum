import { NextResponse } from 'next/server';

import { sitemapIndexXml } from '@/lib/seo';
import { getPricesEnabled, getSitemapCounts } from '@/server/queries';

export const dynamic = 'force-dynamic';

/**
 * Sitemap index: one static sitemap plus one page per 5,000 posts, helpful
 * notes and public profiles (sitemap_counts, migration …021).
 */
export async function GET() {
  const [counts, prices] = await Promise.all([getSitemapCounts(), getPricesEnabled()]);
  const paths = ['/sitemaps/pages', ...(prices ? ['/sitemaps/prices'] : [])];
  for (const kind of ['posts', 'notes', 'profiles'] as const) {
    const pages = counts ? Math.max(1, Math.ceil(counts[kind] / counts.page_size)) : 1;
    for (let page = 0; page < pages; page += 1) paths.push(`/sitemaps/${kind}${page ? `?page=${page}` : ''}`);
  }
  return new NextResponse(sitemapIndexXml(paths), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
