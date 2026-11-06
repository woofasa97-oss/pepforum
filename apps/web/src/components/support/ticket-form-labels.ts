import { TICKET_KINDS } from '@pepforum/database';

import type { MessageKey } from '@/lib/i18n';

/** Strings the new-ticket form needs, picked on the server and passed down. */
export const TICKET_FORM_LABEL_KEYS = [
  'contact.form.username', 'contact.form.usernameHint', 'contact.form.usernameError',
  'contact.form.contentUrl', 'contact.form.pageUrl', 'contact.form.urlHint', 'contact.form.urlError',
  'contact.form.subject', 'contact.form.subjectError', 'contact.form.body', 'contact.form.bodyError',
  'contact.form.privacy', 'contact.form.submit',
  ...TICKET_KINDS.map((kind) => `contact.form.bodyHint.${kind}` as const),
] satisfies MessageKey[];

export type TicketFormLabelKey = (typeof TICKET_FORM_LABEL_KEYS)[number];
