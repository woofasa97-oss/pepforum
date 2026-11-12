import { type AdminConfigEntry, CONFIG_FIELDS, CONFIG_GROUPS, type ConfigField, NOTE_CLASSIFICATIONS, type SiteAnnouncement } from '@pepforum/database';
import type { Metadata } from 'next';
import Link from 'next/link';

import { ActionForm } from '@/components/admin/ActionForm';
import { DataUnavailable, PageHeader } from '@/components/admin/AdminBits';
import { Icon } from '@/components/ui/Icon';
import { formatDate, relativeTime } from '@/lib/format';
import type { MessageKey, Translate } from '@/lib/i18n';
import { announcementAction, archiveCategoryAction, setConfigAction, upsertCategoryAction } from '@/server/actions/admin';
import { adminConfig, adminConfigHistory } from '@/server/admin';
import { getLocale, getT } from '@/server/context';
import { getAllCategories } from '@/server/queries';

export const metadata: Metadata = { title: 'Rules & settings' };

const TABS = ['rules', 'taxonomy', 'announcement'] as const;
type Tab = (typeof TABS)[number];
const WINDOWS = [60, 3600, 86400, 604800] as const;

function windowLabel(seconds: number, t: Translate): string {
  if (seconds === 3600) return t('admin.cfgWindow.hour');
  if (seconds === 86400) return t('admin.cfgWindow.day');
  if (seconds === 604800) return t('admin.cfgWindow.week');
  if (seconds === 60) return t('admin.cfgWindow.minute');
  return t('admin.cfgWindow.seconds', { n: seconds });
}

/** The current value in words ("Trusted", "200 per hour", "0 · 100 · 1,000 …"). */
function formatValue(field: ConfigField, value: unknown, t: Translate): string {
  switch (field.input) {
    case 'tier':
      return t(`tier.${Number(value)}` as MessageKey);
    case 'tiers':
      return (value as number[]).map((n) => n.toLocaleString()).join(' · ');
    case 'boolean':
      return value ? t('admin.yes') : t('admin.no');
    case 'rate_limit': {
      const v = value as { limit: number; window_seconds: number };
      return t('admin.cfgRate', { n: v.limit, window: windowLabel(v.window_seconds, t) });
    }
    case 'scoring_mode':
      return t(value === 'bridging' ? 'admin.cfgMode.bridging' : 'admin.cfgMode.bootstrap');
    case 'classifications':
      return (value as string[]).map((c) => t(`notes.classification.${c}` as MessageKey)).join(', ') || t('admin.cfgNone');
    default:
      return field.unit ? t(`admin.unit.${field.unit}` as MessageKey, { n: Number(value).toLocaleString() }) : Number(value).toLocaleString();
  }
}

