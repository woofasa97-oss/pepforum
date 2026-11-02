import type { CommentRow } from '@pepforum/database';

export interface ThreadNode extends CommentRow {
  children: ThreadNode[];
}

/**
 * Rebuilds a comment thread from the flat, chronologically ordered list
 * returned by get_comments(). Orphans (parent hidden or missing) become roots
 * so no reply silently disappears.
 */
export function buildThread(rows: readonly CommentRow[]): ThreadNode[] {
  const byId = new Map<string, ThreadNode>(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots: ThreadNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}
