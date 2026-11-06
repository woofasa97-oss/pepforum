'use client';

import type { TicketKind } from '@pepforum/database';
import { useActionState, useState } from 'react';

import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { openTicketAction } from '@/server/actions/support';

import type { TicketFormLabelKey } from './ticket-form-labels';

/**
 * A new ticket to the team. Report kinds ask what it's about: a username for
 * a member, a link for a post or comment (or the page where a bug happened).
 * Fields are controlled so nothing typed is lost if sending fails.
 */
export function TicketForm({ kind, labels, defaultUser = '' }: {
  kind: TicketKind;
  labels: Record<TicketFormLabelKey, string>;
  defaultUser?: string;
}) {
  const [state, action] = useActionState(openTicketAction, initialActionState);
  const [values, setValues] = useState({ aboutUsername: defaultUser, aboutUrl: '', subject: '', body: '' });
  const set = (name: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [name]: e.target.value }));
  const errors = state.fieldErrors ?? {};
  const urlLabel = kind === 'report_content' ? labels['contact.form.contentUrl'] : labels['contact.form.pageUrl'];

  return (
    <form action={action} className="card card-p">
      <FormMessage ok={false} message={state.ok ? undefined : state.message} />
      <input type="hidden" name="kind" value={kind} />

      {kind === 'report_member' ? (
        <div className="field">
          <label htmlFor="tf-user">{labels['contact.form.username']}</label>
          <input id="tf-user" name="aboutUsername" className="input" required pattern="[A-Za-z0-9_]{3,20}" autoComplete="off"
            value={values.aboutUsername} onChange={set('aboutUsername')} aria-invalid={Boolean(errors.aboutUsername)} aria-describedby="tf-user-hint" />
          <span id="tf-user-hint" className="hint">{labels['contact.form.usernameHint']}</span>
          <FieldError message={errors.aboutUsername ? labels['contact.form.usernameError'] : undefined} />
        </div>
      ) : null}

      {kind === 'report_content' || kind === 'bug' ? (
        <div className="field">
          <label htmlFor="tf-url">{urlLabel}</label>
          <input id="tf-url" name="aboutUrl" type="url" className="input" inputMode="url" maxLength={500} pattern="https://\S+"
            placeholder="https://pepforum.ca/…" value={values.aboutUrl} onChange={set('aboutUrl')} aria-invalid={Boolean(errors.aboutUrl)}
            aria-describedby="tf-url-hint" />
          <span id="tf-url-hint" className="hint">{labels['contact.form.urlHint']}</span>
          <FieldError message={errors.aboutUrl ? labels['contact.form.urlError'] : undefined} />
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="tf-subject">{labels['contact.form.subject']}</label>
        <input id="tf-subject" name="subject" className="input" required minLength={3} maxLength={120}
          value={values.subject} onChange={set('subject')} aria-invalid={Boolean(errors.subject)} />
        <FieldError message={errors.subject ? labels['contact.form.subjectError'] : undefined} />
      </div>

      <div className="field">
        <label htmlFor="tf-body">{labels['contact.form.body']}</label>
        <textarea id="tf-body" name="body" className="input" required minLength={10} maxLength={4000} style={{ minHeight: 160 }}
          value={values.body} onChange={set('body')} aria-invalid={Boolean(errors.body)} aria-describedby="tf-body-hint" />
        <span id="tf-body-hint" className="hint">{labels[`contact.form.bodyHint.${kind}`]}</span>
        <FieldError message={errors.body ? labels['contact.form.bodyError'] : undefined} />
      </div>

      <p className="xs faint mb12">{labels['contact.form.privacy']}</p>
      <SubmitButton className="btn red">{labels['contact.form.submit']}</SubmitButton>
    </form>
  );
}
