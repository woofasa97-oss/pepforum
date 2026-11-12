import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/params';
import { resolvePriceLink } from '@/server/queries';

export const dynamic = 'force-dynamic';

const KINDS = { o: 'offer', v: 'vendor', c: 'coa' } as const;

/**
 * Click-through from a price page (…032): `o-<offer id>`, `v-<vendor slug>`
 * or `c-<certificate id>`. The database says where it goes (the store's own
 * page; plain links only, ADR-0009) and counts the click per vendor per day. No store address is ever rendered in a page, and no
 * referrer is sent.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const kind = KINDS[raw.slice(0, 1) as keyof typeof KINDS];
  const id = raw.slice(2);
  const wellFormed = raw.charAt(1) === '-' && (kind === 'vendor' ? /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length <= 60 : isUuid(id));
  if (!kind || !wellFormed) return new NextResponse('Not found', { status: 404 });
  const url = await resolvePriceLink(kind, id);
  if (!url || !/^https:\/\//.test(url)) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(null, {
    status: 302,
    headers: { Location: url, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}
