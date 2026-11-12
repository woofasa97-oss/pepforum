import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PostForm } from '@/components/post/PostForm';
import { POST_FORM_LABEL_KEYS } from '@/components/post/post-form-labels';
import { Icon } from '@/components/ui/Icon';
import { describeRequirement } from '@/lib/errors';
import { pick } from '@/lib/i18n';
import { getLocale, getStanding, getT } from '@/server/context';
import { getLinkReview, getTaxonomy } from '@/server/queries';

export const metadata: Metadata = { title: 'Create post', robots: { index: false } };

export default async function SubmitPage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const [t, locale, standing, taxonomy, params, linkReview] = await Promise.all([getT(), getLocale(), getStanding(), getTaxonomy(), searchParams, getLinkReview()]);
  if (!standing) redirect('/auth/sign-in?next=/submit');

  const blocked = standing.capabilities.post_text;
  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('submit.title')}</h1>
            <p>{t('submit.sub')}</p>
          </div>
        </div>
        <div className="banner mb12"><Icon name="info" /><div>{t('submit.privacy')}</div></div>
        {blocked ? (
          <div className="card card-p">
            <div className="banner warn mb12"><Icon name="lock" /><div>{t('submit.locked')} ({describeRequirement(blocked, t)})</div></div>
            <Link className="btn" href="/karma">{t('nav.karma')}</Link>
          </div>
        ) : (
          <PostForm
            labels={pick(t, POST_FORM_LABEL_KEYS)}
            locale={locale}
            linkReview={linkReview && !standing.is_moderator}
            linkRequirement={standing.capabilities.post_link ? describeRequirement(standing.capabilities.post_link, t) : null}
            categories={taxonomy.categories.map((c) => ({ id: c.id, name: locale === 'fr' ? c.name_fr : c.name_en }))}
            defaults={{ category: params.category }}
            uploadRequirement={standing.capabilities.upload_image === null ? null : describeRequirement(standing.capabilities.upload_image, t)}
          />
        )}
      </main>
    </div>
  );
}
