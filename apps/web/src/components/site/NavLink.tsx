'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** Link that marks itself aria-current="page" (the root layout doesn't re-render on navigation). */
export function NavLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <Link href={href} className={className} aria-current={pathname === href ? 'page' : undefined}>
      {children}
    </Link>
  );
}
