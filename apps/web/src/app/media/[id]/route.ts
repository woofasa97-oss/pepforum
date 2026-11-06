import { NextResponse } from 'next/server';

import { isUuid } from '@/lib/params';
import { getMediaAccess } from '@/server/queries';
import { getSupabase } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Serves an upload's bytes (…023). The database decides who may see which
 * file (get_media_access); the download then happens as the viewer, so the
 * Storage policy enforces the same rule a second time. Keeping images on
 * this origin keeps CSP img-src at 'self' and the browser away from Supabase.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return new NextResponse('Not found', { status: 404 });
  const access = await getMediaAccess(id);
  if (!access) return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'private, no-store' } });

  const supabase = await getSupabase();
  const { data, error } = await supabase.storage.from(access.bucket).download(access.path);
  if (error || !data) return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'private, no-store' } });

  return new NextResponse(data.stream(), {
    headers: {
      'content-type': access.content_type,
      'content-disposition': access.kind === 'credential' ? 'attachment' : 'inline',
      'x-content-type-options': 'nosniff',
      // Public images may be cached by browsers; private files never.
      'cache-control': access.public ? 'public, max-age=86400, stale-while-revalidate=604800' : 'private, no-store',
    },
  });
}
