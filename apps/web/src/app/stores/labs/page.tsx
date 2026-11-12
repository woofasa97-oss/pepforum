import type { Metadata } from 'next';
import Link from 'next/link';

import { GoLink } from '@/components/prices/PriceBits';
import { PreviewBanner, StoresOff } from '@/components/stores/StoreBits';
import { EmptyState } from '@/components/ui/Bits';
import { countryName } from '@/lib/countries';
import { formatDay } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { getLocale, getT } from '@/server/context';
import { getStoreDirectory } from '@/server/queries';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('stores.labs.title'), description: t('stores.labs.sub'), alternates: { canonical: '/stores/labs' } };
}

const TONE = { accredited: 'green', recognised: 'amber', not_accepted: 'red', unknown: '' } as const;

/** The laboratories named on stores' certificates, and their tier under the Standard §3. */
export default async function LabsPage() {
  const [t, locale, directory] = await Promise.all([getT(), getLocale(), getStoreDirectory()]);
  if (!directory) return <StoresOff t={t} />;

  return (
    <div className="page">
      <main id="main" className="narrow">
        {directory.preview ? <PreviewBanner t={t} /> : null}
        <p className="small mb8"><Link className="link" href="/stores">{t('stores.back')}</Link></p>
        <div className="page-h">
          <div>
            <h1 tabIndex={-1}>{t('stores.labs.title')}</h1>
            <p>{t('stores.labs.sub')}</p>
          </div>
        </div>
        <section className="card card-p mb16">
          {directory.labs.length === 0 ? <EmptyState title={t('stores.labs.empty')} /> : (
            <ul className="store-list">
              {directory.labs.map((l) => (
                <li key={l.slug} className="audit-check">
                  <span>
                    <b>{l.has_website ? <GoLink kind="lab" id={l.slug} label={t('stores.labs.visit', { lab: l.name })}>{l.name}</GoLink> : l.name}</b>
                    {l.country ? <span className="muted small"> · {countryName(l.country, locale)}</span> : null}
                  </span>
                  <span className={`pill xs ${TONE[l.tier]}`.trim()}>{t(`stores.tier.${l.tier}` as MessageKey)}</span>
                  <dl className="facts ac-help">
                    {l.accreditation_body ? <div><dt>{t('stores.labs.accreditation')}</dt><dd>{l.accreditation_body}{l.accreditation_number ? ` · ${l.accreditation_number}` : ''}</dd></div> : null}
                    {l.verify_how ? <div><dt>{t('stores.labs.verify')}</dt><dd>{l.verify_how}</dd></div> : null}
                    {l.evidence_quote ? <div><dt>{t('stores.labs.evidence')}</dt><dd><blockquote lang="und">“{l.evidence_quote}”</blockquote></dd></div> : null}
                    <div><dt>{t('stores.labs.checked')}</dt><dd>{formatDay(l.checked_on, locale)}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
          <p className="xs faint mt12">{t('stores.labs.note')}</p>
        </section>
      </main>
    </div>
  );
}
