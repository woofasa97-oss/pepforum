import type { AdminOverview, JobName } from '@pepforum/database';

/** Background jobs the worker runs every 10 minutes. */
export const JOBS: readonly JobName[] = ['score_notes', 'maintenance', 'process_deletions'];

/** A job is late after 30 minutes and stalled after 60. */
export const JOB_LATE_MINUTES = 30;
export const JOB_STALLED_MINUTES = 60;

/** Minutes since a job last finished, or Infinity if it never ran. */
export function jobAgeMinutes(jobs: AdminOverview['jobs'], job: JobName, now = Date.now()): number {
  const at = jobs[job]?.at;
  return at ? (now - new Date(at).getTime()) / 60000 : Number.POSITIVE_INFINITY;
}

export type Health = 'ok' | 'late' | 'stalled';

export function jobHealth(jobs: AdminOverview['jobs'], job: JobName, now = Date.now()): Health {
  const age = jobAgeMinutes(jobs, job, now);
  if (jobs[job]?.ok === false || age > JOB_STALLED_MINUTES) return 'stalled';
  return age > JOB_LATE_MINUTES ? 'late' : 'ok';
}

export function systemNeedsAttention(o: Pick<AdminOverview, 'jobs' | 'security_problems'>, now = Date.now()): boolean {
  return o.security_problems > 0 || JOBS.some((job) => jobHealth(o.jobs, job, now) === 'stalled');
}

/** Whole hours (rounded up) from now until `iso`, never negative. */
export function hoursUntil(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 3600000));
}

export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** "YYYY-MM-DD" for `days` from now (date inputs' default value). */
export function isoDateInDays(days: number, now = Date.now()): string {
  return new Date(now + days * 86400000).toISOString().slice(0, 10);
}

export function isFuture(iso: string | null | undefined, now = Date.now()): boolean {
  return Boolean(iso) && new Date(iso as string).getTime() > now;
}

/** True when `iso` falls within the next `days` days. */
export function isWithinDays(iso: string, days: number, now = Date.now()): boolean {
  return new Date(iso).getTime() - now < days * 86400000;
}
