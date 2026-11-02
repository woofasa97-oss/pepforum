import '@/styles/globals.css';

import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/site/SiteFooter';
import { SiteHeader } from '@/components/site/SiteHeader';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = {
  title: { default: 'Pepforum', template: '%s · Pepforum' },
  description: 'Canada’s peptide-discussion forum, kept honest by community notes. No vendors, no sales, not medical advice.',
  robots: { index: true, follow: true },
  referrer: 'strict-origin-when-cross-origin',
};

export const viewport: Viewport = {
  themeColor: '#0b1f3b',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [locale, t, cookieStore] = await Promise.all([getLocale(), getT(), cookies()]);
  const themeCookie = cookieStore.get('pf-theme')?.value;
  const theme = themeCookie === 'dark' || themeCookie === 'light' ? themeCookie : undefined;

  return (
    <html lang={locale === 'fr' ? 'fr-CA' : 'en-CA'} data-theme={theme}>
      <body>
        <a className="skip" href="#main">{t('app.skip')}</a>
        <SiteHeader theme={theme} />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
