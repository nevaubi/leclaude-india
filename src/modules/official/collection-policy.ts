/** Deliberate corpus exclusions, not a claim that these materials lack legal value. */
export const RETIRED_COLLECTION_KINDS = ['parliament_question', 'gazette'] as const;
export const COLLECTION_POLICY_VERSION = '2026-10-03-quality-first';
export function retiredCollectionReason(source: string, kind?: string | null): string | null {
  if (source === 'egazette' || kind === 'gazette') return 'Gazette collection retired by operator policy; preserve references in retained legal instruments.';
  if (kind === 'parliament_question') return 'Parliamentary-question collection retired by operator policy; debates and committee reports remain available.';
  return null;
}
