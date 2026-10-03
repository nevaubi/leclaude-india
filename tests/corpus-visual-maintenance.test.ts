import {describe,it,expect,vi,beforeEach} from 'vitest';
import type {RemoteStore,SqlQuery} from '@/lib/db/remote';
const mocks=vi.hoisted(()=>({run:vi.fn(async()=>({counts:{stored:1,skipped:0,failed:0},items:[]}))}));
vi.mock('@/modules/media/visuals',()=>({runVisuals:mocks.run}));
vi.mock('@/lib/india/courts',()=>({COURTS:[{id:'sci'},{id:'hc-delhi'},{id:'hc-bombay'}]}));
vi.mock('@/modules/media/logos',()=>({REGULATOR_SITES:[{key:'sebi'}]}));
import {maintainCorpusVisuals} from '@/modules/india/corpus/visual-maintenance';
function fake(policy:Record<string,unknown>,known:string[]=[],attempts:Record<string,string>={},busy=false){const calls:SqlQuery[]=[];const s:RemoteStore={async query(q){calls.push(q);if(q.query.includes('SELECT value'))return [{value:JSON.stringify(q.params?.[0]==='corpus_quality_policy_v1'?policy:attempts)}];if(q.query.includes('RETURNING key'))return busy?[]:[{key:'lease'}];if(q.query.includes('SELECT key FROM visuals'))return known.map(key=>({key}));return [];},async transaction(qs){return Promise.all(qs.map(q=>s.query(q)));}};return {s,calls};}
beforeEach(()=>mocks.run.mockClear());
describe('bounded visual maintenance',()=>{
 it('requires persisted enablement',async()=>{const {s}=fake({enabled:false});expect(await maintainCorpusVisuals(s)).toMatchObject({stop:'disabled'});expect(mocks.run).not.toHaveBeenCalled();});
 it('does not duplicate a leased run',async()=>{const {s}=fake({enabled:true},[],{},true);expect(await maintainCorpusVisuals(s)).toMatchObject({stop:'busy'});expect(mocks.run).not.toHaveBeenCalled();});
 it('selects at most two missing targets, honors cooldown and releases its own lease',async()=>{const {s,calls}=fake({enabled:true},['sci'],{'hc-delhi':new Date().toISOString()});await maintainCorpusVisuals(s);expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({keys:['hc-bombay','sebi'],refresh:false}),expect.objectContaining({deadlineMs:110000,concurrency:2,maxTries:2}));expect(calls.some(q=>q.query.includes('DELETE FROM corpus_state')&&q.query.includes("owner"))).toBe(true);});
});
