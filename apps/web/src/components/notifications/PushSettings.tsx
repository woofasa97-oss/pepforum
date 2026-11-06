'use client';

import { useEffect, useState, useSyncExternalStore, useTransition } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { deletePushSubscriptionAction, savePushSubscriptionAction } from '@/server/actions/features';

interface Props {
  /** VAPID public key (base64url). Absent when the deployment has no push keys. */
  readonly vapidPublicKey: string | null;
  readonly subscriptions: number;
  readonly labels: Record<string, string>;
}

function toUint8(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Web push for this browser (…022): registers /sw.js, asks permission, and
 * hands the subscription to a Server Action. The subscription's keys are the
 * only thing stored; the worker uses them to send through the push service.
 */
const noSubscribe = () => () => {};
const browserSupportsPush = () => 'serviceWorker' in navigator && 'PushManager' in window;

export function PushSettings({ vapidPublicKey, subscriptions, labels }: Props) {
  // null while server-rendering (unknown), then the browser's answer.
  const browserOk = useSyncExternalStore(noSubscribe, browserSupportsPush, () => null);
  const supported = browserOk === null ? null : browserOk && Boolean(vapidPublicKey);
  const [subscribedHere, setSubscribedHere] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.getRegistration('/sw.js').then(async (registration) => {
      const existing = await registration?.pushManager.getSubscription();
      setSubscribedHere(Boolean(existing));
    });
  }, [supported]);

  const enable = () => start(async () => {
    setMessage(null);
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setMessage({ ok: false, text: labels['notifications.pushDenied'] ?? '' });
        return;
      }
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toUint8(vapidPublicKey ?? '') as BufferSource });
      const json = subscription.toJSON();
      const result = await savePushSubscriptionAction({
        endpoint: json.endpoint ?? '', p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '', userAgent: navigator.userAgent,
      });
      setSubscribedHere(result.ok);
      setMessage({ ok: result.ok, text: result.message ?? '' });
    } catch {
      setMessage({ ok: false, text: labels['notifications.pushFailed'] ?? '' });
    }
  });

  const disable = () => start(async () => {
    setMessage(null);
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      const result = await deletePushSubscriptionAction({ endpoint: subscription.endpoint });
      await subscription.unsubscribe();
      setMessage({ ok: result.ok, text: result.message ?? '' });
    }
    setSubscribedHere(false);
  });

  if (supported === null) return null;
  if (!supported) return <p className="small muted">{vapidPublicKey ? labels['notifications.pushUnsupported'] : labels['notifications.pushUnavailable']}</p>;

  return (
    <div>
      {message ? <FormMessage ok={message.ok} message={message.text} /> : null}
      <p className="small muted mb8">{labels['notifications.pushBody']}</p>
      <p className="xs faint mb8">{(labels['notifications.pushBrowsers'] ?? '').replace('{n}', String(subscriptions))}</p>
      {subscribedHere ? (
        <button type="button" className="btn sm" disabled={pending} onClick={disable}>{labels['notifications.pushDisable']}</button>
      ) : (
        <button type="button" className="btn sm dark" disabled={pending} onClick={enable}>{labels['notifications.pushEnable']}</button>
      )}
    </div>
  );
}
