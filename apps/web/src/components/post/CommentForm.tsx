'use client';

import { useActionState, useEffect, useRef } from 'react';

import { FieldError, FormMessage } from '@/components/ui/Bits';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { initialActionState } from '@/lib/action-state';
import { createCommentAction } from '@/server/actions/content';

interface Props {
  readonly postId: string;
  readonly parentId?: string;
  readonly labels: { placeholder: string; submit: string; hint?: string };
}

export function CommentForm({ postId, parentId, labels }: Props) {
  const [state, action] = useActionState(createCommentAction, initialActionState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  const id = `comment-${parentId ?? postId}`;
  return (
    <form ref={formRef} action={action} className="mt8">
      <FormMessage ok={false} message={state.ok ? undefined : state.message} />
      <input type="hidden" name="postId" value={postId} />
      {parentId ? <input type="hidden" name="parentId" value={parentId} /> : null}
      <label htmlFor={id} className="vh">{labels.placeholder}</label>
      <textarea id={id} name="body" className="input" placeholder={labels.placeholder} maxLength={5000} required style={{ minHeight: parentId ? 60 : 80 }}
        aria-invalid={Boolean(state.fieldErrors?.body)} />
      <FieldError message={state.fieldErrors?.body} />
      <div className="row between mt8 wrap">
        {labels.hint ? <span className="xs faint">{labels.hint}</span> : <span />}
        <SubmitButton className="btn dark sm">{labels.submit}</SubmitButton>
      </div>
    </form>
  );
}
