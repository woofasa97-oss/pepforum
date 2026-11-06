import type { SocialPlatform } from '@pepforum/database';

/** Brand names (not translated) and how each network writes a handle (…028). */
export const PLATFORM_NAMES: Readonly<Record<SocialPlatform, string>> = {
  x: 'X', youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', reddit: 'Reddit',
};

export function displayHandle(platform: SocialPlatform, handle: string): string {
  if (platform === 'reddit') return `u/${handle}`;
  if (platform === 'youtube') return handle;
  return handle.startsWith('@') ? handle : `@${handle}`;
}

/** YouTube counts subscribers; the others, followers. */
export const audienceKey = (platform: SocialPlatform): 'socials.subscribers' | 'socials.followers' =>
  platform === 'youtube' ? 'socials.subscribers' : 'socials.followers';
