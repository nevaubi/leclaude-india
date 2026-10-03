import {afterEach,describe,expect,it,vi} from 'vitest';
import {createCartesiaAccessToken} from '@/modules/voice/provider';
afterEach(()=>vi.unstubAllGlobals());
describe('managed voice credentials',()=>{
  it('mints an agent grant for fifteen minutes instead of separate STT/TTS grants',async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({token:'temporary-agent-token'}));
    vi.stubGlobal('fetch',fetcher);
    expect(await createCartesiaAccessToken('test-key-not-real')).toBe('temporary-agent-token');
    const [url,request]=fetcher.mock.calls[0];
    expect(url).toBe('https://api.cartesia.ai/access-token');
    expect(JSON.parse(request.body)).toEqual({grants:{agent:true},expires_in:900});
  });
});
