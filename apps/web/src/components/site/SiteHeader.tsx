import Link from 'next/link';

import { Avatar } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { signOutAction } from '@/server/actions/auth';
import { setLocaleAction, setThemeAction } from '@/server/actions/settings';
import { getLocale, getStanding, getT, getViewer } from '@/server/context';
import { getAnnouncement, getTaxonomy } from '@/server/queries';

import { Logo } from './Logo';
import { NavLink } from './NavLink';
import { ReplyNotice } from './ReplyNotice';

/** Global header + zone bar. Server-rendered; forms work without JavaScript. */
export async function SiteHeader({ theme }: { theme: 'light' | 'dark' | undefined }) {
  const [t, locale, viewer, standing, taxonomy, announcement] = await Promise.all([getT(), getLocale(), getViewer(), getStanding(), getTaxonomy(), getAnnouncement()]);
  const announcementText = announcement ? (locale === 'fr' ? announcement.fr || announcement.en : announcement.en || announcement.fr) : '';

  return (
    <>
      <header className="hdr">
        <div className="hdr-in">
          <Logo tag={t('app.brandTag')} preload />
          <nav className="nav" aria-label="Primary">
            <NavLink href="/" className="hide-sm">{t('nav.home')}</NavLink>
            <NavLink href="/notes">{t('nav.notes')}</NavLink>
            {viewer ? <NavLink href="/karma" className="hide-sm">{t('nav.karma')}</NavLink> : null}
            {standing?.is_moderator ? <NavLink href="/mod" className="hide-sm">{t('nav.mod')}</NavLink> : null}
            {standing?.is_admin ? <NavLink href="/admin" className="hide-sm">{t('nav.admin')}</NavLink> : null}
            <form action={setLocaleAction}>
              <input type="hidden" name="locale" value={locale === 'fr' ? 'en' : 'fr'} />
              <button type="submit" className="navbtn" lang={locale === 'fr' ? 'en' : 'fr'}>{t('nav.language')}</button>
            </form>
            <form action={setThemeAction}>
              <input type="hidden" name="theme" value={theme === 'dark' ? 'light' : 'dark'} />
              <button type="submit" className="icon-btn" aria-label={t('nav.theme')} title={t('nav.theme')}><Icon name="moon" /></button>
            </form>
            {viewer && standing ? (
              <>
                <Link href="/submit" className="btn red sm"><Icon name="plus" />{t('nav.submit')}</Link>
                <Link href={`/u/${standing.username}`} className="row" aria-label={`${t('nav.profile')}: u/${standing.username}`}>
                  <Avatar name={standing.username} />
                  <span className="hide-sm xs">{standing.karma.toLocaleString()} ★</span>
                </Link>
                <Link href="/contact" className="icon-btn hide-sm"
                  aria-label={standing.support_unread > 0 ? t('nav.contactUnread', { n: standing.support_unread }) : t('nav.contact')}
                  title={t('nav.contact')}>
                  <Icon name="inbox" />
                  {standing.support_unread > 0 ? <span className="unread-dot" /> : null}
                </Link>
                <Link href="/settings" className="icon-btn hide-sm" aria-label={t('nav.settings')}><Icon name="user" /></Link>
                <form action={signOutAction}>
                  <button type="submit" className="navbtn hide-sm">{t('nav.signOut')}</button>
                </form>
              </>
            ) : (
              <>
                <Link href="/auth/sign-up" className="btn sm ghost-light">{t('nav.signUp')}</Link>
                <Link href="/auth/sign-in" className="btn red sm">{t('nav.signIn')}</Link>
              </>
            )}
          </nav>
        </div>
      </header>
      {announcementText ? (
        <div className={`site-banner ${announcement?.tone === 'warn' ? 'warn' : 'info'}`} role="status">
          <Icon name={announcement?.tone === 'warn' ? 'alert' : 'info'} />
          <span>{announcementText}</span>
        </div>
      ) : null}
      {standing && standing.support_unread > 0 ? (
        <ReplyNotice text={t('contact.replyBanner', { n: standing.support_unread })} cta={t('contact.replyBannerCta')} />
      ) : null}
      {standing?.needs_onboarding ? (
        <div className="onboard-bar" role="status">
          <span>{t('auth.finishBanner')}</span>
          <Link className="btn red sm" href="/auth/welcome">{t('auth.finishSetup')}</Link>
        </div>
      ) : null}
      <div className="zonebar">
        <nav className="zonebar-in" id="zones" aria-label={t('nav.zones')}>
          <span className="lbl">{t('nav.zones')}</span>
          {taxonomy.zones.map((z) => {
            const href = z.id === 'national' ? '/' : `/zone/${z.id}`;
            return (
              <NavLink key={z.id} className="chip" href={href}>
                {z.id === 'national' ? <Icon name="globe" /> : null}
                {locale === 'fr' ? z.name_fr : z.name_en}
              </NavLink>
            );
          })}
        </nav>
      </div>
    </>
  );
}
