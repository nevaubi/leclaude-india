import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
it('does not label stored counts as model-current vectors or resolved citation targets',()=>{
 const source=readFileSync('src/modules/official-ui/components/corpus-quality-panel.tsx','utf8');
 expect(source).toContain('Judgment vectors stored');
 expect(source).toContain('Citation records extracted');
 expect(source).toContain('India Code sections stored');
 expect(source).not.toContain('Semantic-ready passages');
});
