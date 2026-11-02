import { NextResponse } from 'next/server';

import { getSupabase, getViewer } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Personal-data export (PIPEDA / Loi 25 access right). Same-origin only and
 * never cached: the response contains the member's email and full history.
 */
export async function GET(request: Request) {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!(await getViewer())) {
    return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });
  }

  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc('export_my_data');
  if (error) {
    const status = error.code === 'PF429' ? 429 : 500;
    return NextResponse.json({ error: status === 429 ? 'rate_limited' : 'export_failed' }, { status });
  }

  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="pepforum-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'cache-control': 'private, no-store, max-age=0',
    },
  });
}
