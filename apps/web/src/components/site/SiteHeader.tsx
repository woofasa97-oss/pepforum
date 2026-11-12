import Link from 'next/link';

import { Avatar } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { signOutAction } from '@/server/actions/auth';
import { setLocaleAction, setThemeAction } from '@/server/actions/settings';
import { getLocale, getStanding, getT, getViewer } from '@/server/context';
import { getAnnouncement, getPricesEnabled } from '@/server/queries';

import { Logo } from './Logo';
import { NavLink } from './NavLink';
import { ReplyNotice } from './ReplyNotice';
import { UserMenu } from './UserMenu';

/** Global header. Server-rendered; forms work without JavaScript. */
export async function SiteHeader({ theme }: { theme: 'light' | 'dark' | undefined }) {
  const [t, locale, viewer, standing, announcement, prices] = await Promise.all([getT(), getLocale(), getViewer(), getStanding(), getAnnouncement(), getPricesEnabled()]);
  const announcementText = announcement ? (locale === 'fr' ? announcement.fr || announcement.en : announcement.en || announcement.fr) : '';

  return (
    <>
      <header className="hdr">
        <div className="hdr-in">
          <Logo tag={t('app.brandTag')} preload />
          <nav className="nav" aria-label="Primary">
            <NavLink href="/" className="hide-sm">{t('nav.home')}</NavLink>
            <NavLink href="/notes">{t('nav.notes')}</NavLink>
            {prices ? <NavLink href="/prices" className="hide-sm">{t('nav.prices')}</NavLink> : null}
            {standing?.is_moderator ? <NavLink href="/mod" className="hide-md">{t('nav.mod')}</NavLink> : null}
            {standing?.is_admin ? <NavLink href="/admin" className="hide-md">{t('nav.admin')}</NavLink> : null}
            <form action={setLocaleAction}>
              <input type="hidden" name="locale" value={locale === 'fr' ? 'en' : 'fr'} />
              <button type="submit" className="navbtn" lang={locale === 'fr' ? 'en' : 'fr'} aria-label={t('nav.language')}>
                <span className="hide-md">{t('nav.language')}</span>
                <span className="only-md" aria-hidden="true">{locale === 'fr' ? 'EN' : 'FR'}</span>
              </button>
            </form>
            <form action={setThemeAction}>
              <input type="hidden" name="theme" value={theme === 'dark' ? 'light' : 'dark'} />
              <button type="submit" className="icon-btn" aria-label={t('nav.theme')} title={t('nav.theme')}><Icon name="moon" /></button>
            </form>
            {viewer && standing ? (
              <>
                <Link href="/submit" className="btn red sm" aria-label={t('nav.submit')}><Icon name="plus" /><span className="hide-md">{t('nav.submit')}</span></Link>
                <Link href="/notifications" className="icon-btn"
                  aria-label={standing.notifications_unread > 0 ? t('nav.notificationsUnread', { n: standing.notifications_unread }) : t('nav.notifications')}
                  title={t('nav.notifications')}>
                  <Icon name="bell" />
                  {standing.notifications_unread > 0 ? <span className="unread-dot" /> : null}
                </Link>
                <UserMenu
                  username={standing.username}
                  avatar={<Avatar name={standing.username} src={standing.avatar ?? null} />}
                  unread={standing.support_unread ?? 0}
                  isModerator={standing.is_moderator}
                  isAdmin={standing.is_admin}
                  signOut={signOutAction}
                  labels={{
                    open: standing.support_unread > 0
                      ? `${t('nav.menu', { user: standing.username })} · ${t('nav.contactUnread', { n: standing.support_unread })}`
                      : t('nav.menu', { user: standing.username }),
                    karma: t('nav.karmaShort', { n: standing.karma.toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-CA') }),
                    profile: t('nav.profile'),
                    progress: t('nav.karma'),
                    following: t('feed.following'),
                    contact: t('nav.contact'),
                    settings: t('nav.settings'),
                    mod: t('nav.mod'),
                    admin: t('nav.admin'),
                    signOut: t('nav.signOut'),
                  }}
                />
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
    </>
  );
}
