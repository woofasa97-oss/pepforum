'use client';

import { useActionState } from 'react';

import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { createAdvertiserAction } from '@/server/actions/features';

export function AdvertiserForm({ labels, countries }: { labels: Record<string, string>; countries: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState(createAdvertiserAction, initialActionState);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      <div className="field">
        <label htmlFor="adv-name">{labels['ads.orgName']}</label>
        <input id="adv-name" name="name" className="input" minLength={2} maxLength={80} required aria-invalid={Boolean(errors.name)} />
        <FieldError message={errors.name} />
      </div>
      <div className="field">
        <label htmlFor="adv-site">{labels['ads.orgWebsite']}</label>
        <input id="adv-site" name="website" type="url" className="input" placeholder="https://" pattern="https://.+" required aria-invalid={Boolean(errors.website)} />
        <FieldError message={errors.website} />
      </div>
      <div className="field">
        <label htmlFor="adv-email">{labels['ads.billingEmail']}</label>
        <input id="adv-email" name="billingEmail" type="email" className="input" required aria-invalid={Boolean(errors.billingEmail)} />
        <FieldError message={errors.billingEmail} />
      </div>
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="field grow">
          <label htmlFor="adv-addr">{labels['ads.billingAddress']}</label>
          <input id="adv-addr" name="billingAddress" className="input" maxLength={300} />
        </div>
        <div className="field">
          <label htmlFor="adv-country">{labels['ads.billingCountry']}</label>
          <select id="adv-country" name="billingCountry" className="input" defaultValue="" required>
            <option value="" disabled>—</option>
            {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
      <label className="check mb16">
        <input type="checkbox" required />
        <span>{labels['ads.orgAck']}</span>
      </label>
      <SubmitButton>{labels['ads.orgSubmit']}</SubmitButton>
    </form>
  );
}
