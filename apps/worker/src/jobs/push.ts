/**
 * Web push delivery (…022). The database hands over unpushed notifications
 * with each member's registered browsers and the facts needed to word a
 * short message in their language; this job sends through the push service
 * with VAPID and reports back. Dead endpoints (404/410) are dropped by the
 * database. Payloads carry no content beyond a title and a link.
 */
import type { NotificationKind, PendingPush, PushResult } from '@pepforum/database';

import type { Logger } from '../logger.ts';
import type { WorkerStore } from '../store.ts';

export interface PushSender {
  /** Resolves on success; rejects with { statusCode } on failure. */
  send(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string): Promise<void>;
}

export interface PushReport {
  readonly notifications: number;
  readonly sent: number;
  readonly failed: number;
  readonly dropped: number;
}

const TITLES: Record<'en' | 'fr', Record<NotificationKind, string>> = {
  en: {
    reply_post: 'New comment on your post', reply_comment: 'New reply to your comment', note_outcome: 'Your community note settled',
    note_on_post: 'A helpful note was added to your post', mod_action: 'A moderation decision concerns you', team_reply: 'The Pepforums team replied',
    clinician_review: 'Your clinician verification was reviewed', ad_review: 'Your advertising request was reviewed',
    new_follower: 'You have a new follower',
  },
  fr: {
    reply_post: 'Nouveau commentaire sur votre publication', reply_comment: 'Nouvelle réponse à votre commentaire', note_outcome: 'Votre note communautaire est réglée',
    note_on_post: 'Une note utile a été ajoutée à votre publication', mod_action: 'Une décision de modération vous concerne', team_reply: 'L’équipe Pepforums a répondu',
    clinician_review: 'Votre vérification de clinicien a été révisée', ad_review: 'Votre demande publicitaire a été révisée',
    new_follower: 'Vous avez un nouvel abonné',
  },
};

/** The JSON the service worker (apps/web/public/sw.js) shows. */
export function pushPayload(item: PendingPush, siteUrl: string): string {
  const locale = item.locale === 'fr' ? 'fr' : 'en';
  return JSON.stringify({
    title: TITLES[locale][item.kind] ?? 'Pepforums',
    body: item.post_title ?? '',
    url: new URL(item.url, siteUrl).toString(),
    tag: `pf-${item.kind}`,
  });
}

export async function pushJob(store: WorkerStore, log: Logger, sender: PushSender, options: { batchSize: number; siteUrl: string }): Promise<PushReport> {
  const pending = await store.pendingPush(options.batchSize);
  const results: PushResult[] = [];
  let failed = 0;
  for (const item of pending) {
    if (item.subscriptions.length === 0) {
      results.push({ notification_id: item.id, subscription_id: null, ok: true, gone: false });
      continue;
    }
    const payload = pushPayload(item, options.siteUrl);
    for (const sub of item.subscriptions) {
      try {
        await sender.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        results.push({ notification_id: item.id, subscription_id: sub.id, ok: true, gone: false });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode ?? 0;
        failed += 1;
        results.push({ notification_id: item.id, subscription_id: sub.id, ok: false, gone: status === 404 || status === 410 });
      }
    }
  }
  const outcome = results.length ? await store.recordPushResults(results) : { sent: 0, dropped: 0 };
  log.info('push delivered', { notifications: pending.length, sent: outcome.sent, failed, dropped: outcome.dropped });
  return { notifications: pending.length, sent: outcome.sent, failed, dropped: outcome.dropped };
}
