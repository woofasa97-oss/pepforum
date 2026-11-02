'use client';

import { useActionState } from 'react';

import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { findByEmailAction } from '@/server/actions/admin';

/**
 * Exact-email lookup, POSTed so the address never lands in a URL, browser
 * history or access log. The database records that a lookup happened.
 */
export function FindByEmailForm({ labels }: { labels: { label: string; hint: string; submit: string } }) {
  const [state, action] = useActionState(findByEmailAction, initialActionState);
  return (
    <form action={action} className="row wrap" style={{ gap: 8, alignItems: 'flex-start' }}>
      <div className="field" style={{ margin: 0, minWidth: 240, flex: 1 }}>
        <label className="vh" htmlFor="find-email">{labels.label}</label>
        <input id="find-email" name="email" type="email" className="input" placeholder={labels.label} autoComplete="off" required
          aria-describedby="find-email-hint" />
        <span id="find-email-hint" className="hint">{labels.hint}</span>
        <FieldError message={state.fieldErrors?.email} />
        <FormMessage ok={state.ok} message={state.message} />
      </div>
      <SubmitButton className="btn">{labels.submit}</SubmitButton>
    </form>
  );
}
