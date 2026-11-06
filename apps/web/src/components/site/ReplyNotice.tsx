'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon } from '@/components/ui/Icon';

/**
 * "The team replied to your ticket" under the header, on every page except
 * the contact pages themselves (they already mark new replies, and opening a
 * ticket is what marks it read).
 */
export function ReplyNotice({ text, cta }: { text: string; cta: string }) {
  const pathname = usePathname();
  if (pathname.startsWith('/contact')) return null;
  return (
    <div className="reply-bar" role="status">
      <Icon name="inbox" />
      <span>{text} <Link className="link" href="/contact">{cta}</Link></span>
    </div>
  );
}