/** Typed inputs for one setting, prefilled with its current value. */
function ValueInputs({ field, entry, t }: { field: ConfigField; entry: AdminConfigEntry; t: Translate }) {
  const id = `cfg-${field.key.replace(/\./g, '-')}`;
  const bounds = entry.bounds ?? undefined;
  switch (field.input) {
    case 'integer':
    case 'decimal':
      return (
        <div className="field">
          <label htmlFor={id}>{t('admin.cfgNew')}</label>
          <input id={id} name="value" type="number" className="input" required defaultValue={String(entry.value)}
            step={field.input === 'integer' ? 1 : 'any'} min={bounds?.min} max={bounds?.max} />
          {bounds ? <span className="hint">{t('admin.cfgRange', { min: bounds.min, max: bounds.max })}</span> : null}
        </div>
      );
    case 'tier':
      return (
        <div className="field">
          <label htmlFor={id}>{t('admin.cfgNew')}</label>
          <select id={id} name="value" className="input" defaultValue={String(entry.value)}>
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{t(`tier.${n}` as MessageKey)}</option>)}
          </select>
        </div>
      );
    case 'boolean':
      return (
        <div className="field">
          <label htmlFor={id}>{t('admin.cfgNew')}</label>
          <select id={id} name="value" className="input" defaultValue={String(entry.value)}>
            <option value="true">{t('admin.yes')}</option>
            <option value="false">{t('admin.no')}</option>
          </select>
        </div>
      );
    case 'tiers':
      return (
        <fieldset className="field">
          <legend>{t('admin.cfgNew')}</legend>
          <div className="row wrap" style={{ gap: 6 }}>
            {(entry.value as number[]).map((n, i) => (
              <label key={i} className="xs" style={{ display: 'grid', gap: 2 }}>
                {t(`tier.${i}` as MessageKey)}
                <input name={`value${i}`} type="number" className="input" defaultValue={n} min={0} step={1} required readOnly={i === 0} style={{ width: 96 }} />
              </label>
            ))}
          </div>
        </fieldset>
      );
    case 'rate_limit': {
      const v = entry.value as { limit: number; window_seconds: number };
      return (
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="field">
            <label htmlFor={`${id}-limit`}>{t('admin.cfgLimit')}</label>
            <input id={`${id}-limit`} name="limit" type="number" className="input" min={0} max={100000} step={1} defaultValue={v.limit} required />
          </div>
          <div className="field">
            <label htmlFor={`${id}-window`}>{t('admin.cfgPer')}</label>
            <select id={`${id}-window`} name="window" className="input" defaultValue={String(v.window_seconds)}>
              {[...new Set([...WINDOWS, v.window_seconds])].map((w) => <option key={w} value={w}>{windowLabel(w, t)}</option>)}
            </select>
          </div>
        </div>
      );
    }
    case 'scoring_mode':
      return (
        <div className="field">
          <label htmlFor={id}>{t('admin.cfgNew')}</label>
          <select id={id} name="value" className="input" defaultValue={String(entry.value)}>
            <option value="bootstrap">{t('admin.cfgMode.bootstrap')}</option>
            <option value="bridging">{t('admin.cfgMode.bridging')}</option>
          </select>
        </div>
      );
    case 'classifications':
      return (
        <fieldset className="field">
          <legend>{t('admin.cfgNew')}</legend>
          {NOTE_CLASSIFICATIONS.map((c) => (
            <label key={c} className="check xs">
              <input type="checkbox" name="value" value={c} defaultChecked={(entry.value as string[]).includes(c)} />
              {t(`notes.classification.${c}` as MessageKey)}
            </label>
          ))}
        </fieldset>
      );
    default:
      return null;
  }
}

