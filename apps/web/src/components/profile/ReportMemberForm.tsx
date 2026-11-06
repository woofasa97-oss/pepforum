'use client';

import { MEMBER_REPORT_REASONS } from '@pepforum/database';
import Link from 'next/link';
import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { reportMemberAction } from '@/server/actions/content';

/**
 * "Report member" on a profile. Goes to the admins, not to zone moderators,
 * and never collapses anything. Built on <details>: works without JS.
 */
export function ReportMemberForm({ username, labels }: { username: string; labels: Record<string, string> }) {
  const [state, action] = useActionState(reportMemberAction, initialActionState);
  return (
    <details className="popover end">
      <summary>
        <Icon name="flag" />
        {labels['memberReport.open']}
      </summary>
      <div className="popover-body">
        {state.ok ? (
          <FormMessage ok message={state.message} />
        ) : (
          <form action={action}>
            <p className="xs muted mb8">{labels['memberReport.intro']}</p>
            <FormMessage ok={false} message={state.message} />
            <input type="hidden" name="username" value={username} />
            <fieldset className="field">
              <legend>{labels['memberReport.reason']}</legend>
              <div className="col">
                {MEMBER_REPORT_REASONS.map((reason, i) => (
                  <label key={reason} className="radio-card">
                    <input type="radio" name="reason" value={reason} defaultChecked={i === 0} />
                    <span className="small">{labels[`memberReport.reason.${reason}`]}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="member-report-details">{labels['memberReport.details']}</label>
              <textarea id="member-report-details" name="details" className="input" maxLength={1000} style={{ minHeight: 70 }}
                aria-describedby="member-report-hint" />
              <span id="member-report-hint" className="xs faint">{labels['memberReport.detailsHint']}</span>
            </div>
            <SubmitButton className="btn dark sm">{labels['memberReport.submit']}</SubmitButton>
            <p className="xs mt8">
              <Link className="link" href={`/contact/new?kind=report_member&user=${encodeURIComponent(username)}`}>{labels['memberReport.ticket']}</Link>
            </p>
          </form>
        )}
      </div>
    </details>
  );
}
