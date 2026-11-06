'use client';

import { POST_TYPES, type PostType } from '@pepforum/database';
import { useActionState, useState } from 'react';

import { ImageUploader, type UploadedImage } from '@/components/media/ImageUploader';
import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { createPostAction, editPostAction } from '@/server/actions/content';

interface Option {
  readonly id: string;
  readonly name: string;
  readonly zoneId?: string;
}

interface Props {
  readonly labels: Record<string, string>;
  readonly zones: Option[];
  readonly cities: Option[];
  readonly categories: Option[];
  readonly locale: 'en' | 'fr';
  /** Why link posts are locked ("Requires Member"), or null when allowed. */
  readonly linkRequirement: string | null;
  /** Links wait for an admin (links.require_approval). */
  readonly linkReview: boolean;
  readonly defaults?: { zone?: string | undefined; category?: string | undefined };
  /** Present when editing an existing post. */
  readonly edit?: { postId: string; title: string; body: string; link: string | null; type: PostType; images?: UploadedImage[] };
  /** Why images are locked ("Requires Trusted"), or null when allowed (…023). */
  readonly uploadRequirement?: string | null;
  readonly maxImages?: number;
}

export function PostForm({ labels, zones, cities, categories, locale, linkRequirement, linkReview, defaults, edit, uploadRequirement = null, maxImages = 4 }: Props) {
  const canPostLinks = linkRequirement === null;
  const [state, action] = useActionState(edit ? editPostAction : createPostAction, initialActionState);
  const [zone, setZone] = useState(defaults?.zone ?? 'national');
  const [type, setType] = useState<PostType>(edit?.type ?? 'question');
  const errors = state.fieldErrors ?? {};
  const zoneCities = cities.filter((c) => c.zoneId === zone);
  const showLink = type === 'resource' || Boolean(edit?.link);

  return (
    <form action={action} className="card card-p">
      <FormMessage ok={state.ok} message={state.message} />
      {edit ? <input type="hidden" name="postId" value={edit.postId} /> : null}

      {!edit ? (
        <>
          <div className="row wrap" style={{ gap: 12, alignItems: 'flex-start' }}>
            {zones.length > 1 ? (
              <div className="field grow">
                <label htmlFor="pf-zone">{labels['submit.zone']}</label>
                <select id="pf-zone" name="zone" className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
                  {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
                </select>
              </div>
            ) : (
              // Regions are hidden: everything posts to the national feed.
              <input type="hidden" name="zone" value={zones[0]?.id ?? 'national'} />
            )}
            {zoneCities.length > 0 ? (
              <div className="field grow">
                <label htmlFor="pf-city">{labels['submit.city']}</label>
                <select id="pf-city" name="city" className="input" defaultValue="">
                  <option value="">{labels['submit.wholeZone']}</option>
                  {zoneCities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ) : null}
            <div className="field grow">
              <label htmlFor="pf-category">{labels['submit.category']}</label>
              <select id="pf-category" name="category" className="input" defaultValue={defaults?.category ?? categories[0]?.id} aria-invalid={Boolean(errors.category)}>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <fieldset className="field">
            <legend>{labels['submit.type']}</legend>
            <div className="col">
              {POST_TYPES.map((pt) => (
                <label key={pt} className="radio-card">
                  <input type="radio" name="type" value={pt} checked={type === pt} disabled={pt === 'resource' && !canPostLinks}
                    onChange={() => setType(pt)} />
                  <span>
                    <span className="small bold">{labels[`post.type.${pt}`]}</span>
                    <span className="xs faint" style={{ display: 'block' }}>
                      {labels[`submit.type.${pt}Hint`]}{pt === 'resource' && linkRequirement ? ` · ${linkRequirement}` : null}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : null}

      <div className="field">
        <label htmlFor="pf-title">{labels['submit.postTitle']}</label>
        <input id="pf-title" name="title" className="input" minLength={8} maxLength={140} required defaultValue={edit?.title}
          aria-invalid={Boolean(errors.title)} aria-describedby="pf-title-hint" />
        <span id="pf-title-hint" className="hint">{labels['submit.titleHint']}</span>
        <FieldError message={errors.title} />
      </div>

      <div className="field">
        <label htmlFor="pf-body">{labels['submit.body']}</label>
        <textarea id="pf-body" name="body" className="input" maxLength={10000} defaultValue={edit?.body} aria-invalid={Boolean(errors.body)}
          aria-describedby={linkReview ? 'pf-body-hint' : undefined} />
        {linkReview ? <span id="pf-body-hint" className="hint">{labels['submit.linkReview']}</span> : null}
        <FieldError message={errors.body} />
      </div>

      {uploadRequirement === null ? (
        <>
          {edit ? <input type="hidden" name="mediaForm" value="1" /> : null}
          <ImageUploader kind="post_image" idField="mediaIds" altField="mediaAlts" max={maxImages} initial={edit?.images ?? []} labels={labels} />
        </>
      ) : uploadRequirement ? (
        <p className="xs faint mb12">{labels['media.images']}: {uploadRequirement}</p>
      ) : null}

      {showLink && canPostLinks ? (
        <div className="field">
          <label htmlFor="pf-link">{labels['submit.link']}</label>
          <input id="pf-link" name="link" type="url" className="input" placeholder="https://" pattern="https://.+" defaultValue={edit?.link ?? ''}
            required={type === 'resource'} aria-invalid={Boolean(errors.link)} />
          <FieldError message={errors.link} />
        </div>
      ) : null}

      {!edit ? (
        <>
          <input type="hidden" name="language" value={locale} />
          <label className="check mb16">
            <input type="checkbox" name="ack" required />
            <span>{labels['submit.ack']}</span>
          </label>
        </>
      ) : null}

      <SubmitButton>{edit ? labels['submit.save'] : labels['submit.publish']}</SubmitButton>
    </form>
  );
}
