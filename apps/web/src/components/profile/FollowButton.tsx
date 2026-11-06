'use client';

import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { followAction } from '@/server/actions/social';

/** Follow / Following on a profile. A form, so it works without JavaScript. */
export function FollowButton({ username, following, labels }: {
  username: string;
  following: boolean;
  labels: { follow: string; following: string; unfollow: string };
}) {
  const [state, action] = useActionState(followAction, initialActionState);
  return (
    <form action={action} className="follow-form">
      <input type="hidden" name="username" value={username} />
      <input type="hidden" name="follow" value={following ? 'false' : 'true'} />
      {following ? (
        <SubmitButton className="btn sm following">
          <Icon name="check" />
          <span className="when-idle">{labels.following}</span>
          <span className="when-hover">{labels.unfollow}</span>
        </SubmitButton>
      ) : (
        <SubmitButton className="btn sm dark"><Icon name="plus" />{labels.follow}</SubmitButton>
      )}
      {state.ok ? null : <FormMessage ok={false} message={state.message} />}
    </form>
  );
}
