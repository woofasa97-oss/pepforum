import type { Metadata } from 'next';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { EmptyState } from '@/components/ui/Bits';
import { formatDate } from '@/lib/format';
import { absoluteUrl } from '@/lib/seo';
import { deleteRedirectAction, setRedirectAction } from '@/server/actions/admin';
import { adminRedirects } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'SEO' };

/** Sitemaps (read-only facts) and managed redirects (…021). */
export default async function AdminSeoPage() {
  const [t, locale, result] = await Promise.all([getT(), getLocale(), adminRedirects()]);
  const header = <PageHeader title={t('admin.seo.title')} sub={t('admin.seo.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };

  return (
    <>
      {header}
      <section className="admin-section" aria-labelledby="sitemap-h">
        <h2 id="sitemap-h">{t('admin.seo.sitemaps')}</h2>
        <div className="card card-p">
          <p className="small muted mb8">{t('admin.seo.sitemapsBody')}</p>
          <ul className="small" style={{ paddingLeft: 18 }}>
            {['/sitemap.xml', '/robots.txt', '/sitemaps/pages', '/sitemaps/posts', '/sitemaps/notes', '/sitemaps/profiles'].map((p) => (
              <li key={p}><a className="link" href={p} target="_blank" rel="noopener noreferrer">{absoluteUrl(p)}</a></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="admin-section" aria-labelledby="redirects-h">
        <h2 id="redirects-h">{t('admin.seo.redirects')}</h2>
        <p className="small muted mb12">{t('admin.seo.redirectsBody')}</p>
        <div className="card card-p mb16">
          <ActionForm action={setRedirectAction} label={t('admin.seo.add')} submit={t('admin.seo.save')} tone="primary" labels={labels} open>
            <div className="row wrap" style={{ gap: 12 }}>
              <div className="field grow">
                <label htmlFor="rd-from">{t('admin.seo.from')}</label>
                <input id="rd-from" name="from" className="input" placeholder="/old-page" pattern="/[A-Za-z0-9._~/-]*" required maxLength={500} />
              </div>
              <div className="field grow">
                <label htmlFor="rd-to">{t('admin.seo.to')}</label>
                <input id="rd-to" name="to" className="input" placeholder="/new-page or https://…" required maxLength={1000} />
              </div>
              <div className="field">
                <label htmlFor="rd-kind">{t('admin.seo.kind')}</label>
                <select id="rd-kind" name="permanent" className="input" defaultValue="true">
                  <option value="true">{t('admin.seo.permanent')}</option>
                  <option value="false">{t('admin.seo.temporary')}</option>
                </select>
              </div>
            </div>
          </ActionForm>
        </div>
        {result.data.length === 0 ? (
          <div className="card"><EmptyState title={t('admin.seo.none')} /></div>
        ) : (
          <div className="card tbl-wrap">
            <table className="tbl">
              <thead><tr><th>{t('admin.seo.from')}</th><th>{t('admin.seo.to')}</th><th>{t('admin.seo.kind')}</th><th>{t('admin.seo.by')}</th><th /></tr></thead>
              <tbody>
                {result.data.map((r) => (
                  <tr key={r.from}>
                    <td className="cell-path"><code>{r.from}</code></td>
                    <td className="cell-path">{r.to}</td>
                    <td>{r.permanent ? '301' : '302'}</td>
                    <td className="xs muted">{r.by ? `u/${r.by}` : '—'} · {formatDate(r.updated_at, locale)}<br />{r.reason}</td>
                    <td>
                      <ActionForm action={deleteRedirectAction} label={t('admin.seo.remove')} submit={t('admin.seo.remove')} tone="danger" hidden={{ from: r.from }} labels={labels} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
