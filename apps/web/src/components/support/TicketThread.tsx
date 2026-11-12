import { formatDate, relativeTime } from '@/lib/format';
import type { Translate } from '@/lib/i18n';

export interface ThreadMessage {
  readonly id: string;
  /** Who wrote it, already worded for the reader ("You", "Pepforums team", "u/name"). */
  readonly who: string;
  readonly fromStaff: boolean;
  readonly body: string;
  readonly createdAt: string;
}

/** A ticket's conversation, oldest first. Plain text only: bodies are never parsed as HTML or Markdown. */
export function TicketThread({ messages, t, locale, label }: { messages: readonly ThreadMessage[]; t: Translate; locale: string; label: string }) {
  return (
    <ol className="thread" aria-label={label}>
      {messages.map((m) => (
        <li key={m.id} className={m.fromStaff ? 'staff' : undefined}>
          <div className="who">
            <b>{m.who}</b>
            <time dateTime={m.createdAt} title={formatDate(m.createdAt, locale)}>{relativeTime(m.createdAt, t)}</time>
          </div>
          <p>{m.body}</p>
        </li>
      ))}
    </ol>
  );
}
