import { describe, expect, it } from 'vitest';
import type { AdapterContext } from '@/modules/official/adapter';
import { sourceDef, sourceEnabled } from '@/modules/official/registry';
import { sansadPlan, sansadStream } from '@/modules/official/adapters/regulators/sansad';
import { upsertDiscovered } from '@/modules/official/pipeline';
import { OfficialFakeStore } from './official-fakes';

describe('quality-first corpus retirement', () => {
  it('disables Gazette ingestion, including explicitly requested source runs', () => {
    expect(sourceEnabled('egazette')).toBe(false);
    expect(sourceDef('egazette')?.enabled).toBe(false);
  });
  it('retains Sansad reports and debates but does not advertise questions', () => {
    expect(sourceEnabled('sansad')).toBe(true);
    expect(sourceDef('sansad')?.kinds).toEqual(['parliament_debate', 'committee_report']);
  });
  it('does not even request question-session listings in a backfill', async () => {
    const calls: string[] = [];
    const ctx = { fetchJson: async (url: string) => { calls.push(url); return []; }, log() {} } as unknown as AdapterContext;
    expect(await sansadPlan(ctx, 'backfill', null)).toEqual(['elib:committee', 'elib:debates']);
    expect(calls).toEqual([]);
  });
  it('refuses legacy question streams stored in an old cursor', () => {
    expect(sansadStream('ls:18:5')).toBeNull();
    expect(sansadStream('rs:269:UNSTARRED')).toBeNull();
    expect(sansadStream('elib:committee')?.id).toBe('elib:committee');
  });
  it('blocks retired kinds at persistence while keeping neighbouring reports', async () => {
    const store = new OfficialFakeStore();
    const n = await upsertDiscovered(store, sourceDef('sansad')!, [
      { sourceId: 'sansad', kind: 'parliament_question', url: 'https://sansad.in/q.pdf', title: 'Question' },
      { sourceId: 'sansad', kind: 'committee_report', url: 'https://sansad.in/report.pdf', title: 'Committee report' },
    ]);
    expect(n).toBe(1);
    expect([...store.docs.values()].map(d => d.kind)).toEqual(['committee_report']);
    expect([...store.units.values()]).toHaveLength(1);
  });
});
