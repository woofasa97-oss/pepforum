'use client';

import { NOTE_CLASSIFICATIONS } from '@pepforum/database';
import { useActionState, useState } from 'react';

import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { proposeNoteAction } from '@/server/actions/notes';

interface Props {
  readonly postId: string;
  readonly locale: 'en' | 'fr';
  readonly labels: Record<string, string>;
}

export function ProposeNoteForm({ postId, locale, labels }: Props) {
  const [state, action] = useActionState(proposeNoteAction, initialActionState);
  const [sourceCount, setSourceCount] = useState(1);
  const [length, setLength] = useState(0);

  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="language" value={locale} />

      <fieldset className="field">
        <legend>{labels['propose.classification']}</legend>
        <div className="col">
          {NOTE_CLASSIFICATIONS.map((c, i) => (
            <label key={c} className="radio-card">
              <input type="radio" name="classification" value={c} defaultChecked={i === 1} required />
              <span className="small bold">{labels[`notes.classification.${c}`]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="banner info mb16">{labels['propose.strikeWarning']}</div>

      <div className="field">
        <label htmlFor="note-body">{labels['propose.body']}</label>
        <textarea id="note-body" name="body" className="input" minLength={20} maxLength={500} required
          aria-invalid={Boolean(state.fieldErrors?.body)} aria-describedby="note-body-hint"
          onChange={(e) => setLength(e.currentTarget.value.length)} />
        <span id="note-body-hint" className="hint">{labels['propose.bodyHint']} ({length}/500)</span>
        <FieldError message={state.fieldErrors?.body} />
      </div>

      <fieldset className="field">
        <legend>{labels['propose.sources']}</legend>
        {Array.from({ length: sourceCount }, (_, i) => (
          <input key={i} name="sourceUrl" type="url" className="input mb8" placeholder="https://" inputMode="url"
            pattern="https://.+\..+/.+" required={i === 0} aria-label={`${labels['propose.sources']} ${i + 1}`}
            aria-invalid={Boolean(state.fieldErrors?.sources)} />
        ))}
        <FieldError message={state.fieldErrors?.sources ? labels['errors.invalid_source_url'] : undefined} />
        {sourceCount < 5 ? (
          <button type="button" className="btn sm" onClick={() => setSourceCount((n) => n + 1)}>{labels['propose.addSource']}</button>
        ) : null}
      </fieldset>

      <SubmitButton>{labels['propose.submit']}</SubmitButton>
    </form>
  );
}
