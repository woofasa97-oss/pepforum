import { TICKET_KINDS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { TicketForm } from '@/components/support/TicketForm';
import { TICKET_FORM_LABEL_KEYS } from '@/components/support/ticket-form-labels';
import { Icon } from '@/components/ui/Icon';
import { describeRequirement } from '@/lib/errors';
import { type MessageKey, pick } from '@/lib/i18n';
import { TICKET_KIND_ICONS } from '@/lib/tickets';
import { USERNAME_PATTERN } from '@/lib/validation';
import { getStanding, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Write to the team', robots: { index: false } };

export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ kind?: string; user?: string }> }) {
  const [t, standing, params] = await Promise.all([getT(), getStanding(), searchParams]);
  const kind = TICKET_KINDS.find((k) => k === params.kind);
  if (!standing) redirect(`/auth/sign-in?next=${encodeURIComponent(kind ? `/contact/new?kind=${kind}` : '/contact')}`);
  if (!kind) redirect('/contact');
  const blocked = standing.capabilities.report;
  const user = params.user && USERNAME_PATTERN.test(params.user) ? params.user : '';

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="small mb8"><Link className="link" href="/contact">← {t('contact.title')}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1} className="row" style={{ gap: 8 }}><Icon name={TICKET_KIND_ICONS[kind]} />{t(`contact.kind.${kind}` as MessageKey)}</h1>
            <p>{t(`contact.kindIntro.${kind}` as MessageKey)}</p>
          </div>
        </div>
        {blocked ? (
          <div className="banner warn"><Icon name="lock" /><div>{t('contact.blocked', { reason: describeRequirement(blocked, t) })}</div></div>
        ) : (
          <TicketForm kind={kind} labels={pick(t, TICKET_FORM_LABEL_KEYS)} defaultUser={user} />
        )}
      </main>
    </div>
  );
}
