'use client';

import { useActionState, useState } from 'react';

import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { type ActionState, initialActionState } from '@/lib/action-state';

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * Reply box under a ticket thread, for members and admins alike. Admins also
 * get "close the ticket after sending". The text is kept if sending fails.
 */
export function TicketReplyForm({ action, ticketId, labels, closeLabel }: {
  action: Action;
  ticketId: string;
  labels: { label: string; submit: string; hint?: string };
  closeLabel?: string;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const [body, setBody] = useState('');
  // Clear the box once a reply is sent (adjusting state on a new result, not in an effect).
  const [lastState, setLastState] = useState(state);
  if (state !== lastState) {
    setLastState(state);
    if (state.ok) setBody('');
  }

  const id = `reply-${ticketId}`;
  return (
    <form action={formAction} className="card card-p">
      <FormMessage ok={state.ok} message={state.message} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <div className="field">
        <label htmlFor={id}>{labels.label}</label>
        <textarea id={id} name="body" className="input" maxLength={4000} required style={{ minHeight: 110 }}
          value={body} onChange={(e) => setBody(e.target.value)} aria-invalid={Boolean(state.fieldErrors?.body)}
          aria-describedby={labels.hint ? `${id}-hint` : undefined} />
        {labels.hint ? <span id={`${id}-hint`} className="hint">{labels.hint}</span> : null}
        <FieldError message={state.fieldErrors?.body} />
      </div>
      <div className="row between wrap" style={{ gap: 8 }}>
        {closeLabel ? (
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" name="close" />
            {closeLabel}
          </label>
        ) : <span />}
        <SubmitButton className="btn dark sm">{labels.submit}</SubmitButton>
      </div>
    </form>
  );
}
