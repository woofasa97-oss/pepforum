import { IMAGE_CONTENT_TYPES, type MediaKind } from '@pepforum/database';
import { NextResponse } from 'next/server';

import { logUnexpected } from '@/lib/errors';
import { isSameOrigin } from '@/lib/same-origin';
import { getSupabase, getViewer } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Image and document uploads (…023). A route handler rather than a Server
 * Action because actions are capped at 256 KB. The flow is the database's:
 *   1. register_upload() decides whether this member may upload this kind,
 *      type and size, and names the object path;
 *   2. the bytes go to Storage *as the member* (the bucket policy accepts only
 *      the path just registered, once);
 *   3. confirm_upload() makes the row usable.
 * Same-origin only (Server Actions get that for free; here we check).
 *
 * Body: multipart form with `file` and `kind` (post_image | credential | ad_image).
 * Response: { id } or { error }.
 */
const KINDS: readonly MediaKind[] = ['post_image', 'credential', 'ad_image'];
const MAX_BYTES = 25_000_000;

/** Width and height from PNG/JPEG/WebP headers, if cheaply readable (no decoding). */
function imageSize(bytes: Uint8Array, type: string): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (type === 'image/png' && bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1] ?? 0;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
        }
        i += 2 + view.getUint16(i + 2);
      }
    }
    if (type === 'image/webp' && bytes.length > 30 && bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38) {
      if (bytes[15] === 0x58) return { width: 1 + (view.getUint32(24, true) & 0xffffff), height: 1 + (view.getUint32(27, true) & 0xffffff) };
      if (bytes[15] === 0x20) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
  } catch {
    return null;
  }
  return null;
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!(await getViewer())) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const kind = String(form.get('kind') ?? '') as MediaKind;
  const file = form.get('file');
  if (!KINDS.includes(kind) || !(file instanceof File)) return NextResponse.json({ error: 'invalid' }, { status: 400 });
  if (file.size === 0 || file.size > MAX_BYTES) return NextResponse.json({ error: 'file_too_large' }, { status: 413 });
  const type = file.type;
  const allowed = kind === 'credential' ? [...IMAGE_CONTENT_TYPES, 'application/pdf'] : [...IMAGE_CONTENT_TYPES];
  if (!allowed.includes(type)) return NextResponse.json({ error: 'unsupported_file_type' }, { status: 415 });

  const supabase = await getSupabase();
  const { data: registered, error: registerError } = await supabase.rpc('register_upload', { p_kind: kind, p_content_type: type, p_bytes: file.size });
  if (registerError || !registered) {
    if (registerError) logUnexpected('register_upload', registerError);
    const code = registerError?.code;
    const status = code === 'PF403' ? 403 : code === 'PF429' ? 429 : code === 'PF422' ? 422 : 500;
    return NextResponse.json({ error: registerError?.message ?? 'upload_failed', details: registerError?.details ?? null }, { status });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: storageError } = await supabase.storage.from(registered.bucket).upload(registered.path, bytes, { contentType: type, upsert: false });
  if (storageError) {
    console.error(JSON.stringify({ level: 'error', context: 'storage_upload', code: 'storage' }));
    return NextResponse.json({ error: 'upload_failed' }, { status: 502 });
  }

  const size = type === 'application/pdf' ? null : imageSize(bytes, type);
  const { error: confirmError } = await supabase.rpc('confirm_upload', { p_id: registered.id, p_width: size?.width ?? null, p_height: size?.height ?? null });
  if (confirmError) {
    logUnexpected('confirm_upload', confirmError);
    return NextResponse.json({ error: 'upload_failed' }, { status: 500 });
  }
  return NextResponse.json({ id: registered.id, width: size?.width ?? null, height: size?.height ?? null }, { headers: { 'cache-control': 'no-store' } });
}
