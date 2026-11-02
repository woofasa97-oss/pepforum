'use client';

import { type ReactNode, useActionState, useId } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { type ActionState, initialActionState } from '@/lib/action-state';

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

export interface ActionFormLabels {
  readonly reason: string;
  readonly reasonHint?: string;
}

/**
 * Every admin action looks the same: a plain button that opens an inline
 * panel stating the consequence, extra fields if any, a required reason (with
 * suggestions), and a confirm button. Works without JavaScript (<details> +
 * a server action); the reason is written to the moderation log.
 */
export function ActionForm({
  action, label, submit, consequence, hidden = {}, reasons = [], requireReason = true, tone = 'normal', labels, children, open = false,
}: {
  action: Action;
  label: string;
  submit: string;
  consequence?: string | undefined;
  hidden?: Readonly<Record<string, string>>;
  reasons?: readonly string[];
  requireReason?: boolean;
  tone?: 'normal' | 'danger' | 'primary';
  labels: ActionFormLabels;
  children?: ReactNode;
  open?: boolean;
}) {
  const [state, formAction] = useActionState(action, initialActionState);
  const id = useId();
  const buttonClass = tone === 'danger' ? 'btn sm danger' : tone === 'primary' ? 'btn sm dark' : 'btn sm';
  return (
    <details className="act" open={open || Boolean(state.message)}>
      <summary className={buttonClass}>{label}</summary>
      <form action={formAction} className="act-body">
        <FormMessage ok={state.ok} message={state.message} />
        {consequence ? <p className="small muted mb12">{consequence}</p> : null}
        {Object.entries(hidden).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        {children}
        {requireReason ? (
          <div className="field">
            <label htmlFor={`${id}-reason`}>{labels.reason}</label>
            <input id={`${id}-reason`} name="reason" className="input" list={reasons.length ? `${id}-reasons` : undefined}
              minLength={3} maxLength={500} required aria-describedby={labels.reasonHint ? `${id}-hint` : undefined} />
            {labels.reasonHint ? <span id={`${id}-hint`} className="hint">{labels.reasonHint}</span> : null}
            {reasons.length ? (
              <datalist id={`${id}-reasons`}>{reasons.map((r) => <option key={r} value={r} />)}</datalist>
            ) : null}
          </div>
        ) : null}
        <SubmitButton className={tone === 'danger' ? 'btn sm danger' : 'btn sm dark'}>{submit}</SubmitButton>
      </form>
    </details>
  );
}
