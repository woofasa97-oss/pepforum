import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { NotificationSettingsForm } from '@/components/notifications/NotificationSettingsForm';
import { PushSettings } from '@/components/notifications/PushSettings';
import { env } from '@/lib/env';
import { pick } from '@/lib/i18n';
import { getT, getViewer } from '@/server/context';
import { getNotificationSettings } from '@/server/queries';

export const metadata: Metadata = { title: 'Notification settings', robots: { index: false } };

export default async function NotificationSettingsPage() {
  const [t, viewer] = await Promise.all([getT(), getViewer()]);
  if (!viewer) redirect('/auth/sign-in?next=/settings/notifications');
  const settings = (await getNotificationSettings()) ?? { replies: true, notes: true, moderation: true, team: true, push: false, subscriptions: 0 };

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="xs faint mb8"><Link className="link" href="/settings">{t('settings.title')}</Link> · <Link className="link" href="/notifications">{t('notifications.title')}</Link></p>
        <h1 className="mb16" tabIndex={-1}>{t('notifications.settings')}</h1>

        <section className="card card-p mb16" aria-labelledby="cats-h">
          <h2 id="cats-h" className="mb8">{t('notifications.what')}</h2>
          <p className="small muted mb12">{t('notifications.whatBody')}</p>
          <NotificationSettingsForm settings={settings}
            labels={pick(t, ['notifications.save', 'notifications.cat.replies', 'notifications.cat.notes', 'notifications.cat.moderation', 'notifications.cat.team',
              'notifications.catHint.replies', 'notifications.catHint.notes', 'notifications.catHint.moderation', 'notifications.catHint.team'])} />
        </section>

        <section className="card card-p" aria-labelledby="push-h">
          <h2 id="push-h" className="mb8">{t('notifications.push')}</h2>
          <PushSettings vapidPublicKey={env().VAPID_PUBLIC_KEY ?? null} subscriptions={settings.subscriptions}
            labels={pick(t, ['notifications.pushBody', 'notifications.pushBrowsers', 'notifications.pushEnable', 'notifications.pushDisable',
              'notifications.pushDenied', 'notifications.pushFailed', 'notifications.pushUnsupported', 'notifications.pushUnavailable'])} />
        </section>
      </main>
    </div>
  );
}
