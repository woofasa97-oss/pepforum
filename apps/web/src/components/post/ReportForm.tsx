'use client';

import { REPORT_REASONS } from '@pepforum/database';
import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { reportAction } from '@/server/actions/content';

interface Props {
  readonly kind: 'post' | 'comment';
  readonly targetId: string;
  readonly labels: Record<string, string>;
}

/** Report popover built on <details>: works without JS, keyboard accessible. */
export function ReportForm({ kind, targetId, labels }: Props) {
  const [state, action] = useActionState(reportAction, initialActionState);
  return (
    <details className="popover">
      <summary>
        <Icon name="flag" />
        {labels['post.report']}
      </summary>
      <div className="popover-body">
        {state.ok ? (
          <FormMessage ok message={state.message} />
        ) : (
          <form action={action}>
            <FormMessage ok={false} message={state.message} />
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="targetId" value={targetId} />
            <fieldset className="field">
              <legend>{labels['report.reason']}</legend>
              <div className="col">
                {REPORT_REASONS.map((reason, i) => (
                  <label key={reason} className="radio-card">
                    <input type="radio" name="reason" value={reason} defaultChecked={i === 0} />
                    <span className="small">{labels[`report.reason.${reason}`]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor={`details-${targetId}`}>{labels['report.details']}</label>
              <textarea id={`details-${targetId}`} name="details" className="input" maxLength={500} style={{ minHeight: 60 }} />
            </div>
            <SubmitButton className="btn dark sm">{labels['report.submit']}</SubmitButton>
          </form>
        )}
      </div>
    </details>
  );
}
