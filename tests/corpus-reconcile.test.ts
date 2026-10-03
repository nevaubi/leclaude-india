import { describe, expect, it } from 'vitest';
import { assessChunkSet } from '@/modules/india/corpus/reconcile';
const complete = { chunks: 3, uniqueChunks: 3, first: 0, last: 2, expectedMin: 3, expectedMax: 3, declared: 3, nonempty: 3 };
describe('source-text completeness before metadata reconciliation', () => {
  it('labels only a contiguous declared chunk set as parsed text', () => { expect(assessChunkSet(complete)).toBe('full'); });
  it('does not call incomplete, duplicate, blank or inconsistently declared text complete', () => {
    for (const delta of [{ chunks: 2, uniqueChunks: 2 }, { uniqueChunks: 2 }, { first: 1 }, { last: 4 }, { expectedMax: 4 }, { declared: 2 }, { nonempty: 2 }]) expect(assessChunkSet({ ...complete, ...delta })).toBe('partial');
  });
  it('does not promote empty text at all', () => { expect(assessChunkSet({ ...complete, chunks: 0, nonempty: 0 })).toBeNull(); });
});
