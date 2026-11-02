import { CONTENT_KINDS, type AdminContentRow, type ContentKind, VIOLATIONS } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader, StatusPill } from '@/components/admin/AdminBits';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { formatDate } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { removeContentAction, restoreContentAction, setCommentsLockedAction, setNoteHiddenAction, setPinnedAction } from '@/server/actions/admin';
import { adminContent } from '@/server/admin';
import { getLocale, getT } from '@/server/context';
import { getTaxonomy } from '@/server/queries';

export const metadata: Metadata = { title: 'Content' };

const STATUSES: Record<ContentKind, readonly string[]> = {
  post: ['visible', 'collapsed', 'held', 'removed', 'deleted'],
  comment: ['visible', 'collapsed', 'held', 'removed', 'deleted'],
  note: ['needs_more_ratings', 'helpful', 'not_helpful', 'hidden'],
};

function RowActions({ row, t }: { row: AdminContentRow; t: Translate }) {
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  if (row.kind === 'note') {
    return row.hidden ? (
      <ActionForm action={setNoteHiddenAction} label={t('admin.content.unhide')} submit={t('admin.content.unhide')}
        consequence={t('admin.content.unhideHelp')} hidden={{ id: row.id, on: 'false' }} labels={labels} />
    ) : (
      <ActionForm action={setNoteHiddenAction} label={t('admin.content.hide')} submit={t('admin.content.hide')} tone="danger"
        consequence={t('admin.content.hideHelp')} hidden={{ id: row.id, on: 'true' }} labels={labels}
        reasons={[t('admin.reasons.doxxing'), t('admin.reasons.vendorLink'), t('admin.reasons.harassment')]} />
    );
  }
  const live = row.status === 'visible' || row.status === 'collapsed' || row.status === 'held';
  return (
    <>
      {live ? (
        <ActionForm action={removeContentAction} label={t('admin.content.remove')} submit={t('admin.content.remove')} tone="danger"
          consequence={t('admin.content.removeHelp')} hidden={{ kind: row.kind, id: row.id }} labels={labels}>
          <div className="field">
            <label htmlFor={`violation-${row.id}`}>{t('mod.violation')}</label>
            <select id={`violation-${row.id}`} name="violation" className="input" required defaultValue="sourcing">
              {VIOLATIONS.map((v) => <option key={v} value={v}>{t(`report.reason.${v}` as MessageKey)}</option>)}
            </select>
          </div>
        </ActionForm>
      ) : null}
      {row.status === 'removed' ? (
        <ActionForm action={restoreContentAction} label={t('admin.content.restore')} submit={t('admin.content.restore')}
          consequence={t('admin.content.restoreHelp')} hidden={{ kind: row.kind, id: row.id }} labels={labels} />
      ) : null}
      {row.kind === 'post' && (row.status === 'visible' || row.status === 'collapsed') ? (
        <ActionForm action={setPinnedAction} label={t(row.pinned ? 'admin.content.unpin' : 'admin.content.pin')}
          submit={t(row.pinned ? 'admin.content.unpin' : 'admin.content.pin')} consequence={row.pinned ? undefined : t('admin.content.pinHelp')}
          hidden={{ id: row.id, on: row.pinned ? 'false' : 'true' }} labels={labels} />
      ) : null}
      {row.kind === 'post' && row.status !== 'deleted' ? (
        <ActionForm action={setCommentsLockedAction} label={t(row.locked ? 'admin.content.unlock' : 'admin.content.lock')}
          submit={t(row.locked ? 'admin.content.unlock' : 'admin.content.lock')} consequence={row.locked ? undefined : t('admin.content.lockHelp')}
          hidden={{ id: row.id, on: row.locked ? 'false' : 'true' }} labels={labels} />
      ) : null}
    </>
  );
}

