'use client';

import { VIOLATIONS } from '@pepforum/database';
import { useActionState } from 'react';

import { FormMessage } from '@/components/ui/Bits';
import { initialActionState } from '@/lib/action-state';
import { decideAppealAction, resolveReportsAction } from '@/server/actions/moderation';

type Labels = Record<string, string>;

interface Report {
  readonly id: string;
  readonly reason: string;
  readonly details: string;
  readonly reporter: string;
  readonly weight: number;
}

export function ResolveForm({ kind, targetId, reports, labels }: { kind: 'post' | 'comment'; targetId: string; reports: readonly Report[]; labels: Labels }) {
  const [state, action] = useActionState(resolveReportsAction, initialActionState);
  if (state.ok) return <FormMessage ok message={state.message} />;
  return (
    <form action={action} className="mt12">
      <FormMessage ok={false} message={state.message} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="targetId" value={targetId} />
      <ul className="caps mb12">
        {reports.map((r) => (
          <li key={r.id}>
            <span>
              <b>{labels[`report.reason.${r.reason}`] ?? r.reason}</b> · u/{r.reporter} · {r.weight}
              {r.details ? <span className="faint"> — {r.details}</span> : null}
            </span>
            <label className="check xs">
              <input type="checkbox" name="abusive" value={r.id} />
              {labels['mod.markAbusive']}
            </label>
          </li>
        ))}
      </ul>
      <div className="row wrap" style={{ gap: 12, alignItems: 'flex-end' }}>
        <div className="field grow" style={{ margin: 0 }}>
          <label htmlFor={`v-${targetId}`}>{labels['mod.violation']}</label>
          <select id={`v-${targetId}`} name="violation" className="input" defaultValue="">
            <option value="">—</option>
            {VIOLATIONS.map((v) => <option key={v} value={v}>{labels[`report.reason.${v}`] ?? v}</option>)}
          </select>
        </div>
        <div className="field grow" style={{ margin: 0 }}>
          <label htmlFor={`r-${targetId}`}>{labels['mod.reason']}</label>
          <input id={`r-${targetId}`} name="reason" className="input" maxLength={500} />
        </div>
      </div>
      <div className="row mt12">
        <button type="submit" name="decision" value="remove" className="btn danger sm">{labels['mod.remove']}</button>
        <button type="submit" name="decision" value="keep" className="btn sm">{labels['mod.keep']}</button>
      </div>
    </form>
  );
}

export function AppealDecisionForm({ appealId, labels }: { appealId: string; labels: Labels }) {
  const [state, action] = useActionState(decideAppealAction, initialActionState);
  if (state.ok) return <FormMessage ok message={state.message} />;
  return (
    <form action={action} className="mt8">
      <FormMessage ok={false} message={state.message} />
      <input type="hidden" name="appealId" value={appealId} />
      <label className="vh" htmlFor={`an-${appealId}`}>{labels['mod.reason']}</label>
      <input id={`an-${appealId}`} name="note" className="input mb8" placeholder={labels['mod.reason']} minLength={3} maxLength={500} required />
      <div className="row">
        <button type="submit" name="uphold" value="true" className="btn sm">{labels['mod.uphold']}</button>
        <button type="submit" name="uphold" value="false" className="btn ghost sm">{labels['mod.deny']}</button>
      </div>
    </form>
  );
}
