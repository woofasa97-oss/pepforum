import { NextResponse } from 'next/server';

import { STATIC_PATHS, urlsetXml } from '@/lib/seo';
import { getPriceCatalog, getSitemapEntries, getTaxonomy } from '@/server/queries';

export const dynamic = 'force-dynamic';

const KINDS = ['pages', 'posts', 'notes', 'profiles', 'prices'] as const;
type Kind = (typeof KINDS)[number];

/** One sitemap: static pages (with categories) or a page of database entries. */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!KINDS.includes(kind as Kind)) return new NextResponse('Not found', { status: 404 });
  const page = Math.max(0, Math.min(1000, Number(new URL(request.url).searchParams.get('page') ?? 0) || 0));

  let entries: Array<{ path: string; updated_at?: string | null }>;
  if (kind === 'pages') {
    const taxonomy = await getTaxonomy();
    entries = [
      ...STATIC_PATHS.map((path) => ({ path })),
      ...taxonomy.categories.map((c) => ({ path: `/category/${c.id}` })),
    ];
  } else if (kind === 'prices') {
    // Price pages (…033): empty while the section is off. Only compounds and vendors with published offers.
    const catalog = await getPriceCatalog();
    const updated_at = catalog?.publication?.published_at ?? null;
    const listed = new Set(catalog?.offers.map((o) => o.compound));
    entries = catalog ? [
      { path: '/prices', updated_at },
      { path: '/prices/vendors', updated_at },
      ...catalog.compounds.filter((c) => listed.has(c.slug)).map((c) => ({ path: `/prices/${c.slug}`, updated_at })),
      ...catalog.vendors.map((v) => ({ path: `/prices/vendor/${v.slug}`, updated_at })),
    ] : [];
  } else {
    entries = await getSitemapEntries(kind as Exclude<Kind, 'pages' | 'prices'>, page);
  }
  return new NextResponse(urlsetXml(entries), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
