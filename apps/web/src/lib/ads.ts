/** Pill colour for a campaign status (never colour alone: the label is always shown). */
export const campaignTone = (status: string): string =>
  status === 'active' ? 'green' : status === 'review' || status === 'paused' || status === 'pending' ? 'amber' : status === 'rejected' || status === 'suspended' ? 'red' : '';
