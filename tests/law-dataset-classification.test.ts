import { readFileSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
describe('report datasets are not regulatory law',()=>{it('keeps the Law Commission classified as research in future bulk imports',()=>{const s=readFileSync('scripts/law-corpus/load_open_india_law.py','utf8');expect(s).toContain('"report" if name == "law-commission" else "regulation"');});});
