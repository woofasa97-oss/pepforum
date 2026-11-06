import { NextResponse } from 'next/server';

import { STATIC_PATHS, urlsetXml } from '@/lib/seo';
import { getSitemapEntries, getTaxonomy } from '@/server/queries';

export const dynamic = 'force-dynamic';

const KINDS = ['pages', 'posts', 'notes', 'profiles'] as const;
type Kind = (typeof KINDS)[number];

/** One sitemap: static pages (with zones and categories) or a page of database entries. */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (!KINDS.includes(kind as Kind)) return new NextResponse('Not found', { status: 404 });
  const page = Math.max(0, Math.min(1000, Number(new URL(request.url).searchParams.get('page') ?? 0) || 0));

  let entries: Array<{ path: string; updated_at?: string | null }>;
  if (kind === 'pages') {
    const taxonomy = await getTaxonomy();
    entries = [
      ...STATIC_PATHS.map((path) => ({ path })),
      ...taxonomy.zones.filter((z) => taxonomy.regions && z.id !== 'national').map((z) => ({ path: `/zone/${z.id}` })),
      ...taxonomy.categories.map((c) => ({ path: `/category/${c.id}` })),
    ];
  } else {
    entries = await getSitemapEntries(kind as Exclude<Kind, 'pages'>, page);
  }
  return new NextResponse(urlsetXml(entries), {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