async function History({ entryKey, field, t, locale }: { entryKey: string; field: ConfigField | undefined; t: Translate; locale: string }) {
  const result = await adminConfigHistory(entryKey);
  if (!result.ok) return <DataUnavailable result={result} t={t} />;
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  return (
    <section id="history" className="card card-p mb16" aria-labelledby="history-h">
      <div className="row between wrap mb8">
        <h2 id="history-h" style={{ fontSize: 16 }}>{t('admin.cfgHistory', { label: t(`admin.cfg.${entryKey}` as MessageKey) })}</h2>
        <Link className="btn sm ghost" href="/admin/settings"><Icon name="x" />{t('admin.close')}</Link>
      </div>
      {result.data.length === 0 ? <p className="small muted">{t('admin.cfgNoHistory')}</p> : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.date')}</th><th scope="col">{t('admin.member.by')}</th><th scope="col">{t('admin.cfgChange')}</th><th scope="col">{t('admin.reason')}</th><th scope="col" /></tr></thead>
            <tbody>
              {result.data.map((c) => (
                <tr key={c.id}>
                  <td>{formatDate(c.at, locale)}</td>
                  <td>{c.by ? `u/${c.by}` : '—'}</td>
                  <td>{field ? `${formatValue(field, c.old, t)} → ${formatValue(field, c.new, t)}` : `${JSON.stringify(c.old)} → ${JSON.stringify(c.new)}`}</td>
                  <td>{c.reason}</td>
                  <td>
                    <ActionForm action={setConfigAction} label={t('admin.cfgRevert')} submit={t('admin.cfgRevert')}
                      consequence={t('admin.cfgRevertHelp', { value: field ? formatValue(field, c.old, t) : JSON.stringify(c.old) })}
                      hidden={{ key: entryKey, raw: JSON.stringify(c.old) }} labels={labels} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

async function RulesTab({ t, locale, history }: { t: Translate; locale: string; history: string | undefined }) {
  const result = await adminConfig();
  if (!result.ok) return <DataUnavailable result={result} t={t} />;
  const byKey = new Map(result.data.map((e) => [e.key, e]));
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const historyField = history ? CONFIG_FIELDS.find((f) => f.key === history) : undefined;
  return (
    <>
      {history && byKey.has(history) ? <History entryKey={history} field={historyField} t={t} locale={locale} /> : null}
      <nav className="row wrap mb16" style={{ gap: 6 }} aria-label={t('admin.cfgGroups')}>
        {CONFIG_GROUPS.map((g) => <a key={g} className="chip sm" href={`#group-${g}`}>{t(`admin.cfgGroup.${g}` as MessageKey)}</a>)}
      </nav>
      {CONFIG_GROUPS.map((group) => (
        <section key={group} id={`group-${group}`} className="admin-section card card-p" aria-labelledby={`group-${group}-h`}>
          <h2 id={`group-${group}-h`} style={{ fontSize: 16 }} className="mb8">{t(`admin.cfgGroup.${group}` as MessageKey)}</h2>
          <p className="small muted mb12">{t(`admin.cfgGroupHelp.${group}` as MessageKey)}</p>
          <ul className="caps">
            {CONFIG_FIELDS.filter((f) => f.group === group).map((field) => {
              const entry = byKey.get(field.key);
              if (!entry) return null;
              return (
                <li key={field.key} id={field.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start' }}>
                  <div>
                    <b>{t(`admin.cfg.${field.key}` as MessageKey)}</b>
                    <span className="xs muted" style={{ display: 'block' }}>{t(`admin.cfgHelp.${field.key}` as MessageKey)}</span>
                    {entry.last_change ? (
                      <span className="xs faint" style={{ display: 'block' }}>
                        {t('admin.cfgLast', { by: entry.last_change.by ?? '—', age: relativeTime(entry.last_change.at, t), reason: entry.last_change.reason })}
                        {' · '}<Link className="link" href={`/admin/settings?history=${encodeURIComponent(field.key)}#history`}>{t('admin.cfgHistoryLink')}</Link>
                      </span>
                    ) : null}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <b className="small" style={{ display: 'block', marginBottom: 6 }}>{formatValue(field, entry.value, t)}</b>
                    <ActionForm action={setConfigAction} label={t('admin.cfgEdit')} submit={t('admin.save')}
                      consequence={field.sensitive ? t('admin.cfgSensitive') : t('admin.cfgImmediate')} hidden={{ key: field.key }} labels={labels}>
                      <ValueInputs field={field} entry={entry} t={t} />
                    </ActionForm>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

async function TaxonomyTab({ t, locale }: { t: Translate; locale: string }) {
  const categories = await getAllCategories();
  const labels = { reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') };
  const categoryFields = (c?: (typeof categories)[number]) => (
    <>
      {!c ? (
        <div className="field">
          <label htmlFor="cat-id">{t('admin.tax.id')}</label>
          <input id="cat-id" name="id" className="input" pattern="[a-z0-9-]{2,40}" required />
          <span className="hint">{t('admin.tax.idHint')}</span>
        </div>
      ) : <input type="hidden" name="id" value={c.id} />}
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="field grow"><label htmlFor={`cat-en-${c?.id ?? 'new'}`}>{t('admin.tax.nameEn')}</label><input id={`cat-en-${c?.id ?? 'new'}`} name="nameEn" className="input" defaultValue={c?.name_en} required maxLength={60} /></div>
        <div className="field grow"><label htmlFor={`cat-fr-${c?.id ?? 'new'}`}>{t('admin.tax.nameFr')}</label><input id={`cat-fr-${c?.id ?? 'new'}`} name="nameFr" className="input" defaultValue={c?.name_fr} required maxLength={60} /></div>
      </div>
      <div className="field"><label htmlFor={`cat-den-${c?.id ?? 'new'}`}>{t('admin.tax.descEn')}</label><textarea id={`cat-den-${c?.id ?? 'new'}`} name="descriptionEn" className="input" rows={2} maxLength={500} defaultValue={c?.description_en} /></div>
      <div className="field"><label htmlFor={`cat-dfr-${c?.id ?? 'new'}`}>{t('admin.tax.descFr')}</label><textarea id={`cat-dfr-${c?.id ?? 'new'}`} name="descriptionFr" className="input" rows={2} maxLength={500} defaultValue={c?.description_fr} /></div>
      <div className="field"><label htmlFor={`cat-ren-${c?.id ?? 'new'}`}>{t('admin.tax.rulesEn')}</label><textarea id={`cat-ren-${c?.id ?? 'new'}`} name="rulesEn" className="input" rows={3} defaultValue={c?.rules_en.join('\n')} /><span className="hint">{t('admin.tax.rulesHint')}</span></div>
      <div className="field"><label htmlFor={`cat-rfr-${c?.id ?? 'new'}`}>{t('admin.tax.rulesFr')}</label><textarea id={`cat-rfr-${c?.id ?? 'new'}`} name="rulesFr" className="input" rows={3} defaultValue={c?.rules_fr.join('\n')} /></div>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="field"><label htmlFor={`cat-icon-${c?.id ?? 'new'}`}>{t('admin.tax.icon')}</label><input id={`cat-icon-${c?.id ?? 'new'}`} name="icon" className="input" defaultValue={c?.icon ?? 'book'} pattern="[a-z]{2,20}" required style={{ width: 120 }} /></div>
        <div className="field"><label htmlFor={`cat-min-${c?.id ?? 'new'}`}>{t('admin.tax.minRatings')}</label><input id={`cat-min-${c?.id ?? 'new'}`} name="minNoteRatings" type="number" min={3} max={200} className="input" defaultValue={c?.min_note_ratings ?? ''} style={{ width: 120 }} /></div>
        <div className="field"><label htmlFor={`cat-order-${c?.id ?? 'new'}`}>{t('admin.tax.order')}</label><input id={`cat-order-${c?.id ?? 'new'}`} name="sortOrder" type="number" min={0} max={999} className="input" defaultValue={c?.sort_order ?? 0} style={{ width: 100 }} required /></div>
      </div>
    </>
  );

  return (
    <>
      <section className="admin-section card card-p" aria-labelledby="cats-h">
        <div className="row between wrap mb8">
          <h2 id="cats-h" style={{ fontSize: 16 }}>{t('admin.tax.categories')}</h2>
          <ActionForm action={upsertCategoryAction} label={t('admin.tax.newCategory')} submit={t('admin.tax.create')} labels={labels}>
            {categoryFields()}
          </ActionForm>
        </div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th scope="col">{t('admin.tax.name')}</th><th scope="col" className="num">{t('admin.tax.minRatings')}</th><th scope="col" className="num">{t('admin.tax.order')}</th><th scope="col" /></tr></thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{locale === 'fr' ? c.name_fr : c.name_en}</b> <code className="xs">{c.id}</code>
                    {c.archived_at ? <span className="pill">{t('admin.tax.archived')}</span> : null}
                  </td>
                  <td className="num">{c.min_note_ratings ?? '—'}</td>
                  <td className="num">{c.sort_order}</td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end', alignItems: 'flex-start' }}>
                      <ActionForm action={upsertCategoryAction} label={t('admin.cfgEdit')} submit={t('admin.save')} labels={labels}>{categoryFields(c)}</ActionForm>
                      <ActionForm action={archiveCategoryAction} label={t(c.archived_at ? 'admin.tax.unarchive' : 'admin.tax.archive')}
                        submit={t(c.archived_at ? 'admin.tax.unarchive' : 'admin.tax.archive')} tone={c.archived_at ? 'normal' : 'danger'}
                        consequence={c.archived_at ? undefined : t('admin.tax.archiveHelp')} hidden={{ id: c.id, archived: c.archived_at ? 'false' : 'true' }} labels={labels} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

async function AnnouncementTab({ t }: { t: Translate }) {
  const result = await adminConfig();
  if (!result.ok) return <DataUnavailable result={result} t={t} />;
  const current = (result.data.find((e) => e.key === 'site.announcement')?.value ?? { en: '', fr: '', tone: 'info', until: null }) as SiteAnnouncement;
  const live = Boolean(current.en || current.fr) && (!current.until || current.until >= new Date().toISOString().slice(0, 10));
  return (
    <section className="card card-p" aria-labelledby="ann-h">
      <h2 id="ann-h" style={{ fontSize: 16 }} className="mb8">{t('admin.ann.title')}</h2>
      <p className="small muted mb12">{t('admin.ann.help')}</p>
      <p className="mb12">{live ? <span className="pill green">{t('admin.ann.live')}</span> : <span className="pill">{t('admin.ann.off')}</span>}</p>
      {live ? <div className={`banner ${current.tone === 'warn' ? 'warn' : 'info'} mb16`}><Icon name={current.tone === 'warn' ? 'alert' : 'info'} /><div>{current.en}<br /><span lang="fr">{current.fr}</span></div></div> : null}
      <ActionForm action={announcementAction} label={t('admin.ann.edit')} submit={t('admin.ann.publish')} open
        consequence={t('admin.ann.clearHint')} labels={{ reason: t('admin.reasonLabel'), reasonHint: t('admin.reasonHint') }}>
        <div className="field"><label htmlFor="ann-en">{t('admin.ann.en')}</label><textarea id="ann-en" name="en" className="input" rows={2} maxLength={280} defaultValue={current.en} /></div>
        <div className="field"><label htmlFor="ann-fr">{t('admin.ann.fr')}</label><textarea id="ann-fr" name="fr" className="input" rows={2} maxLength={280} defaultValue={current.fr} /></div>
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="field">
            <label htmlFor="ann-tone">{t('admin.ann.tone')}</label>
            <select id="ann-tone" name="tone" className="input" defaultValue={current.tone}>
              <option value="info">{t('admin.ann.info')}</option>
              <option value="warn">{t('admin.ann.warn')}</option>
            </select>
          </div>
          <div className="field"><label htmlFor="ann-until">{t('admin.ann.until')}</label><input id="ann-until" name="until" type="date" className="input" defaultValue={current.until ?? ''} /></div>
        </div>
      </ActionForm>
    </section>
  );
}

export default async function AdminSettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; history?: string }> }) {
  const [t, locale, params] = await Promise.all([getT(), getLocale(), searchParams]);
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'rules';
  return (
    <>
      <PageHeader title={t('admin.settings.title')} sub={t('admin.settings.sub')} />
      <nav className="tabs" aria-label={t('admin.settings.title')}>
        {TABS.map((x) => <Link key={x} href={`/admin/settings?tab=${x}`} aria-current={x === tab ? 'page' : undefined}>{t(`admin.settings.tab.${x}` as MessageKey)}</Link>)}
      </nav>
      {tab === 'rules' ? <RulesTab t={t} locale={locale} history={params.history} /> : null}
      {tab === 'taxonomy' ? <TaxonomyTab t={t} locale={locale} /> : null}
      {tab === 'announcement' ? <AnnouncementTab t={t} /> : null}
    </>
  );
}
