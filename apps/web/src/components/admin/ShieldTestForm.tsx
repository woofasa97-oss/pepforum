'use client';

import { useActionState } from 'react';

import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { shieldTestAction } from '@/server/actions/admin';

/** Dry run: paste text, see which rules it would trigger. Records nothing. */
export function ShieldTestForm({ labels }: { labels: { label: string; submit: string } }) {
  const [state, action] = useActionState(shieldTestAction, initialActionState);
  return (
    <form action={action}>
      <div className="field">
        <label htmlFor="shield-test">{labels.label}</label>
        <textarea id="shield-test" name="text" className="input" rows={3} maxLength={10000} required />
      </div>
      {state.message ? <div className={`banner ${state.ok ? 'ok' : 'warn'} mb12`} role="status">{state.message}</div> : null}
      <SubmitButton className="btn">{labels.submit}</SubmitButton>
    </form>
  );
}
