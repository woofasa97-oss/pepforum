import { describe, expect, it } from 'vitest';

import { canonicalRedirect } from '@/lib/canonical-host';

const SITE = 'https://pepforums.com';

describe('canonicalRedirect (pepforum.ca → pepforums.com)', () => {
  it('sends the old domain and www hosts to the same page on the new one', () => {
    expect(canonicalRedirect('pepforum.ca', SITE, '/post/abc?x=1')).toBe('https://pepforums.com/post/abc?x=1');
    expect(canonicalRedirect('www.pepforum.ca', SITE, '/')).toBe('https://pepforums.com/');
    expect(canonicalRedirect('WWW.PepForums.com:443', SITE, '/notes')).toBe('https://pepforums.com/notes');
  });

  it('serves the canonical host, the Render URL, localhost and unknown hosts as they are', () => {
    expect(canonicalRedirect('pepforums.com', SITE, '/')).toBeNull();
    expect(canonicalRedirect('pepforum-web.onrender.com', SITE, '/')).toBeNull();
    expect(canonicalRedirect('localhost:3000', SITE, '/')).toBeNull();
    expect(canonicalRedirect('evil.example', SITE, '/')).toBeNull();
    expect(canonicalRedirect(null, SITE, '/')).toBeNull();
    expect(canonicalRedirect('pepforum.ca', undefined, '/')).toBeNull();
    expect(canonicalRedirect('pepforum.ca', 'not a url', '/')).toBeNull();
  });

  it('never lets the request pick the destination host', () => {
    expect(canonicalRedirect('pepforum.ca', SITE, '//evil.example/x')).toBe('https://pepforums.com/');
    expect(canonicalRedirect('pepforum.ca', SITE, 'https://evil.example')).toBe('https://pepforums.com/');
  });
});
