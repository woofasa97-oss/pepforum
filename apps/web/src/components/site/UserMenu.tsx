'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef } from 'react';

import { Icon } from '@/components/ui/Icon';

export interface UserMenuLabels {
  readonly open: string;
  readonly karma: string;
  readonly profile: string;
  readonly progress: string;
  readonly following: string;
  readonly contact: string;
  readonly settings: string;
  readonly mod: string;
  readonly admin: string;
  readonly signOut: string;
}

/**
 * The signed-in member's menu: their picture in the header opens Profile,
 * My progress, Contact the team, Settings, staff pages and Sign out. Built on
 * <details>, so it works without JavaScript; with it, the menu also closes on
 * navigation, an outside click or Escape.
 */
export function UserMenu({ username, avatar, unread, isModerator, isAdmin, labels, signOut, extra }: {
  username: string;
  avatar: ReactNode;
  unread: number;
  isModerator: boolean;
  isAdmin: boolean;
  labels: UserMenuLabels;
  signOut: () => Promise<void>;
  /** Rendered above Sign out: the theme switch, which leaves the header on the narrowest phones. */
  extra?: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const close = (focus: boolean) => {
      const menu = ref.current;
      if (!menu?.open) return;
      menu.open = false;
      if (focus) menu.querySelector('summary')?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <details ref={ref} className="user-menu">
      <summary aria-label={labels.open}>
        {avatar}
        {unread > 0 ? <span className="unread-dot" /> : null}
        <span className="hide-md xs">{labels.karma}</span>
        <Icon name="chevron" className="i chev" />
      </summary>
      <div className="user-menu-body">
        <div className="um-head">
          <b>u/{username}</b>
          <span className="xs muted">{labels.karma}</span>
        </div>
        <Link href={`/u/${encodeURIComponent(username)}`}><Icon name="user" />{labels.profile}</Link>
        <Link href="/following"><Icon name="users" />{labels.following}</Link>
        <Link href="/karma"><Icon name="star" />{labels.progress}</Link>
        <Link href="/contact">
          <Icon name="inbox" />{labels.contact}
          {unread > 0 ? <span className="um-count">{unread}</span> : null}
        </Link>
        <Link href="/settings"><Icon name="sliders" />{labels.settings}</Link>
        {isModerator || isAdmin ? <div className="um-sep" /> : null}
        {isModerator ? <Link href="/mod"><Icon name="flag" />{labels.mod}</Link> : null}
        {isAdmin ? <Link href="/admin"><Icon name="shield" />{labels.admin}</Link> : null}
        {extra}
        <div className="um-sep" />
        <form action={signOut}>
          <button type="submit"><Icon name="undo" />{labels.signOut}</button>
        </form>
      </div>
    </details>
  );
}
