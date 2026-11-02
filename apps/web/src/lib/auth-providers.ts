import type { Provider } from '@supabase/supabase-js';

/**
 * Every Supabase Auth OAuth provider that works as a plain "Continue with …"
 * button, in display order. A button appears only once the provider is
 * switched on in the Supabase dashboard (see getEnabledOAuthProviders).
 * Left out: keycloak and workos (need per-tenant parameters), and the
 * deprecated `linkedin` and `slack` in favour of their OIDC versions.
 */
export const OAUTH_PROVIDERS = [
  'google', 'apple', 'azure', 'facebook', 'x', 'twitter', 'discord', 'github', 'linkedin_oidc',
  'twitch', 'spotify', 'slack_oidc', 'gitlab', 'bitbucket', 'notion', 'figma', 'zoom', 'kakao',
] as const satisfies readonly Provider[];

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Brand names (not translated). */
export const PROVIDER_NAMES: Record<OAuthProvider, string> = {
  google: 'Google', apple: 'Apple', azure: 'Microsoft', facebook: 'Facebook', x: 'X', twitter: 'X (Twitter)',
  discord: 'Discord', github: 'GitHub', linkedin_oidc: 'LinkedIn', twitch: 'Twitch', spotify: 'Spotify',
  slack_oidc: 'Slack', gitlab: 'GitLab', bitbucket: 'Bitbucket', notion: 'Notion', figma: 'Figma', zoom: 'Zoom', kakao: 'Kakao',
};

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** Accounts created with the sign-up form have an `email` identity, i.e. a password. */
export function hasPassword(identities: ReadonlyArray<{ provider: string }> | undefined): boolean {
  return (identities ?? []).some((identity) => identity.provider === 'email');
}
