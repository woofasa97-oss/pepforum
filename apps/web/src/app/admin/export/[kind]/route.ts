import { type AdminLogEntry, type AdminMetrics, METRIC_KEYS } from '@pepforum/database';
import { type NextRequest, NextResponse } from 'next/server';

import { toCsv as csv } from '@/lib/csv';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * CSV downloads for admins: the moderation log and daily metrics. The RPCs
 * enforce admin + MFA; no email address is ever exported.
 */

function download(name: string, body: string) {
  return new NextResponse(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'private, no-store',
    },
  });
}

const MAX_LOG_PAGES = 10; // 1,000 entries

export async function GET(request: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const supabase = await createSupabaseServerClient();
  const today = new Date().toISOString().slice(0, 10);

  if (kind === 'modlog') {
    const rows: AdminLogEntry[] = [];
    let before: string | null = null;
    for (let n = 0; n < MAX_LOG_PAGES; n++) {
      const result = await supabase.rpc('admin_mod_log', { p_action: null, p_actor: null, p_target: null, p_before: before });
      if (result.error) return new NextResponse('Forbidden', { status: 403 });
      const page: AdminLogEntry[] = result.data;
      rows.push(...page);
      if (page.length < 100) break;
      before = page[page.length - 1]?.created_at ?? null;
    }
    return download(`pepforum-modlog-${today}.csv`, csv([
      ['created_at', 'actor', 'action', 'target_kind', 'target_id', 'target_user', 'reason', 'metadata'],
      ...rows.map((e) => [e.created_at, e.actor ?? 'system', e.action, e.target_kind, e.target_id, e.target_user, e.reason, e.metadata]),
    ]));
  }

  if (kind === 'metrics') {
    const days = ([7, 30, 90] as const).find((d) => String(d) === request.nextUrl.searchParams.get('days')) ?? 30;
    const { data, error } = await supabase.rpc('admin_metrics', { p_days: days });
    if (error) return new NextResponse('Forbidden', { status: 403 });
    const m = data as AdminMetrics;
    return download(`pepforum-metrics-${days}d-${today}.csv`, csv([
      ['date', ...METRIC_KEYS],
      ...m.days.map((d, i) => [d, ...METRIC_KEYS.map((k) => m.series[k][i] ?? 0)]),
    ]));
  }

  return new NextResponse('Not found', { status: 404 });
}
