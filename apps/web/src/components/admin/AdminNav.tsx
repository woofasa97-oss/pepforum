'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

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

/**
 * Sidebar on desktop. On tablets and phones a strip would hide most sections
 * off-screen, so it becomes a "current section ▾" menu listing every section.
 * Built on <details>: works without JavaScript; the script only closes it after navigating.
 */
export function AdminNav({ groups, label }: { groups: readonly AdminNavGroup[]; label: string }) {
  const pathname = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  const active = (href: string) => (href === '/admin' ? pathname === '/admin' : pathname.startsWith(href));
  const items = groups.flatMap((g) => g.items);
  // The most specific match wins (e.g. /admin/people over /admin).
  const current = items.filter((i) => active(i.href)).sort((a, b) => b.href.length - a.href.length)[0] ?? items[0];
  // A dot on the button when another section has something waiting.
  const elsewhere = items.some((i) => i !== current && (i.alert || (i.badge ?? 0) > 0));

  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);

  const links = (
    groups.map((group) => (
      <div key={group.label} className="grp">
        <span className="sec-lbl">{group.label}</span>
        {group.items.map((item) => (
          <Link key={item.href} href={item.href} aria-current={item === current ? 'page' : undefined}>
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.alert ? <span className="badge" title={item.alert}>!</span> : null}
            {!item.alert && item.badge ? <span className="badge">{item.badge > 99 ? '99+' : item.badge}</span> : null}
          </Link>
        ))}
      </div>
    ))
  );

  return (
    <nav className="admin-nav" aria-label={label}>
      <details ref={menu} className="admin-nav-m">
        <summary>
          {current ? <Icon name={current.icon} /> : null}
          <span>{current?.label}</span>
          {current?.alert ? <span className="badge" title={current.alert}>!</span> : null}
          {!current?.alert && current?.badge ? <span className="badge">{current.badge > 99 ? '99+' : current.badge}</span> : null}
          {elsewhere ? <span className="dot" aria-hidden="true" /> : null}
          <Icon name="chevron" className="i chev" />
        </summary>
        <div className="admin-nav-m-body">{links}</div>
      </details>
      <div className="admin-nav-full">{links}</div>
    </nav>
  );
}
