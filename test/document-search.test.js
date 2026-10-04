const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Agent } = require('../agent');
const { SQLiteStore } = require('../sqlite-store');
const { searchBook, documentPrompt } = require('../document-search');

test('empty retrieval instructs the model to report missing context', () => {
  assert.match(documentPrompt({hits:[]}), /Подходящих фрагментов не найдено/);
});

test('retrieval context reaches the model, sources persist, and next turn clears context', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-chat-'));
  const file = path.join(directory, 'chat.sqlite');
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  let store = new SQLiteStore(file);
  const requests = [];
  const result = {strategy:'structure',query:'data class',hits:[{file:'book.pdf',section:'Классы данных',page_start:34,page_end:35,text:'Data classes store data.',chunk_id:'a',score:0.8}]};
  try {
    const agent = new Agent({provider:'deepseek',model:'deepseek-flash',maxTokens:2000}, {
      persist:(...args)=>store.save('rag',...args),
      fetchImpl:async (url, options)=> {
        requests.push(JSON.parse(options.body));
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Ответ [1], PDF 34.\nRAG_SOURCES: [1]'}}]})+'\n\ndata: [DONE]\n\n');
      }
    });
    await agent.respond('data class', {documentSearch:result,ragMode:'rag',toolsEnabled:false});
    assert.match(requests[0].messages.at(-1).content,/Data classes store data/);
    assert.deepEqual(agent.messages.at(-1).documentSearch.hits,result.hits);
    assert.deepEqual(agent.messages.at(-1).documentSearch.usedSources,[1]);
    assert.equal(agent.documentSearch,null);
    store.database.close(); store = new SQLiteStore(file);
    assert.deepEqual(store.chats.rag.messages.at(-1).documentSearch.hits,result.hits);
    assert.equal(store.chats.rag.messages.at(-1).ragMode,'rag');
    await agent.respond('Обычный вопрос',{ragMode:'plain',toolsEnabled:false});
    assert.ok(!requests[1].messages.some(message=>message.role==='system' && message.content.includes('Data classes store data')));
    assert.equal(agent.messages.at(-1).documentSearch,undefined);
    assert.equal(agent.messages.at(-1).ragMode,'plain');
    assert.equal(store.chats.rag.messages.at(-1).ragMode,'plain');
  } finally {
    store.database.close(); fs.rmSync(directory,{recursive:true,force:true});
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});

test('document search rejects traversal strategies and empty questions', async () => {
  await assert.rejects(searchBook('question','../../secret'),error=>error.status===400);
  await assert.rejects(searchBook('','fixed'),error=>error.status===400);
});


for (const sources of [[], [2]]) {
  test('RAG returns only selected sources ' + JSON.stringify(sources), async () => {
    const previousKey = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = 'test-key';
    let calls = 0; let visible = '';
    try {
      const agent = new Agent({provider:'deepseek',model:'deepseek-flash'}, {fetchImpl:async () => {
        calls++;
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Ответ\nRAG_SOURCES: '+JSON.stringify(sources)}}]})+'\n\ndata: [DONE]\n\n');
      }});
      assert.equal(await agent.respond('Вопрос', {documentSearch:{hits:[{text:'a'},{text:'b'}]},toolsEnabled:false,onToken:t=>visible+=t}), 'Ответ');
      assert.equal(visible,'Ответ'); assert.equal(calls,1);
      assert.deepEqual(agent.messages.at(-1).documentSearch.usedSources,sources);
    } finally { if(previousKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previousKey; }
  });
}
