import { PEOPLE_FILTERS, PEOPLE_SORTS, type PeopleFilter, type PeopleSort } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { FindByEmailForm } from '@/components/admin/FindByEmailForm';
import { Avatar, EmptyState, TierBadge } from '@/components/ui/Bits';
import { providerName } from '@/lib/auth-providers';
import { formatDate } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { adminPeople } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'People' };

export default async function AdminPeoplePage({ searchParams }: { searchParams: Promise<{ q?: string; filter?: string; sort?: string; page?: string }> }) {
  const [t, locale, params] = await Promise.all([getT(), getLocale(), searchParams]);
  const q = (params.q ?? '').trim().slice(0, 40);
  const filter: PeopleFilter = PEOPLE_FILTERS.includes(params.filter as PeopleFilter) ? (params.filter as PeopleFilter) : 'all';
  const sort: PeopleSort = PEOPLE_SORTS.includes(params.sort as PeopleSort) ? (params.sort as PeopleSort) : 'newest';
  const page = Math.min(Math.max(Number.parseInt(params.page ?? '0', 10) || 0, 0), 200);
  const result = await adminPeople({ p_query: q || null, p_filter: filter, p_sort: sort, p_page: page });

  const href = (next: Partial<{ filter: string; sort: string; page: number }>) => {
    const search = new URLSearchParams({ ...(q ? { q } : {}), filter, sort, page: '0' });
    for (const [k, v] of Object.entries(next)) search.set(k, String(v));
    return `/admin/people?${search.toString()}`;
  };

  return (
    <>
      <PageHeader title={t('admin.people.title')} sub={t('admin.people.sub')} />

      <div className="card card-p mb16">
        <form className="filters" action="/admin/people">
          <label className="vh" htmlFor="people-q">{t('admin.people.search')}</label>
          <input id="people-q" name="q" className="input" defaultValue={q} placeholder={t('admin.people.search')} maxLength={40} />
          <input type="hidden" name="filter" value={filter} />
          <input type="hidden" name="sort" value={sort} />
          <button type="submit" className="btn">{t('admin.search')}</button>
        </form>
        <FindByEmailForm labels={{ label: t('admin.people.email'), hint: t('admin.people.emailHint'), submit: t('admin.people.find') }} />
      </div>

      <div className="row between wrap mb12" style={{ gap: 8 }}>
        <nav className="row wrap" style={{ gap: 6 }} aria-label={t('admin.filter')}>
          {PEOPLE_FILTERS.map((f) => (
            <Link key={f} className="chip sm" href={href({ filter: f })} aria-current={f === filter ? 'page' : undefined}>
              {t(`admin.people.filter.${f}` as MessageKey)}
            </Link>
          ))}
        </nav>
        <nav className="seg" aria-label={t('admin.sort')}>
          {PEOPLE_SORTS.map((s) => (
            <Link key={s} href={href({ sort: s })} aria-current={s === sort ? 'page' : undefined}>{t(`admin.people.sort.${s}` as MessageKey)}</Link>
          ))}
        </nav>
      </div>

      {!result.ok ? <DataUnavailable result={result} t={t} /> : result.data.rows.length === 0 ? (
        <div className="card"><EmptyState title={t('admin.people.none')} /></div>
      ) : (
        <div className="card tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col">{t('admin.people.member')}</th>
                <th scope="col">{t('admin.people.tier')}</th>
                <th scope="col" className="num">{t('admin.people.karma')}</th>
                <th scope="col">{t('admin.people.integrity')}</th>
                <th scope="col">{t('admin.people.joined')}</th>
                <th scope="col">{t('admin.people.signIn')}</th>
                <th scope="col" className="num">{t('admin.people.reports30')}</th>
              </tr>
            </thead>
            <tbody>
              {result.data.rows.map((p) => (
                <tr key={p.username} className="row-link">
                  <td>
                    <Link className="row" href={`/admin/people/${encodeURIComponent(p.username)}`}>
                      <Avatar name={p.username} size="sm" />
                      <b>{p.username}</b>
                    </Link>
                    <span className="row wrap mt8" style={{ gap: 4 }}>
                      {p.is_admin ? <span className="pill blue">{t('admin.role.admin')}</span> : null}
                      {p.is_moderator && !p.is_admin ? <span className="pill blue">{t('admin.role.moderator')}</span> : null}
                      {p.founding ? <span className="pill green">{t('admin.role.founding')}</span> : null}
                      {p.needs_onboarding ? <span className="pill amber">{t('admin.people.onboarding')}</span> : null}
                      {p.restriction ? <span className="pill red">{t(`admin.sanction.${p.restriction}` as MessageKey)}</span> : null}
                      {p.deleted ? <span className="pill">{t('admin.people.deleted')}</span> : null}
                    </span>
                  </td>
                  <td><TierBadge tier={p.tier} t={t} /></td>
                  <td className="num">{p.karma.toLocaleString()}</td>
                  <td>
                    <span className={`mini-bar ${p.integrity < 50 ? 'low' : ''}`} aria-hidden="true"><span style={{ width: `${p.integrity}%` }} /></span>
                    {p.integrity}
                  </td>
                  <td>{formatDate(p.created_at, locale)}</td>
                  <td>{providerName(p.provider) ?? t('admin.people.emailSignIn')}</td>
                  <td className="num">{p.reports_30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
