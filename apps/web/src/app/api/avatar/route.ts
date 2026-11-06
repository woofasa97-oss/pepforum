import { IMAGE_CONTENT_TYPES } from '@pepforum/database';
import sharp from 'sharp';

import { logUnexpected } from '@/lib/errors';
import { isSameOrigin } from '@/lib/same-origin';
import { getSupabase, getViewer } from '@/server/context';

export const dynamic = 'force-dynamic';

/**
 * Profile pictures (…027). A plain form post from Settings, so it works
 * without JavaScript, answered with a redirect back to Settings.
 *
 * Every picture is re-encoded here to a 256×256 WebP: that strips EXIF data
 * (a phone photo's GPS position, camera serial) and anything hidden in the
 * file, and keeps pictures small. Then the usual upload path of …023:
 * register_upload('avatar') → bytes to Storage as the member → confirm →
 * set_avatar(). The database decides who may do it and how often.
 */
const MAX_INPUT_BYTES = 10_000_000;
const SIZE = 256;

const back = (status: string) => new Response(null, { status: 303, headers: { Location: `/settings?avatar=${status}#picture` } });

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return new Response('Forbidden', { status: 403 });
  if (!(await getViewer())) return new Response(null, { status: 303, headers: { Location: '/auth/sign-in?next=/settings' } });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back('invalid');
  }
  const supabase = await getSupabase();

  if (form.get('action') === 'remove') {
    const { error } = await supabase.rpc('set_avatar', { p_media: null });
    if (error) {
      logUnexpected('set_avatar', error);
      return back(error.code === 'PF429' ? 'rate_limited' : 'failed');
    }
    return back('removed');
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return back('invalid');
  if (file.size > MAX_INPUT_BYTES) return back('too_large');
  if (!(IMAGE_CONTENT_TYPES as readonly string[]).includes(file.type)) return back('unsupported');

  let picture: Buffer;
  try {
    picture = await sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 40_000_000 })
      .rotate() // honour the camera's orientation before the EXIF goes
      .resize(SIZE, SIZE, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return back('unsupported');
  }

  const { data: registered, error: registerError } = await supabase.rpc('register_upload', { p_kind: 'avatar', p_content_type: 'image/webp', p_bytes: picture.length });
  if (registerError || !registered) {
    if (registerError) logUnexpected('register_upload', registerError);
    return back(registerError?.code === 'PF429' ? 'rate_limited' : registerError?.code === 'PF403' ? 'not_allowed' : 'failed');
  }
  const { error: storageError } = await supabase.storage.from(registered.bucket).upload(registered.path, picture, { contentType: 'image/webp', upsert: false });
  if (storageError) {
    console.error(JSON.stringify({ level: 'error', context: 'avatar_upload', code: 'storage' }));
    return back('failed');
  }
  const { error: confirmError } = await supabase.rpc('confirm_upload', { p_id: registered.id, p_width: SIZE, p_height: SIZE });
  const { error: setError } = confirmError ? { error: confirmError } : await supabase.rpc('set_avatar', { p_media: registered.id });
  if (setError) {
    logUnexpected('set_avatar', setError);
    return back(setError.code === 'PF429' ? 'rate_limited' : 'failed');
  }
  return back('saved');
}
