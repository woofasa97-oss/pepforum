import { MEDIA_STATUSES, type MediaStatus } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState, TierBadge } from '@/components/ui/Bits';
import { relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { removeMediaAction } from '@/server/actions/admin';
import { adminMedia } from '@/server/admin';
import { getT } from '@/server/context';

export const metadata: Metadata = { title: 'Media' };

/** Recent image uploads, with removal (…023). */
export default async function AdminMediaPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const [t, params] = await Promise.all([getT(), searchParams]);
  const status: MediaStatus = MEDIA_STATUSES.find((s) => s === params.status) ?? 'ready';
  const page = Math.max(0, Number(params.page ?? 0) || 0);
  const result = await adminMedia({ p_status: status, p_page: page });
  const header = <PageHeader title={t('admin.media.title')} sub={t('admin.media.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const { rows, counts, has_more: hasMore } = result.data;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const mb = (counts.bytes / 1_000_000).toFixed(1);

  return (
    <>
      {header}
      <div className="stats mb16">
        <div className="stat"><div className="v">{counts.ready}</div><div className="l">{t('admin.media.status.ready')}</div></div>
        <div className="stat"><div className="v">{counts.pending}</div><div className="l">{t('admin.media.status.pending')}</div></div>
        <div className="stat"><div className="v">{counts.removed_30d}</div><div className="l">{t('admin.media.removed30')}</div></div>
        <div className="stat"><div className="v">{mb} MB</div><div className="l">{t('admin.media.storage')}</div></div>
      </div>
      <nav className="tabs" aria-label={t('admin.media.tabs')}>
        {MEDIA_STATUSES.map((s) => (
          <Link key={s} href={s === 'ready' ? '/admin/media' : `/admin/media?status=${s}`} aria-current={s === status ? 'page' : undefined}>
            {t(`admin.media.status.${s}` as MessageKey)}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? <div className="card"><EmptyState title={t('admin.media.none')} /></div> : (
        <ul className="link-queue">
          {rows.map((m) => (
            <li key={m.id} className="card card-p">
              <div className="row wrap media-row" style={{ gap: 16, alignItems: 'flex-start' }}>
                {m.status === 'ready' ? (
                  // eslint-disable-next-line @next/next/no-img-element -- admin thumbnail from this origin
                  <a href={`/media/${m.id}`} target="_blank" rel="noopener noreferrer"><img src={`/media/${m.id}`} alt={m.alt} style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 8 }} /></a>
                ) : <span className="pill">{t(`admin.media.status.${m.status}` as MessageKey)}</span>}
                <div className="grow">
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Link className="link bold" href={`/admin/people/${encodeURIComponent(m.owner)}`}>u/{m.owner}</Link>
                    <TierBadge tier={m.owner_tier} t={t} />
                    <span className="xs muted">· {m.content_type} · {(m.bytes / 1000).toFixed(0)} KB{m.width ? ` · ${m.width}×${m.height}` : ''} · {relativeTime(m.created_at, t)}</span>
                  </div>
                  {m.post ? <p className="small mt8"><Link className="link" href={`/post/${m.post.id}`}>{m.post.title}</Link> <span className="xs muted">({m.post.status})</span></p> : <p className="xs muted mt8">{t('admin.media.unattached')}</p>}
                  {m.alt ? <p className="xs muted">{t('media.alt')}: {m.alt}</p> : null}
                  {m.removed_reason ? <p className="xs muted">{t('admin.media.removedBecause', { reason: m.removed_reason })}{m.purged ? ` · ${t('admin.media.purged')}` : ''}</p> : null}
                </div>
                {m.status !== 'removed' ? (
                  <ActionForm action={removeMediaAction} label={t('admin.media.remove')} submit={t('admin.media.remove')} tone="danger"
                    consequence={t('admin.media.removeConsequence')} hidden={{ id: m.id }} reasons={[t('admin.media.reason.beforeAfter'), t('admin.media.reason.vendor'), t('admin.media.reason.personal')]} labels={labels} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {hasMore ? <Link className="btn block mt12" href={`/admin/media?status=${status}&page=${page + 1}`}>{t('feed.more')}</Link> : null}
    </>
  );
}
