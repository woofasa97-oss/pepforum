'use client';

import { AD_PACKAGES, type AdPackage, type MyCampaign } from '@pepforum/database';
import { useActionState, useState } from 'react';

import { ImageUploader } from '@/components/media/ImageUploader';
import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { upsertCampaignAction } from '@/server/actions/features';

interface Option { readonly id: string; readonly name: string }

interface Props {
  readonly labels: Record<string, string>;
  readonly categories: Option[];
  readonly cpm: Record<AdPackage, string>;
  readonly minBudgetCad: number;
  readonly campaign?: MyCampaign | undefined;
}

export function CampaignForm({ labels, categories, cpm, minBudgetCad, campaign }: Props) {
  const [state, action] = useActionState(upsertCampaignAction, initialActionState);
  const [pkg, setPkg] = useState<AdPackage>(campaign?.package ?? 'category');
  const errors = state.fieldErrors ?? {};
  // Every campaign needs French copy (…034).
  const frenchRequired = true;
  const locked = campaign ? !['draft', 'rejected'].includes(campaign.status) : false;

  return (
    <form action={action} className="card card-p">
      <FormMessage ok={state.ok} message={state.message} />
      {campaign ? <input type="hidden" name="id" value={campaign.id} /> : null}
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field">
          <label htmlFor="cp-name">{labels['ads.campaignName']}</label>
          <input id="cp-name" name="name" className="input" minLength={2} maxLength={80} required defaultValue={campaign?.name} aria-invalid={Boolean(errors.name)} />
          <FieldError message={errors.name} />
        </div>

        <fieldset className="field">
          <legend>{labels['ads.packageLabel']}</legend>
          <div className="col">
            {AD_PACKAGES.map((p) => (
              <label key={p} className="radio-card">
                <input type="radio" name="package" value={p} checked={pkg === p} onChange={() => setPkg(p)} />
                <span>
                  <span className="small bold">{labels[`ads.package.${p}`]}</span>
                  <span className="xs faint" style={{ display: 'block' }}>{labels[`ads.packageHint.${p}`]} · {cpm[p]} {labels['ads.cpm']}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {pkg === 'category' ? (
          <div className="field">
            <label htmlFor="cp-cat">{labels['submit.category']}</label>
            <select id="cp-cat" name="category" className="input" defaultValue={campaign?.category_id ?? categories[0]?.id}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="cp-budget">{labels['ads.budget']}</label>
          <input id="cp-budget" name="budgetCad" type="number" className="input" min={minBudgetCad} max={1000000} step={1} required
            defaultValue={campaign ? Math.round(campaign.budget / 1_000_000) : minBudgetCad} aria-describedby="cp-budget-hint" aria-invalid={Boolean(errors.budgetCad)} />
          <span id="cp-budget-hint" className="hint">{labels['ads.budgetHint']?.replace('{min}', String(minBudgetCad))}</span>
          <FieldError message={errors.budgetCad} />
        </div>

        <h3 className="mb8 mt16">{labels['ads.creative']}</h3>
        <p className="small muted mb12">{labels['ads.creativeHint']}</p>
        {(['en', 'fr'] as const).map((lang) => (
          <div key={lang} className="card card-p mb12" style={{ background: 'var(--surface-2)' }}>
            <p className="small bold mb8">{labels[`ads.copy.${lang}`]}{lang === 'fr' && !frenchRequired ? ` (${labels['ads.optional']})` : ''}</p>
            <div className="field">
              <label htmlFor={`cp-h-${lang}`}>{labels['ads.headline']}</label>
              <input id={`cp-h-${lang}`} name={lang === 'en' ? 'headline' : 'headlineFr'} className="input" maxLength={60} minLength={lang === 'en' || frenchRequired ? 3 : 0}
                required={lang === 'en' || frenchRequired} defaultValue={lang === 'en' ? campaign?.headline : campaign?.headline_fr} />
            </div>
            <div className="field">
              <label htmlFor={`cp-b-${lang}`}>{labels['ads.body']}</label>
              <textarea id={`cp-b-${lang}`} name={lang === 'en' ? 'body' : 'bodyFr'} className="input" maxLength={160} minLength={lang === 'en' || frenchRequired ? 10 : 0}
                required={lang === 'en' || frenchRequired} defaultValue={lang === 'en' ? campaign?.body : campaign?.body_fr} style={{ minHeight: 60 }} />
            </div>
            <div className="field">
              <label htmlFor={`cp-c-${lang}`}>{labels['ads.cta']}</label>
              <input id={`cp-c-${lang}`} name={lang === 'en' ? 'cta' : 'ctaFr'} className="input" maxLength={24} minLength={lang === 'en' || frenchRequired ? 2 : 0}
                required={lang === 'en' || frenchRequired} defaultValue={lang === 'en' ? campaign?.cta : campaign?.cta_fr} />
            </div>
          </div>
        ))}
        <FieldError message={errors.headline ?? errors.body ?? errors.cta ?? errors.headlineFr ?? errors.bodyFr ?? errors.ctaFr} />

        <div className="field">
          <label htmlFor="cp-url">{labels['ads.landing']}</label>
          <input id="cp-url" name="landingUrl" type="url" className="input" placeholder="https://" pattern="https://.+" required defaultValue={campaign?.landing_url}
            aria-describedby="cp-url-hint" aria-invalid={Boolean(errors.landingUrl)} />
          <span id="cp-url-hint" className="hint">{labels['ads.landingHint']}</span>
          <FieldError message={errors.landingUrl} />
        </div>

        <ImageUploader kind="ad_image" idField="imageId" max={1} initial={campaign?.image_id ? [{ id: campaign.image_id, alt: '' }] : []} labels={labels} />
      </fieldset>
      {locked ? <p className="small muted mb12">{labels['ads.locked']}</p> : <SubmitButton>{campaign ? labels['submit.save'] : labels['ads.createCampaign']}</SubmitButton>}
    </form>
  );
}
