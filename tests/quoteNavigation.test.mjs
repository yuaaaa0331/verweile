import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend } from '../js/storage.js';
import { normalizeQuoteReference, matchQuoteSource, resolveQuoteSource, followQuoteReference } from '../js/quoteNavigation.js';
const msg = (id, role='user', content='同一句话', ts=100, charId='c') => ({ id, role, content, timestamp:ts, charId });
const source = msg('reply','assistant','回复',200);

test('stable message ID disambiguates duplicate text and edited originals', () => {
  const a=msg('a'),b=msg('b','user','已编辑的原文');
  assert.equal(matchQuoteSource({messageId:'b',content:'旧内容'},[a,b],{charId:'c',sourceMessage:source}).target.id,'b');
});
test('a missing explicit ID never redirects to another identical message', () => {
  assert.deepEqual(matchQuoteSource({messageId:'deleted',content:'同一句话'},[msg('a')],{charId:'c',sourceMessage:source}),{ok:false,reason:'missing'});
});
test('legacy references resolve only a unique earlier source from the same character and speaker', () => {
  const rows=[msg('mine'),msg('other','user','同一句话',100,'other'),msg('later','user','同一句话',300),msg('ai','assistant')];
  assert.equal(matchQuoteSource({content:'同一句话',senderId:'user_me'},rows,{charId:'c',sourceMessage:source}).target.id,'mine');
  assert.equal(matchQuoteSource({content:'同一句话'},[msg('a'),msg('b')],{charId:'c',sourceMessage:source}).reason,'ambiguous');
});
test('ID references cannot escape to another character, a later message, or themselves', () => {
  for(const target of [msg('x','user','x',100,'other'),msg('x','user','x',300),source]) {
    assert.equal(matchQuoteSource({messageId:target.id},[target],{charId:'c',sourceMessage:source}).ok,false);
  }
});
test('old aliases normalize without losing the complete quotation', () => {
  const content='长消息'.repeat(300);
  assert.equal(normalizeQuoteReference({originalMessageId:'a',text:content}).content,content);
  assert.equal(normalizeQuoteReference({originalMessageId:'a'}).messageId,'a');
});
test('historical ID resolution reads one record even when the target is outside the rendered page', async () => {
  let allReads=0,shown=null;
  const backend={ get:async(table,id)=>{ assert.equal(table,'messages'); assert.equal(id,'old'); return msg('old'); }, getAllMessages:async()=>{allReads++;return [];} };
  const result=await followQuoteReference({backend,charId:'c',quote:{messageId:'old'},sourceMessage:source,showTarget:async m=>{shown=m.id;return true;}});
  assert.equal(result.ok,true); assert.equal(shown,'old'); assert.equal(allReads,0);
});
test('withdrawn and missing messages do not scroll or re-expose original content', async () => {
  const backend=new MemoryBackend(); await backend.init();
  await backend.put('messages',{...msg('withdrawn'),isWithdrawn:true});
  let shown=0;
  for(const id of ['withdrawn','deleted']) {
    const result=await followQuoteReference({backend,charId:'c',quote:{messageId:id},sourceMessage:source,showTarget:async()=>{shown++;}});
    assert.equal(result.ok,false);
  }
  assert.equal(shown,0);
});
test('unique legacy text lookup handles protocol wrappers via the injected renderer', async () => {
  const backend=new MemoryBackend(); await backend.init();
  await backend.put('messages',msg('a','user','[我 的消息：你好]'));
  const result=await resolveQuoteSource({backend,charId:'c',quote:{content:'你好'},sourceMessage:source,getText:m=>m.content.match(/：(.+)\]/)?.[1] || m.content});
  assert.equal(result.target.id,'a');
});
test('hidden source and storage failures do not report a successful jump', async () => {
  const options={charId:'c',quote:{messageId:'a'},sourceMessage:source,backend:{get:async()=>msg('a')},showTarget:async()=>false};
  assert.equal((await followQuoteReference(options)).reason,'hidden');
  await assert.rejects(()=>followQuoteReference({...options,backend:{get:async()=>{throw Error('storage');}}}),/storage/);
});
