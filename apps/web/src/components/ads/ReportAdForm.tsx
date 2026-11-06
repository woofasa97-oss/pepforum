'use client';

import { AD_REPORT_REASONS } from '@pepforum/database';
import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { reportAdAction } from '@/server/actions/features';

export function ReportAdForm({ campaignId, labels }: { campaignId: string; labels: Record<string, string> }) {
  const [state, action] = useActionState(reportAdAction, initialActionState);
  return (
    <details className="popover">
      <summary className="xs faint" style={{ cursor: 'pointer' }}>{labels['ads.report']}</summary>
      <form action={action} className="popover-body">
        <FormMessage ok={state.ok} message={state.message} />
        {state.ok ? null : (
          <>
            <p className="xs muted mb8">{labels['ads.reportIntro']}</p>
            <input type="hidden" name="id" value={campaignId} />
            <div className="field">
              <label htmlFor={`adr-${campaignId}`}>{labels['ads.reportReason']}</label>
              <select id={`adr-${campaignId}`} name="reason" className="input" defaultValue="vendor">
                {AD_REPORT_REASONS.map((r) => <option key={r} value={r}>{labels[`ads.reportReason.${r}`]}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`add-${campaignId}`}>{labels['ads.reportDetails']}</label>
              <textarea id={`add-${campaignId}`} name="details" className="input" maxLength={500} style={{ minHeight: 60 }} />
            </div>
            <SubmitButton className="btn sm dark">{labels['ads.reportSubmit']}</SubmitButton>
          </>
        )}
      </form>
    </details>
  );
}
