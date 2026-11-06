'use client';

import type { NotificationSettings } from '@pepforum/database';
import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { updateNotificationSettingsAction } from '@/server/actions/features';

const CATEGORIES = ['replies', 'notes', 'moderation', 'team'] as const;

export function NotificationSettingsForm({ settings, labels }: { settings: NotificationSettings; labels: Record<string, string> }) {
  const [state, action] = useActionState(updateNotificationSettingsAction, initialActionState);
  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      {CATEGORIES.map((c) => (
        <label key={c} className="check mb12">
          <input type="checkbox" name={c} defaultChecked={settings[c]} />
          <span>
            <span className="small bold" style={{ display: 'block' }}>{labels[`notifications.cat.${c}`]}</span>
            <span className="xs faint">{labels[`notifications.catHint.${c}`]}</span>
          </span>
        </label>
      ))}
      <input type="hidden" name="push" value={settings.push ? 'on' : ''} />
      <SubmitButton>{labels['settings.save']}</SubmitButton>
    </form>
  );
}
