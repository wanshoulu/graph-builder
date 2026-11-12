import type { GraphStatus } from '@/api/orgGraph';

/**
 * Resolve the exact document shown by the editor.
 * An explicit deep link wins; otherwise an existing draft is the editable source
 * of truth, followed by the active immutable version.
 */
export function resolveGraphLoadTarget(
  status: Pick<GraphStatus, 'activeVersion' | 'draft'>,
  requested?: string,
): string | undefined {
  if (requested) return requested;
  if (status.draft) return 'draft';
  return status.activeVersion || undefined;
}

/**
 * The display initializes its collapsed projection from the document. Distinguish
 * the pre-load render from the loaded render so async data cannot leave it expanded.
 */
export function graphDisplayInstanceKey(
  asset: string,
  version: string | undefined,
  hasDocument: boolean,
): string {
  return `${asset}:${version || 'empty'}:${hasDocument ? 'loaded' : 'empty'}`;
}
