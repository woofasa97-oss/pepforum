import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AdminNav, type AdminNavGroup } from '@/components/admin/AdminNav';
import { Icon } from '@/components/ui/Icon';
import { systemNeedsAttention } from '@/lib/admin';
import { adminOverview } from '@/server/admin';
import { getStanding, getSupabase, getT, getViewer } from '@/server/context';

export const metadata: Metadata = { title: { default: 'Admin', template: '%s · Admin' }, robots: { index: false, follow: false } };

/**
 * The gate: signed in, admin, and an MFA session when the database asks for
 * one (it decides, via security.require_mfa_for_staff). Every page inside
 * re-checks nothing — each RPC enforces the same rules.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const [t, viewer, standing] = await Promise.all([getT(), getViewer(), getStanding()]);
  if (!viewer || !standing) redirect('/auth/sign-in?next=/admin');
  if (!standing.is_admin) notFound();

  const overview = await adminOverview();
  if (!overview.ok && overview.error.code === 'PF428') {
    const supabase = await getSupabase();
    const { data } = await supabase.auth.mfa.listFactors();
    if ((data?.totp ?? []).some((factor) => factor.status === 'verified')) redirect('/auth/mfa?next=/admin');
    return (
      <div className="page">
        <main id="main" className="narrow">
          <div className="card card-p">
            <h1 className="row mb8" tabIndex={-1}><Icon name="lock" />{t('admin.mfa.title')}</h1>
            <p className="muted mb16">{t('admin.mfa.body')}</p>
            <Link className="btn dark" href="/settings">{t('admin.mfa.cta')}</Link>
          </div>
        </main>
      </div>
    );
  }

  const o = overview.ok ? overview.data : null;
  const groups: AdminNavGroup[] = [
    {
      label: t('admin.nav.daily'),
      items: [
        { href: '/admin', label: t('admin.nav.home'), icon: 'home' },
        { href: '/admin/inbox', label: t('admin.nav.inbox'), icon: 'inbox', badge: o?.tickets_open ?? 0 },
        { href: '/admin/moderation', label: t('admin.nav.moderation'), icon: 'flag', badge: o ? o.reports_open + o.appeals_open + o.held : 0 },
        { href: '/admin/links', label: t('admin.nav.links'), icon: 'link', badge: o?.links_pending ?? 0 },
        { href: '/admin/reports', label: t('admin.nav.reports'), icon: 'user', badge: o?.member_reports_open ?? 0 },
        { href: '/admin/people', label: t('admin.nav.people'), icon: 'users' },
        { href: '/admin/content', label: t('admin.nav.content'), icon: 'file' },
      ],
    },
    {
      label: t('admin.nav.health'),
      items: [
        { href: '/admin/notes', label: t('admin.nav.notes'), icon: 'note' },
        { href: '/admin/shield', label: t('admin.nav.shield'), icon: 'shield', badge: o?.held ?? 0 },
      ],
    },
    {
      label: t('admin.nav.setup'),
      items: [
        { href: '/admin/settings', label: t('admin.nav.settings'), icon: 'sliders' },
        { href: '/admin/team', label: t('admin.nav.team'), icon: 'lock', badge: o?.staff_without_mfa ?? 0 },
        { href: '/admin/system', label: t('admin.nav.system'), icon: 'server', ...(o && systemNeedsAttention(o) ? { alert: t('admin.nav.systemAlert') } : {}) },
      ],
    },
  ];

  return (
    <div className="page">
      <div className="admin-shell">
        <AdminNav groups={groups} label={t('admin.nav.label')} />
        <main id="main" className="admin-main">{children}</main>
      </div>
    </div>
  );
}
