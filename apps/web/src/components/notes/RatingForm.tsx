'use client';

import { RATING_REASONS, RATING_VALUES, type RatingValue } from '@pepforum/database';
import { useActionState, useState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { rateNoteAction } from '@/server/actions/notes';

interface Props {
  readonly noteId: string;
  readonly current: { value: RatingValue; reasons: string[] } | null;
  readonly labels: Record<string, string>;
}

const ICON = { helpful: 'thumbup', somewhat: 'info', not_helpful: 'thumbdown' } as const;

export function RatingForm({ noteId, current, labels }: Props) {
  const [state, action] = useActionState(rateNoteAction, initialActionState);
  const [value, setValue] = useState<RatingValue | null>(current?.value ?? null);

  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      <input type="hidden" name="noteId" value={noteId} />
      <fieldset className="field">
        <legend>{labels['rate.title']}</legend>
        <div className="rate-opts">
          {RATING_VALUES.map((v) => (
            <label key={v}>
              <input type="radio" name="value" value={v} checked={value === v} onChange={() => setValue(v)} required />
              <Icon name={ICON[v]} />
              {labels[`rate.${v}`]}
            </label>
          ))}
        </div>
      </fieldset>
      {value ? (
        <fieldset className="field">
          <legend>{labels['rate.why']}</legend>
          <div className="reasons">
            {RATING_REASONS[value].map((reason) => (
              <label key={`${value}-${reason}`}>
                <input type="checkbox" name="reasons" value={reason} defaultChecked={current?.value === value && current.reasons.includes(reason)} />
                {labels[`rate.reason.${reason}`]}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <p className="xs faint mb12">{labels['rate.private']}</p>
      <SubmitButton>{labels['rate.submit']}</SubmitButton>
    </form>
  );
}
