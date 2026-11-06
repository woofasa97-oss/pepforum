'use client';

import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { type ActionState, initialActionState } from '@/lib/action-state';

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

/**
 * A one-click admin action for low-risk, frequent decisions (approving a
 * link). The server action supplies a standard reason for the moderation log.
 * Anything with consequences for a member uses ActionForm, which asks for one.
 */
export function QuickAction({ action, label, hidden, tone = 'normal' }: {
  action: Action;
  label: string;
  hidden: Readonly<Record<string, string>>;
  tone?: 'normal' | 'primary';
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  return (
    <form action={formAction} className="quick-act">
      {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <SubmitButton className={tone === 'primary' ? 'btn sm dark' : 'btn sm'}>{label}</SubmitButton>
      {state.ok ? null : <FormMessage ok={state.ok} message={state.message} />}
    </form>
  );
}
