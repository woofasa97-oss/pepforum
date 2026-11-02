import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { ShieldTestForm } from '@/components/admin/ShieldTestForm';
import { EmptyState } from '@/components/ui/Bits';
import { Icon } from '@/components/ui/Icon';
import { formatDate, relativeTime } from '@/lib/format';
import { shieldAddAction, shieldRemoveAction } from '@/server/actions/admin';
import { adminShield } from '@/server/admin';
import { getLocale, getT } from '@/server/context';

export const metadata: Metadata = { title: 'Sourcing shield' };

export default async function AdminShieldPage() {
  const [t, locale, result] = await Promise.all([getT(), getLocale(), adminShield()]);
  const header = <PageHeader title={t('admin.shield.title')} sub={t('admin.shield.sub')} />;
  if (!result.ok) return <>{header}<DataUnavailable result={result} t={t} /></>;
  const s = result.data;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };

  return (
    <>
      {header}

      {s.held_now > 0 ? (
        <div className="banner warn mb16" role="status">
          <Icon name="shield" />
          <div>{t('admin.shield.heldNow', { n: s.held_now })} <Link className="link" href="/admin/moderation">{t('admin.shield.review')}</Link></div>
        </div>
      ) : null}

      <div className="grid2 mb16" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <section className="card card-p" aria-labelledby="phrases-h">
          <div className="row between wrap mb8">
            <h2 id="phrases-h" style={{ fontSize: 16 }}>{t('admin.shield.phrases')}</h2>
            <ActionForm action={shieldAddAction} label={t('admin.shield.addPhrase')} submit={t('admin.shield.add')}
              consequence={t('admin.shield.phraseHelp')} hidden={{ kind: 'phrase' }} labels={labels}>
              <div className="field">
                <label htmlFor="phrase-value">{t('admin.shield.phrase')}</label>
                <input id="phrase-value" name="value" className="input" minLength={2} maxLength={60} required />
              </div>
              <div className="field">
                <label htmlFor="phrase-action">{t('admin.shield.action')}</label>
                <select id="phrase-action" name="action" className="input" defaultValue="hold">
                  <option value="hold">{t('admin.shield.holdLong')}</option>
                  <option value="block">{t('admin.shield.blockLong')}</option>
                </select>
              </div>
            </ActionForm>
          </div>
          <p className="small muted mb12">{t('admin.shield.phrasesHelp')}</p>
          {s.phrases.length === 0 ? <EmptyState title={t('admin.shield.noPhrases')} /> : (
            <table className="tbl">
              <thead><tr><th scope="col">{t('admin.shield.phrase')}</th><th scope="col">{t('admin.shield.action')}</th><th scope="col" className="num">{t('admin.shield.holds30')}</th><th scope="col" /></tr></thead>
              <tbody>
                {s.phrases.map((p) => (
                  <tr key={p.phrase}>
                    <td><code>{p.phrase}</code></td>
                    <td><span className={`pill ${p.action === 'block' ? 'red' : 'amber'}`}>{t(p.action === 'block' ? 'admin.shield.block' : 'admin.shield.hold')}</span></td>
                    <td className="num">{p.action === 'hold' ? p.holds_30d : '—'}</td>
                    <td>
                      <ActionForm action={shieldRemoveAction} label={t('admin.member.remove')} submit={t('admin.member.remove')} tone="danger"
                        hidden={{ kind: 'phrase', value: p.phrase }} labels={labels} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card card-p" aria-labelledby="domains-h">
          <div className="row between wrap mb8">
            <h2 id="domains-h" style={{ fontSize: 16 }}>{t('admin.shield.domains')}</h2>
            <ActionForm action={shieldAddAction} label={t('admin.shield.addDomain')} submit={t('admin.shield.add')}
              consequence={t('admin.shield.domainHelp')} hidden={{ kind: 'domain' }} labels={labels}
              reasons={[t('admin.reasons.vendorSite'), t('admin.reasons.scamSite')]}>
              <div className="field">
                <label htmlFor="domain-value">{t('admin.shield.domain')}</label>
                <input id="domain-value" name="value" className="input" placeholder="shop.example.com" maxLength={253} required />
              </div>
            </ActionForm>
          </div>
          <p className="small muted mb12">{t('admin.shield.domainsHelp')}</p>
          {s.domains.length === 0 ? <EmptyState title={t('admin.shield.noDomains')} /> : (
            <table className="tbl">
              <thead><tr><th scope="col">{t('admin.shield.domain')}</th><th scope="col">{t('admin.reason')}</th><th scope="col" /></tr></thead>
              <tbody>
                {s.domains.map((d) => (
                  <tr key={d.domain}>
                    <td><code>{d.domain}</code><span className="xs muted">{d.created_by ? `u/${d.created_by} · ` : ''}{formatDate(d.created_at, locale)}</span></td>
                    <td>{d.reason}</td>
                    <td>
                      <ActionForm action={shieldRemoveAction} label={t('admin.member.remove')} submit={t('admin.member.remove')} tone="danger"
                        hidden={{ kind: 'domain', value: d.domain }} labels={labels} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <div className="grid2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <section className="card card-p" aria-labelledby="test-h">
          <h2 id="test-h" style={{ fontSize: 16 }} className="mb8">{t('admin.shield.test')}</h2>
          <p className="small muted mb12">{t('admin.shield.testHelp')}</p>
          <ShieldTestForm labels={{ label: t('admin.shield.testLabel'), submit: t('admin.shield.testSubmit') }} />
        </section>
        <section className="card card-p" aria-labelledby="holds-h">
          <h2 id="holds-h" style={{ fontSize: 16 }} className="mb8">{t('admin.shield.recent')}</h2>
          <p className="xs faint mb8">{t('admin.shield.recentHelp')}</p>
          {s.recent_holds.length === 0 ? <EmptyState title={t('admin.shield.noHolds')} /> : (
            <ul className="caps">
              {s.recent_holds.map((h, i) => (
                <li key={`${h.created_at}-${i}`}>
                  <span>
                    {h.username ? <Link className="link" href={`/admin/people/${encodeURIComponent(h.username)}`}>u/{h.username}</Link> : '—'}
                    {' · '}<code>{h.rule}</code>
                  </span>
                  <span className="xs muted">{relativeTime(h.created_at, t)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
