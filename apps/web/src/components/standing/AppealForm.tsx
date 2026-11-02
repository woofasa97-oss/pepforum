'use client';

import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { submitAppealAction } from '@/server/actions/moderation';

export function AppealForm({ modActionId, labels }: { modActionId: string; labels: { body: string; submit: string } }) {
  const [state, action] = useActionState(submitAppealAction, initialActionState);
  if (state.ok) return <FormMessage ok message={state.message} />;
  return (
    <form action={action} className="mt8">
      <FormMessage ok={false} message={state.message} />
      <input type="hidden" name="modActionId" value={modActionId} />
      <label className="vh" htmlFor={`appeal-${modActionId}`}>{labels.body}</label>
      <textarea id={`appeal-${modActionId}`} name="body" className="input" minLength={10} maxLength={2000} required placeholder={labels.body} style={{ minHeight: 60 }} />
      <SubmitButton className="btn sm mt8">{labels.submit}</SubmitButton>
    </form>
  );
}
