import { POST_TYPES } from '@pepforum/database';

import type { MessageKey } from '@/lib/i18n';

export const POST_FORM_LABEL_KEYS = [
  'submit.category', 'submit.type', 'submit.postTitle', 'submit.titleHint',
  'submit.body', 'submit.link', 'submit.linkReview', 'submit.ack', 'submit.publish', 'submit.save',
  'media.images', 'media.imagesHint', 'media.add', 'media.alt', 'media.remove', 'media.uploading',
  'media.err.tooLarge', 'media.err.type', 'media.err.denied', 'media.err.rateLimited', 'media.err.failed',
  ...POST_TYPES.map((p) => `post.type.${p}` as const),
  ...POST_TYPES.map((p) => `submit.type.${p}Hint` as const),
] satisfies MessageKey[];
