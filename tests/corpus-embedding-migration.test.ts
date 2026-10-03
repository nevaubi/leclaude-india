import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
const read=(p:string)=>fs.readFileSync(p,'utf8');
describe('model migration and retrieval isolation',()=>{
 it('schedules old-model official vectors for replacement without deleting source text',()=>{const t=read('src/modules/official/embed.ts');expect(t).toContain('embedding_model IS DISTINCT FROM');expect(t).toContain('embedding_dims IS DISTINCT FROM');expect(t).not.toMatch(/DELETE FROM official_chunks/);});
 it('compares only the active model for both semantic lanes',()=>{expect(read('src/modules/official/search.ts')).toContain('c.embedding_model = $2');expect(read('src/modules/india/corpus/hybrid.ts')).toMatch(/embedding_model\s*=\s*\$/);});
 it('never truncates text invisibly before embedding',()=>{expect(read('src/modules/official/embed.ts')).not.toContain('.slice(0, 8_000)');expect(read('src/modules/india/corpus/embeddings.ts')).not.toContain('left(t.text,');});
 it('honors the worker deadline at the embedding transport',()=>{expect(read('src/modules/india/corpus/quality.ts')).toContain('AbortSignal.timeout');});
});

it('filtered ANN continues scanning instead of under-returning the new model during migration',()=>{expect(read('src/modules/official/search.ts')).toContain("hnsw.iterative_scan");expect(read('src/modules/india/corpus/hybrid.ts')).toContain("hnsw.iterative_scan");});
