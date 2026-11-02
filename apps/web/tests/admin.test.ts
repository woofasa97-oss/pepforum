import { describe, expect, it } from 'vitest';

import { hoursUntil, isWithinDays, jobHealth, percent, systemNeedsAttention } from '@/lib/admin';
import { csvCell, toCsv } from '@/lib/csv';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

describe('job health', () => {
  it('is ok within 30 minutes, late after, stalled after an hour or on failure', () => {
    expect(jobHealth({ maintenance: { at: minutesAgo(9), ok: true } }, 'maintenance', NOW)).toBe('ok');
    expect(jobHealth({ maintenance: { at: minutesAgo(45), ok: true } }, 'maintenance', NOW)).toBe('late');
    expect(jobHealth({ maintenance: { at: minutesAgo(61), ok: true } }, 'maintenance', NOW)).toBe('stalled');
    expect(jobHealth({ maintenance: { at: minutesAgo(1), ok: false } }, 'maintenance', NOW)).toBe('stalled');
    expect(jobHealth({}, 'maintenance', NOW)).toBe('stalled');
  });

  it('flags the system page for stalled jobs or audit problems', () => {
    const fresh = { at: minutesAgo(5), ok: true };
    const jobs = { score_notes: fresh, maintenance: fresh, process_deletions: fresh };
    expect(systemNeedsAttention({ jobs, security_problems: 0 }, NOW)).toBe(false);
    expect(systemNeedsAttention({ jobs, security_problems: 1 }, NOW)).toBe(true);
    expect(systemNeedsAttention({ jobs: { ...jobs, maintenance: { at: minutesAgo(90), ok: true } }, security_problems: 0 }, NOW)).toBe(true);
  });

  it('formats small numbers safely', () => {
    expect(hoursUntil(new Date(NOW + 90 * 60000).toISOString(), NOW)).toBe(2);
    expect(hoursUntil(minutesAgo(10), NOW)).toBe(0);
    expect(percent(1, 3)).toBe(33);
    expect(percent(1, 0)).toBeNull();
    expect(isWithinDays(new Date(NOW + 3 * 86400000).toISOString(), 14, NOW)).toBe(true);
  });
});

describe('CSV export', () => {
  it.each(['=HYPERLINK("https://evil.example")', '+1+1', '-2', '@SUM(A1)', '\tcmd'])('neutralises formula %j', (value) => {
    expect(csvCell(value).replace(/^"/, '')).toMatch(/^'/);
  });

  it('quotes commas, quotes and newlines, and serialises objects', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell({ key: 'x' })).toBe('"{""key"":""x""}"');
    expect(csvCell(null)).toBe('');
    expect(toCsv([['a', 1], ['b', 2]])).toBe('a,1\r\nb,2\r\n');
  });
});
