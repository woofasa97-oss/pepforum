import '@/styles/globals.css';

import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import { JsonLd } from '@/components/site/JsonLd';
import { SiteFooter } from '@/components/site/SiteFooter';
import { SiteHeader } from '@/components/site/SiteHeader';
import { env } from '@/lib/env';
import { organizationJsonLd, websiteJsonLd } from '@/lib/seo';
import { getLocale, getT } from '@/server/context';

// The prototype's typefaces, shipped with the repo (src/assets/fonts, SIL OFL
// 1.1, Latin + Latin Extended variable fonts): builds need no network and the
// CSP stays at font-src 'self'.
const inter = localFont({
  src: [
    { path: '../assets/fonts/inter-latin-1.woff2', weight: '100 900', style: 'normal' },
    { path: '../assets/fonts/inter-latin-ext-0.woff2', weight: '100 900', style: 'normal' },
  ],
  variable: '--font-inter',
  display: 'swap',
});
const montserrat = localFont({
  src: [
    { path: '../assets/fonts/montserrat-latin-3.woff2', weight: '100 900', style: 'normal' },
    { path: '../assets/fonts/montserrat-latin-ext-2.woff2', weight: '100 900', style: 'normal' },
  ],
  variable: '--font-montserrat',
  display: 'swap',
});

const DESCRIPTION = 'Canada’s peptide-discussion forum, kept honest by community notes. No vendors, no sales, not medical advice.';

/** metadataBase makes every relative canonical/og URL absolute (SEO, …021). */
export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(env().SITE_URL),
    title: { default: 'Pepforum', template: '%s · Pepforum' },
    description: DESCRIPTION,
    robots: { index: true, follow: true },
    referrer: 'strict-origin-when-cross-origin',
    openGraph: { siteName: 'Pepforum', type: 'website', locale: 'en_CA', alternateLocale: ['fr_CA'], images: ['/icon.png'] },
    twitter: { card: 'summary' },
  };
}

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
    <html lang={locale === 'fr' ? 'fr-CA' : 'en-CA'} data-theme={theme} className={`${inter.variable} ${montserrat.variable}`}>
      <body>
        <a className="skip" href="#main">{t('app.skip')}</a>
        <JsonLd data={organizationJsonLd()} />
        <JsonLd data={websiteJsonLd()} />
        <SiteHeader theme={theme} />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
