import { REPORT_REASONS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppealDecisionForm, ResolveForm } from '@/components/mod/ModForms';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { messageForDbError } from '@/lib/errors';
import { type MessageKey, pick } from '@/lib/i18n';
import { getStanding, getT, getViewer } from '@/server/context';
import { getModQueue } from '@/server/queries';

export const metadata: Metadata = { title: 'Moderation', robots: { index: false } };

const LABEL_KEYS = [
  'mod.markAbusive', 'mod.violation', 'mod.reason', 'mod.remove', 'mod.keep', 'mod.uphold', 'mod.deny',
  ...REPORT_REASONS.map((r) => `report.reason.${r}` as const),
] satisfies MessageKey[];

export default async function ModPage() {
  const [t, viewer, standing] = await Promise.all([getT(), getViewer(), getStanding()]);
  if (!viewer || !standing) redirect('/auth/sign-in?next=/mod');

  // Moderators are site-wide (…034): one queue for everyone who moderates.
  if (!standing.is_moderator) {
    return <div className="page"><main id="main" className="narrow"><div className="card"><EmptyState title={t('mod.notModerator')} /></div></main></div>;
  }
  const result = await getModQueue();
  const labels = pick(t, LABEL_KEYS);

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('mod.title')}</h1>
            <p>{t('mod.sub')}</p>
          </div>
        </div>

        {viewer.aal !== 'aal2' ? <div className="banner warn mb16"><Icon name="shield" /><div>{t('mod.mfaRequired')} <Link className="link" href="/settings">{t('nav.settings')}</Link></div></div> : null}

        {'error' in result ? (
          <div className="banner danger">{messageForDbError(result.error, t)}</div>
        ) : (
          <>
            <h2 className="mb12">{t('mod.queue')}</h2>
            <div className="feed">
              {result.items.length === 0 ? <div className="card"><EmptyState title={t('mod.empty')} /></div> : null}
              {result.items.map((item) => (
                <article key={item.target_id} className="card card-p">
                  <div className="meta">
                    <span className="pill">{item.target_kind}</span>
                    <span className={`pill ${item.status === 'collapsed' ? 'amber' : ''}`}>{item.status}</span>
                    <span>{t('mod.reports', { n: item.report_count, w: item.total_weight })}</span>
                  </div>
                  <h3 className="mt8"><Link href={`/post/${item.post_id}`}>{item.excerpt}</Link></h3>
                  <p className="small muted mt8 post-x clamp">{item.body}</p>
                  <p className="xs faint mt8">
                    {t('mod.author', { user: item.author_username, tier: item.author_tier, integrity: item.author_integrity, prior: item.author_prior_actions })}
                  </p>
                  <ResolveForm kind={item.target_kind} targetId={item.target_id} reports={item.reports} labels={labels} />
                </article>
              ))}
            </div>

            <h2 className="mt24 mb12">{t('mod.appeals')}</h2>
            <div className="feed">
              {result.appeals.length === 0 ? <div className="card"><EmptyState title={t('mod.empty')} /></div> : null}
              {result.appeals.map((appeal) => (
                <article key={appeal.id} className="card card-p">
                  <div className="meta"><span className="pill amber">{appeal.action}</span><span>u/{appeal.appellant}</span><span className="sep" /><span>{appeal.reason}</span></div>
                  <p className="mt8">{appeal.body}</p>
                  {appeal.can_decide ? <AppealDecisionForm appealId={appeal.id} labels={labels} /> : <p className="xs faint mt8">{t('mod.cannotDecide')}</p>}
                </article>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
