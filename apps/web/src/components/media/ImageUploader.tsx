'use client';

import { useId, useRef, useState } from 'react';

export interface UploadedImage {
  readonly id: string;
  readonly alt: string;
}

interface Props {
  readonly kind: 'post_image' | 'credential' | 'ad_image';
  /** Hidden-input names the surrounding form reads (repeated per image). */
  readonly idField: string;
  readonly altField?: string;
  readonly max: number;
  readonly initial?: readonly UploadedImage[];
  readonly accept?: string;
  readonly labels: Record<string, string>;
}

/**
 * Uploads through POST /api/upload (…023) and reports the resulting ids to
 * the surrounding form as hidden inputs, so the Server Action that creates or
 * edits the post attaches them. Works without JavaScript in the sense that
 * the form still submits; uploading itself needs the browser.
 */
export function ImageUploader({ kind, idField, altField, max, initial = [], accept = 'image/jpeg,image/png,image/webp', labels }: Props) {
  const [images, setImages] = useState<UploadedImage[]>([...initial]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const isDocument = kind === 'credential';

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files).slice(0, Math.max(0, max - images.length))) {
        const body = new FormData();
        body.append('kind', kind);
        body.append('file', file);
        const response = await fetch('/api/upload', { method: 'POST', body, credentials: 'same-origin' });
        const json = (await response.json().catch(() => ({}))) as { id?: string; error?: string; details?: string | null };
        if (!response.ok || !json.id) {
          const key = json.error === 'file_too_large' ? 'tooLarge' : json.error === 'unsupported_file_type' ? 'type' : json.error === 'capability_denied' ? 'denied' : json.error === 'rate_limited' ? 'rateLimited' : 'failed';
          setError(labels[`media.err.${key}`] ?? labels['media.err.failed'] ?? 'Upload failed');
          break;
        }
        setImages((current) => [...current, { id: json.id as string, alt: '' }]);
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="field">
      <span className="small bold" id={`${id}-label`}>{isDocument ? labels['media.document'] : labels['media.images']}</span>
      <span className="hint" id={`${id}-hint`}>{isDocument ? labels['media.documentHint'] : labels['media.imagesHint']?.replace('{n}', String(max))}</span>
      {images.length > 0 ? (
        <ul className="media-tray" aria-labelledby={`${id}-label`}>
          {images.map((image, index) => (
            <li key={image.id} className="media-item">
              {isDocument ? (
                <a className="link small" href={`/media/${image.id}`} target="_blank" rel="noopener noreferrer">{labels['media.viewDocument']}</a>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- served from this origin, dimensions vary
                <img src={`/media/${image.id}`} alt={image.alt} />
              )}
              <input type="hidden" name={idField} value={image.id} />
              {altField && !isDocument ? (
                <input
                  type="text"
                  name={altField}
                  className="input"
                  placeholder={labels['media.alt']}
                  aria-label={labels['media.alt']}
                  maxLength={300}
                  defaultValue={image.alt}
                  onChange={(e) => setImages((current) => current.map((x, i) => (i === index ? { ...x, alt: e.target.value } : x)))}
                />
              ) : null}
              <button type="button" className="btn sm" onClick={() => setImages((current) => current.filter((x) => x.id !== image.id))}>
                {labels['media.remove']}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {images.length < max ? (
        <label className="btn sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          <input ref={inputRef} type="file" accept={accept} multiple={max > 1 && !isDocument} disabled={busy} style={{ display: 'none' }}
            aria-describedby={`${id}-hint`} onChange={(e) => void upload(e.target.files)} />
          {busy ? labels['media.uploading'] : isDocument ? labels['media.chooseDocument'] : labels['media.add']}
        </label>
      ) : null}
      {error ? <span className="err-msg" role="alert">{error}</span> : null}
    </div>
  );
}
