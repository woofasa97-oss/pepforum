import { REPORT_REASONS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AppealDecisionForm, ResolveForm } from '@/components/mod/ModForms';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { messageForDbError } from '@/lib/errors';
import { type MessageKey, pick } from '@/lib/i18n';
import { getLocale, getStanding, getT, getViewer } from '@/server/context';
import { getModQueue, getMyModZones, getTaxonomy } from '@/server/queries';

export const metadata: Metadata = { title: 'Moderation', robots: { index: false } };

const LABEL_KEYS = [
  'mod.markAbusive', 'mod.violation', 'mod.reason', 'mod.remove', 'mod.keep', 'mod.uphold', 'mod.deny',
  ...REPORT_REASONS.map((r) => `report.reason.${r}` as const),
] satisfies MessageKey[];

export default async function ModPage({ searchParams }: { searchParams: Promise<{ zone?: string }> }) {
  const [t, locale, viewer, standing, taxonomy, params] = await Promise.all([getT(), getLocale(), getViewer(), getStanding(), getTaxonomy(), searchParams]);
  if (!viewer || !standing) redirect('/auth/sign-in?next=/mod');

  const myZones = standing.is_admin ? taxonomy.zones.filter((z) => z.id !== 'national').map((z) => z.id) : await getMyModZones();
  if (myZones.length === 0) {
    return <div className="page"><main id="main" className="narrow"><div className="card"><EmptyState title={t('mod.notModerator')} /></div></main></div>;
  }
  const zone = myZones.includes(params.zone ?? '') ? (params.zone as string) : (myZones[0] as string);
  const zoneName = taxonomy.zones.find((z) => z.id === zone);
  const result = await getModQueue(zone);
  const labels = pick(t, LABEL_KEYS);

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('mod.title', { zone: zoneName ? (locale === 'fr' ? zoneName.name_fr : zoneName.name_en) : zone })}</h1>
            <p>{t('mod.sub')}</p>
          </div>
        </div>
        {myZones.length > 1 ? (
          <nav className="row wrap mb16" aria-label="Zone">
            {myZones.map((z) => <Link key={z} className={`chip sm ${z === zone ? 'active' : ''}`} href={`/mod?zone=${z}`}>{z}</Link>)}
          </nav>
        ) : null}

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
