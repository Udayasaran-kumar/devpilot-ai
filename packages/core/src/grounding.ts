import type { Evidence, EvidenceId } from './evidence.js';

/** Returns referenced evidence IDs that do not exist in the known evidence set, in first-seen order. */
export function findDanglingEvidenceIds(
  referencedIds: Iterable<EvidenceId>,
  knownEvidence: Iterable<Pick<Evidence, 'id'>>,
): EvidenceId[] {
  const known = new Set<EvidenceId>();
  for (const item of knownEvidence) {
    known.add(item.id);
  }
  const dangling = new Set<EvidenceId>();
  for (const id of referencedIds) {
    if (!known.has(id)) {
      dangling.add(id);
    }
  }
  return [...dangling];
}
