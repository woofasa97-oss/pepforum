'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon, type IconName } from '@/components/ui/Icon';

export interface AdminNavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  /** Count of things waiting; shown as a badge when > 0. */
  readonly badge?: number;
  /** Shown instead of a count when something is wrong (e.g. a stalled job). */
  readonly alert?: string;
}

export interface AdminNavGroup {
  readonly label: string;
  readonly items: readonly AdminNavItem[];
}

/** Sidebar on desktop, a scrollable strip on phones. */
export function AdminNav({ groups, label }: { groups: readonly AdminNavGroup[]; label: string }) {
  const pathname = usePathname();
  const active = (href: string) => (href === '/admin' ? pathname === '/admin' : pathname.startsWith(href));
  return (
    <nav className="admin-nav" aria-label={label}>
      {groups.map((group) => (
        <div key={group.label} className="grp">
          <span className="sec-lbl">{group.label}</span>
          {group.items.map((item) => (
            <Link key={item.href} href={item.href} aria-current={active(item.href) ? 'page' : undefined}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.alert ? <span className="badge" title={item.alert}>!</span> : null}
              {!item.alert && item.badge ? <span className="badge">{item.badge > 99 ? '99+' : item.badge}</span> : null}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}
