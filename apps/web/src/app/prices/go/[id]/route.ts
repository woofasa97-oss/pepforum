import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/params';
import { resolvePriceLink } from '@/server/queries';

export const dynamic = 'force-dynamic';

const KINDS = { o: 'offer', v: 'vendor', c: 'coa', s: 'store', e: 'evidence', l: 'lab', p: 'listing', d: 'document' } as const;
const BY_SLUG = new Set(['vendor', 'store', 'lab']);

/**
 * Click-through from a price page (…032): `o-<offer id>`, `v-<vendor slug>`
 * or `c-<certificate id>`; from the Stores directory (…035): `s-<store slug>`,
 * `e-<audit check id>` (the page a finding quotes), `l-<lab slug>`, `p-<listing id>`
 * (a product page) or `d-<document id>` (a certificate the store links). The database says where it goes (the store's own
 * page; plain links only, ADR-0009) and counts the click per vendor per day. No store address is ever rendered in a page, and no
 * referrer is sent.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const kind = KINDS[raw.slice(0, 1) as keyof typeof KINDS];
  const id = raw.slice(2);
  const wellFormed = raw.charAt(1) === '-' && (BY_SLUG.has(kind) ? /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && id.length <= 60 : isUuid(id));
  if (!kind || !wellFormed) return new NextResponse('Not found', { status: 404 });
  const url = await resolvePriceLink(kind, id);
  if (!url || !/^https:\/\//.test(url)) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(null, {
    status: 302,
    headers: { Location: url, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}
