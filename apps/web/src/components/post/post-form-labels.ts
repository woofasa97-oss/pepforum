import { POST_TYPES } from '@pepforum/database';

import type { MessageKey } from '@/lib/i18n';

export const POST_FORM_LABEL_KEYS = [
  'submit.zone', 'submit.city', 'submit.wholeZone', 'submit.category', 'submit.type', 'submit.postTitle', 'submit.titleHint',
  'submit.body', 'submit.link', 'submit.linkReview', 'submit.ack', 'submit.publish', 'submit.save',
  ...POST_TYPES.map((p) => `post.type.${p}` as const),
  ...POST_TYPES.map((p) => `submit.type.${p}Hint` as const),
] satisfies MessageKey[];
