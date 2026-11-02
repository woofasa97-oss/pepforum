import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Liveness probe for Render (render.yaml → healthCheckPath). No dependencies, no data. */
export function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
