'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/** Disables itself while its form's Server Action is pending (no double submits). */
export function SubmitButton({ children, className = 'btn dark' }: { children: ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-disabled={pending}>
      {children}
    </button>
  );
}
