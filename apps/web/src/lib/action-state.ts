/** Return shape of every form Server Action (consumed by useActionState). */
export interface ActionState {
  readonly ok: boolean;
  readonly message?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

export const initialActionState: ActionState = { ok: false };