export default async function AdminContentPage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string; status?: string; zone?: string; page?: string }> }) {
  const [t, locale, params, taxonomy] = await Promise.all([getT(), getLocale(), searchParams, getTaxonomy()]);
  const kind: ContentKind = CONTENT_KINDS.includes(params.kind as ContentKind) ? (params.kind as ContentKind) : 'post';
  const status = STATUSES[kind].includes(params.status ?? '') ? (params.status as string) : null;
  const zone = taxonomy.zones.some((z) => z.id === params.zone) ? (params.zone as string) : null;
  const q = (params.q ?? '').trim().slice(0, 100);
  const page = Math.min(Math.max(Number.parseInt(params.page ?? '0', 10) || 0, 0), 200);
  const result = await adminContent({ p_kind: kind, p_query: q || null, p_status: status, p_zone: zone, p_page: page });
  const zoneName = (id: string) => {
    const z = taxonomy.zones.find((x) => x.id === id);
    return z ? (locale === 'fr' ? z.name_fr : z.name_en) : id;
  };
  const href = (next: Record<string, string | number | null>) => {
    const search = new URLSearchParams({ kind, ...(q ? { q } : {}), ...(status ? { status } : {}), ...(zone ? { zone } : {}) });
    for (const [k, v] of Object.entries(next)) {
      if (v === null) search.delete(k);
      else search.set(k, String(v));
    }
    return `/admin/content?${search.toString()}`;
  };

  return (
    <>
      <PageHeader title={t('admin.content.title')} sub={t('admin.content.sub')} />

      <nav className="seg mb12" aria-label={t('admin.content.kind')}>
        {CONTENT_KINDS.map((k) => (
          <Link key={k} href={`/admin/content?kind=${k}`} aria-current={k === kind ? 'page' : undefined}>{t(`admin.kinds.${k}` as MessageKey)}</Link>
        ))}
      </nav>

      <form className="filters card card-p" action="/admin/content">
        <input type="hidden" name="kind" value={kind} />
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <label className="vh" htmlFor="content-q">{t('admin.content.search')}</label>
        <input id="content-q" name="q" className="input" placeholder={t('admin.content.search')} defaultValue={q} maxLength={100} />
        <label className="vh" htmlFor="content-zone">{t('admin.zone')}</label>
        <select id="content-zone" name="zone" className="input" defaultValue={zone ?? ''} style={{ maxWidth: 200 }}>
          <option value="">{t('admin.log.anyZone')}</option>
          {taxonomy.zones.map((z) => <option key={z.id} value={z.id}>{zoneName(z.id)}</option>)}
        </select>
        <button type="submit" className="btn">{t('admin.search')}</button>
      </form>

      <nav className="row wrap mb12" style={{ gap: 6 }} aria-label={t('admin.status')}>
        <Link className="chip sm" href={href({ status: null, page: 0 })} aria-current={!status ? 'page' : undefined}>{t('admin.all')}</Link>
        {STATUSES[kind].map((s) => (
          <Link key={s} className="chip sm" href={href({ status: s, page: 0 })} aria-current={s === status ? 'page' : undefined}>
            {t(kind === 'note' && s !== 'hidden' ? (`notes.status.${s}` as MessageKey) : (`admin.status.${s}` as MessageKey))}
          </Link>
        ))}
      </nav>

      {!result.ok ? <DataUnavailable result={result} t={t} /> : result.data.rows.length === 0 ? (
        <div className="card"><EmptyState title={t('admin.content.none')} /></div>
      ) : (
        <div className="feed">
          {result.data.rows.map((row) => (
            <article key={row.id} className="card card-p">
              <div className="meta">
                <span className="pill zone">{zoneName(row.zone_id)}</span>
                {row.kind === 'note' ? <span className="pill">{t(`notes.status.${row.status}` as MessageKey)}</span> : <StatusPill status={row.status} t={t} />}
                {row.pinned ? <span className="pill blue"><Icon name="pin" />{t('admin.content.pinned')}</span> : null}
                {row.locked && row.kind === 'post' ? <span className="pill"><Icon name="lock" />{t('admin.content.locked')}</span> : null}
                {row.hidden ? <span className="pill red"><Icon name="eye" />{t('admin.content.hidden')}</span> : null}
                {row.open_reports ? <span className="pill amber"><Icon name="flag" />{t('admin.content.reports', { n: row.open_reports })}</span> : null}
                <Link className="link" href={`/admin/people/${encodeURIComponent(row.author)}`}>u/{row.author}</Link>
                <span className="xs faint">{formatDate(row.created_at, locale)}</span>
              </div>
              <h3 className="mt8" style={{ fontSize: 15 }}>
                <Link href={row.kind === 'note' ? `/notes/${row.id}` : `/post/${row.post_id}`}>{row.kind === 'post' ? row.title : row.excerpt}</Link>
              </h3>
              {row.kind !== 'post' ? <p className="xs faint mt8">{t('admin.content.onPost', { title: row.title })}</p> : <p className="small muted mt8 clamp">{row.excerpt}</p>}
              {row.removal_reason ? <p className="xs mt8">{t('admin.content.removedFor', { reason: t(`report.reason.${row.removal_reason}` as MessageKey) })}</p> : null}
              {row.hidden_reason ? <p className="xs mt8">{t('admin.content.hiddenFor', { reason: row.hidden_reason })}</p> : null}
              <div className="row wrap mt12" style={{ gap: 6, alignItems: 'flex-start' }}><RowActions row={row} t={t} /></div>
            </article>
          ))}
        </div>
      )}
      {result.ok && (page > 0 || result.data.has_more) ? (
        <div className="row between mt16">
          {page > 0 ? <Link className="btn sm" href={href({ page: page - 1 })}>{t('admin.prev')}</Link> : <span />}
          {result.data.has_more ? <Link className="btn sm" href={href({ page: page + 1 })}>{t('admin.next')}</Link> : null}
        </div>
      ) : null}
    </>
  );
}
