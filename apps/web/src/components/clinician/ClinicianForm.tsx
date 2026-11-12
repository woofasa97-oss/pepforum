'use client';

import { CLINICIAN_PROFESSIONS } from '@pepforum/database';
import { useActionState } from 'react';

import { ImageUploader } from '@/components/media/ImageUploader';
import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { submitClinicianAction } from '@/server/actions/features';

export function ClinicianForm({ labels, countries }: { labels: Record<string, string>; countries: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState(submitClinicianAction, initialActionState);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action}>
      <FormMessage ok={state.ok} message={state.message} />
      <div className="row wrap" style={{ gap: 12 }}>
        <div className="field grow">
          <label htmlFor="cl-prof">{labels['clinician.profession']}</label>
          <select id="cl-prof" name="profession" className="input" defaultValue="pharmacist">
            {CLINICIAN_PROFESSIONS.map((p) => <option key={p} value={p}>{labels[`clinician.profession.${p}`]}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="cl-country">{labels['clinician.country']}</label>
          <select id="cl-country" name="country" className="input" defaultValue="" required aria-invalid={Boolean(errors.country)}>
            <option value="" disabled>—</option>
            {countries.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <FieldError message={errors.country} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="cl-reg">{labels['clinician.regulator']}</label>
        <input id="cl-reg" name="regulator" className="input" minLength={2} maxLength={120} required aria-describedby="cl-reg-hint" aria-invalid={Boolean(errors.regulator)} />
        <span id="cl-reg-hint" className="hint">{labels['clinician.regulatorHint']}</span>
        <FieldError message={errors.regulator} />
      </div>
      <div className="field">
        <label htmlFor="cl-num">{labels['clinician.registration']}</label>
        <input id="cl-num" name="registrationNumber" className="input" minLength={2} maxLength={60} required autoComplete="off" aria-describedby="cl-num-hint" aria-invalid={Boolean(errors.registrationNumber)} />
        <span id="cl-num-hint" className="hint">{labels['clinician.registrationHint']}</span>
        <FieldError message={errors.registrationNumber} />
      </div>
      <ImageUploader kind="credential" idField="documentId" max={1} accept="application/pdf,image/jpeg,image/png,image/webp" labels={labels} />
      <FieldError message={errors.documentId} />
      <div className="field">
        <label htmlFor="cl-st">{labels['clinician.statement']}</label>
        <textarea id="cl-st" name="statement" className="input" maxLength={1000} style={{ minHeight: 80 }} aria-describedby="cl-st-hint" />
        <span id="cl-st-hint" className="hint">{labels['clinician.statementHint']}</span>
      </div>
      <SubmitButton>{labels['clinician.submit']}</SubmitButton>
    </form>
  );
}
