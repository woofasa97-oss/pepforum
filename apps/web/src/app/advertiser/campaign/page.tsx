import { AD_PACKAGES, formatCad } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { CampaignForm } from '@/components/ads/CampaignForm';
import { ActionForm } from '@/components/admin/ActionForm';
import { Icon } from '@/components/ui/Icon';
import { campaignTone } from '@/lib/ads';
import { formatDay } from '@/lib/format';
import { type MessageKey, pick } from '@/lib/i18n';
import { isUuid } from '@/lib/params';
import { pauseCampaignAction, submitCampaignAction, withdrawCampaignAction } from '@/server/actions/features';
import { getLocale, getT, getViewer } from '@/server/context';
import { getAdRateCard, getMyAdvertiser, getTaxonomy } from '@/server/queries';

export const metadata: Metadata = { title: 'Campaign', robots: { index: false } };

const FORM_LABEL_KEYS = [
  'ads.campaignName', 'ads.packageLabel', 'ads.cpm', 'submit.category', 'ads.budget', 'ads.budgetHint', 'ads.creative', 'ads.creativeHint',
  'ads.copy.en', 'ads.copy.fr', 'ads.optional', 'ads.headline', 'ads.body', 'ads.cta', 'ads.landing', 'ads.landingHint', 'ads.locked', 'ads.createCampaign', 'submit.save',
  'media.images', 'media.imagesHint', 'media.add', 'media.alt', 'media.remove', 'media.uploading',
  'media.err.tooLarge', 'media.err.type', 'media.err.denied', 'media.err.rateLimited', 'media.err.failed',
  ...AD_PACKAGES.map((p) => `ads.package.${p}` as const),
  ...AD_PACKAGES.map((p) => `ads.packageHint.${p}` as const),
] satisfies MessageKey[];

export default async function CampaignPage({ searchParams }: { searchParams: Promise<{ id?: string; saved?: string }> }) {
  const [t, locale, viewer, params] = await Promise.all([getT(), getLocale(), getViewer(), searchParams]);
  if (!viewer) redirect('/auth/sign-in?next=/advertiser');
  const [adv, card, taxonomy] = await Promise.all([getMyAdvertiser(), getAdRateCard(), getTaxonomy()]);
  if (!adv || !card) redirect('/advertiser');
  const campaign = params.id ? adv.campaigns.find((c) => c.id === params.id) : undefined;
  if (params.id && (!isUuid(params.id) || !campaign)) notFound();
  if (!campaign && adv.status !== 'active') redirect('/advertiser');
  const fmt = (micro: number) => formatCad(micro, locale === 'fr' ? 'fr-CA' : 'en-CA');
  const reasonLabels = { reason: t('admin.reason'), reasonHint: t('admin.reasonHint') };

  return (
    <div className="page">
      <main id="main" className="narrow">
        <p className="xs faint mb8"><Link className="link" href="/advertiser">{adv.name}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{campaign ? campaign.name : t('ads.newCampaign')}</h1>
            {campaign ? <p className="row"><span className={`pill ${campaignTone(campaign.status)}`}>{t(`ads.status.${campaign.status}` as MessageKey)}</span></p> : <p>{t('ads.newCampaignSub')}</p>}
          </div>
        </div>
        {params.saved ? <div className="banner ok mb12"><Icon name="check" /><div>{t('ads.saved')}</div></div> : null}

        {campaign ? (
          <section className="card card-p mb16">
            {campaign.status === 'rejected' || campaign.status === 'suspended' ? (
              <div className="banner danger mb12"><Icon name="alert" /><div><b>{t('ads.teamNote')}:</b> {campaign.review_note}</div></div>
            ) : null}
            {campaign.status === 'review' ? <div className="banner mb12"><Icon name="clock" /><div>{t('ads.inReview')}</div></div> : null}
            {campaign.starts_on && campaign.ends_on ? (
              <p className="small mb8">{t('ads.flight', { from: formatDay(campaign.starts_on, locale), to: formatDay(campaign.ends_on, locale) })}</p>
            ) : null}
            <div className="stats mb12">
              <div className="stat"><div className="l">{t('ads.impressions')}</div><div className="v">{campaign.impressions.toLocaleString()}</div></div>
              <div className="stat"><div className="l">{t('ads.clicks')}</div><div className="v">{campaign.clicks.toLocaleString()}</div></div>
              <div className="stat"><div className="l">{t('ads.spent')}</div><div className="v">{fmt(campaign.spent)}</div><div className="xs muted">{t('ads.ofBudget', { budget: fmt(campaign.budget) })}</div></div>
            </div>
            <div className="row wrap" style={{ gap: 8 }}>
              {campaign.status === 'draft' || campaign.status === 'rejected' ? (
                <ActionForm action={submitCampaignAction} label={t('ads.submitReview')} submit={t('ads.submitReview')} tone="primary" requireReason={false}
                  consequence={t('ads.submitConsequence', { budget: fmt(campaign.budget), available: fmt(adv.available) })} hidden={{ id: campaign.id }} labels={reasonLabels} />
              ) : null}
              {campaign.status === 'active' ? (
                <ActionForm action={pauseCampaignAction} label={t('ads.pause')} submit={t('ads.pause')} requireReason={false} hidden={{ id: campaign.id, paused: 'true' }} labels={reasonLabels} />
              ) : null}
              {campaign.status === 'paused' ? (
                <ActionForm action={pauseCampaignAction} label={t('ads.resume')} submit={t('ads.resume')} tone="primary" requireReason={false} hidden={{ id: campaign.id, paused: 'false' }} labels={reasonLabels} />
              ) : null}
              {['draft', 'review', 'rejected'].includes(campaign.status) ? (
                <ActionForm action={withdrawCampaignAction} label={t('ads.withdraw')} submit={t('ads.withdraw')} tone="danger" requireReason={false}
                  consequence={t('ads.withdrawConsequence')} hidden={{ id: campaign.id }} labels={reasonLabels} />
              ) : null}
            </div>
            {campaign.days.length > 0 ? (
              <div className="tbl-wrap mt12">
                <table className="tbl">
                  <thead><tr><th>{t('ads.day')}</th><th>{t('ads.impressions')}</th><th>{t('ads.clicks')}</th><th style={{ textAlign: 'right' }}>{t('ads.charged')}</th></tr></thead>
                  <tbody>
                    {campaign.days.map((d) => (
                      <tr key={d.day}><td>{formatDay(d.day, locale)}</td><td>{d.impressions}</td><td>{d.clicks}</td><td style={{ textAlign: 'right' }}>{d.settled ? fmt(d.charged) : t('ads.open')}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ) : null}

        <CampaignForm
          labels={pick(t, FORM_LABEL_KEYS)}
          categories={taxonomy.categories.map((c) => ({ id: c.id, name: locale === 'fr' ? c.name_fr : c.name_en }))}
          cpm={{ category: fmt(card.cpm.category), national: fmt(card.cpm.national) }}
          minBudgetCad={Math.ceil(card.min_booking / 1_000_000)}
          campaign={campaign}
        />
      </main>
    </div>
  );
}
