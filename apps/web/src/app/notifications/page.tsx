import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { EmptyState } from '@/components/ui/Bits';
import { Icon, type IconName } from '@/components/ui/Icon';
import { relativeTime } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { markNotificationsReadAction } from '@/server/actions/features';
import { getT, getViewer } from '@/server/context';
import { getMyNotifications } from '@/server/queries';

export const metadata: Metadata = { title: 'Notifications', robots: { index: false } };

const ICONS: Record<string, IconName> = {
  reply_post: 'comment', reply_comment: 'comment', note_outcome: 'note', note_on_post: 'note', mod_action: 'shield', team_reply: 'inbox',
  clinician_review: 'check', ad_review: 'star', new_follower: 'user',
};

export default async function NotificationsPage() {
  const [t, viewer] = await Promise.all([getT(), getViewer()]);
  if (!viewer) redirect('/auth/sign-in?next=/notifications');
  const items = await getMyNotifications(100);
  const unread = items.filter((n) => !n.read).length;

  const href = (n: (typeof items)[number]) =>
    n.ticket ? `/contact/${n.ticket.id}` : n.kind === 'note_outcome' || n.kind === 'note_on_post' ? (n.post ? `/post/${n.post.id}` : '/notes')
      : n.kind === 'new_follower' && n.actor ? `/u/${encodeURIComponent(n.actor)}`
      : n.kind === 'clinician_review' ? '/settings/clinician' : n.kind === 'ad_review' ? '/advertiser'
      : n.post ? `/post/${n.post.id}${n.comment_excerpt ? '#comments' : ''}` : '/karma';

  const text = (n: (typeof items)[number]) => {
    switch (n.kind) {
      case 'reply_post': return t('notifications.replyPost', { user: n.actor ?? '?', title: n.post?.title ?? '' });
      case 'reply_comment': return t('notifications.replyComment', { user: n.actor ?? '?', title: n.post?.title ?? '' });
      case 'note_outcome': return t(n.note_status === 'helpful' ? 'notifications.noteHelpful' : 'notifications.noteNotHelpful', { title: n.post?.title ?? '' });
      case 'note_on_post': return t('notifications.noteOnPost', { title: n.post?.title ?? '' });
      case 'mod_action': return t('notifications.modAction', { action: t(`admin.action.${n.action ?? 'remove'}` as MessageKey), reason: n.reason ?? '' });
      case 'team_reply': return t('notifications.teamReply', { subject: n.ticket?.subject ?? '' });
      case 'clinician_review': return t(`notifications.clinician.${n.action ?? 'rejected'}` as MessageKey, { reason: n.reason ?? '' });
      case 'ad_review': return t(`notifications.ad.${n.action ?? 'ad_rejected'}` as MessageKey, { reason: n.reason ?? '' });
      case 'new_follower': return t('notifications.newFollower', { user: n.actor ?? '?' });
      default: return '';
    }
  };

  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('notifications.title')}</h1>
            <p>{t('notifications.sub')}</p>
          </div>
          <div className="row wrap">
            {unread > 0 ? (
              <form action={markNotificationsReadAction}>
                <button type="submit" className="btn sm">{t('notifications.markAllRead')}</button>
              </form>
            ) : null}
            <Link className="btn sm" href="/settings/notifications"><Icon name="sliders" />{t('notifications.settings')}</Link>
          </div>
        </div>
        <div className="card">
          {items.length === 0 ? <EmptyState title={t('notifications.empty')} /> : (
            <ul className="ticket-list">
              {items.map((n) => (
                <li key={n.id} className={n.read ? '' : 'unread'}>
                  <Link href={href(n)}>
                    <span className="row" style={{ gap: 8 }}>
                      <Icon name={ICONS[n.kind] ?? 'info'} />
                      <span className={n.read ? '' : 'bold'}>{text(n)}</span>
                    </span>
                    {n.comment_excerpt ? <span className="small muted">“{n.comment_excerpt}”</span> : null}
                    <span className="xs muted">{relativeTime(n.created_at, t)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
