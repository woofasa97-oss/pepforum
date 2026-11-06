import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/params';
import { getSupabase } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Ad click-through (…025): counts the click and sends the visitor to the
 * landing page the admin approved. The campaign id, not the URL, is in the
 * page, so no landing URL is ever rendered raw, and no referrer is sent.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new NextResponse('Not found', { status: 404 });
  const supabase = await getSupabase();
  const { data: url, error } = await supabase.rpc('ad_click', { p_id: id });
  if (error || !url || !/^https:\/\//.test(url)) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(null, { status: 302, headers: { Location: url, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' } });
}
