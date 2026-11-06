/** Clinician verification helpers (…024). */

/** A member may apply again: nothing current, or an approval in its last 90 days. */
export function canApplyForVerification(latest: { status: string; expires_at: string | null } | null, now: number = Date.now()): boolean {
  if (!latest) return true;
  if (['rejected', 'revoked', 'withdrawn', 'expired'].includes(latest.status)) return true;
  return latest.status === 'approved' && latest.expires_at !== null && new Date(latest.expires_at).getTime() - now < 90 * 86_400_000;
}
