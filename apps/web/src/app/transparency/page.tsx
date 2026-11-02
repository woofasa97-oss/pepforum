import { VIOLATIONS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { BarList } from '@/components/admin/Charts';
import { EmptyState } from '@/components/ui/Bits';
import type { MessageKey } from '@/lib/i18n';
import { getLocale, getT } from '@/server/context';
import { getTransparency } from '@/server/queries';

export const metadata: Metadata = { title: 'Transparency' };

/**
 * Public monthly report: what moderators and the community did, in totals.
 * No member is identifiable from it (see transparency_stats in …015).
 */
export default async function TransparencyPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const [t, locale, params] = await Promise.all([getT(), getLocale(), searchParams]);
  const month = /^\d{4}-\d{2}$/.test(params.month ?? '') ? `${params.month}-01` : null;
  const stats = await getTransparency(month);
  const monthName = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('transparency.title')}</h1>
            <p>{t('transparency.sub')}</p>
          </div>
        </div>
        {!stats ? <div className="card"><EmptyState title={t('transparency.unavailable')} /></div> : (
          <>
            <nav className="row wrap mb16" style={{ gap: 6 }} aria-label={t('transparency.month')}>
              {stats.months.slice(0, 12).map((m) => (
                <Link key={m} className="chip sm" href={`/transparency?month=${m.slice(0, 7)}`} aria-current={m.slice(0, 7) === stats.month.slice(0, 7) ? 'page' : undefined}>
                  {monthName(m)}
                </Link>
              ))}
            </nav>
            <h2 className="mb12">{monthName(stats.month)}</h2>

            <div className="stats mb16">
              {([
                ['transparency.reportsFiled', stats.reports.filed],
                ['transparency.reportsActioned', stats.reports.actioned],
                ['transparency.collapsed', stats.collapses.collapsed],
                ['transparency.reopened', stats.collapses.reopened],
                ['transparency.held', stats.held_by_shield],
                ['transparency.restored', stats.restored],
              ] as const).map(([label, value]) => (
                <div key={label} className="stat"><div className="l">{t(label)}</div><div className="v">{value.toLocaleString()}</div></div>
              ))}
            </div>

            <section className="card card-p mb16" aria-labelledby="removals-h">
              <h3 id="removals-h" className="mb8">{t('transparency.removals')}</h3>
              <p className="small muted mb12">{t('transparency.removalsHelp')}</p>
              {Object.keys(stats.removals).length === 0 ? <p className="small muted">{t('transparency.none')}</p> : (
                <BarList label={t('transparency.removals')} rows={VIOLATIONS.filter((v) => stats.removals[v]).map((v) => ({ label: t(`report.reason.${v}` as MessageKey), value: stats.removals[v] ?? 0 }))} />
              )}
            </section>

            <section className="card card-p mb16" aria-labelledby="sanctions-h">
              <h3 id="sanctions-h" className="mb8">{t('transparency.sanctions')}</h3>
              <ul className="caps">
                {(['warning', 'freeze', 'suspension', 'ban'] as const).map((k) => (
                  <li key={k}><span>{t(`admin.sanction.${k}` as MessageKey)}</span><b>{stats.sanctions[k] ?? 0}</b></li>
                ))}
              </ul>
            </section>

            <section className="card card-p mb16" aria-labelledby="appeals-h">
              <h3 id="appeals-h" className="mb8">{t('transparency.appeals')}</h3>
              <ul className="caps">
                <li><span>{t('transparency.appealsFiled')}</span><b>{stats.appeals.filed}</b></li>
                <li><span>{t('transparency.appealsUpheld')}</span><b>{stats.appeals.upheld}</b></li>
                <li><span>{t('transparency.appealsDenied')}</span><b>{stats.appeals.denied}</b></li>
              </ul>
            </section>

            <section className="card card-p" aria-labelledby="notes-h">
              <h3 id="notes-h" className="mb8">{t('transparency.notes')}</h3>
              <ul className="caps">
                <li><span>{t('transparency.notesWritten')}</span><b>{stats.notes.written}</b></li>
                <li><span>{t('transparency.notesShown')}</span><b>{stats.notes.shown}</b></li>
                <li><span>{t('transparency.notesHelpful')}</span><b>{stats.notes.locked_helpful}</b></li>
                <li><span>{t('transparency.notesNotHelpful')}</span><b>{stats.notes.locked_not_helpful}</b></li>
                <li><span>{t('transparency.notesHidden')}</span><b>{stats.notes.hidden}</b></li>
              </ul>
              <p className="xs faint mt12"><Link className="link" href="/legal/community-notes">{t('footer.howNotes')}</Link></p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
