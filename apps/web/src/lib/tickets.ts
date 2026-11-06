import type { TicketKind, TicketStatus } from '@pepforum/database';

import type { IconName } from '@/components/ui/Icon';

/** Contact the team (…020): one icon per kind of ticket. */
export const TICKET_KIND_ICONS: Readonly<Record<TicketKind, IconName>> = {
  suggestion: 'bulb',
  report_member: 'user',
  report_content: 'flag',
  bug: 'alert',
  account: 'lock',
  other: 'help',
};

/** Pill colour for a ticket's status. Members: a reply is good news. Admins: "open" is waiting for us. */
export function ticketTone(status: TicketStatus, viewer: 'member' | 'admin'): string {
  if (status === 'closed') return '';
  if (viewer === 'admin') return status === 'open' ? 'amber' : 'blue';
  return status === 'answered' ? 'green' : 'blue';
}
