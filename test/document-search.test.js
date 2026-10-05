const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Agent } = require('../agent');
const { SQLiteStore } = require('../sqlite-store');
const { searchBook, documentPrompt } = require('../document-search');
const evidence = { status:'answered', answer:'Классы данных хранят данные [1].', sources:[1], quotes:[{source:1,text:'Data classes store data.'}] };

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
        const response = JSON.stringify(evidence);
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:response}}]})+'\n\ndata: [DONE]\n\n');
      }
    });
    await agent.respond('data class', {documentSearch:result,ragMode:'rag',toolsEnabled:false});
    assert.match(requests[0].messages.at(-1).content,/Data classes store data/);
    assert.deepEqual(agent.messages.at(-1).documentSearch.hits,result.hits);
    assert.deepEqual(agent.messages.at(-1).documentSearch.usedSources,[1]);
    assert.deepEqual(agent.messages.at(-1).documentSearch.quotes,evidence.quotes);
    assert.equal(agent.documentSearch,null);
    store.database.close(); store = new SQLiteStore(file);
    assert.deepEqual(store.chats.rag.messages.at(-1).documentSearch.hits,result.hits);
    assert.deepEqual(store.chats.rag.messages.at(-1).documentSearch.quotes,evidence.quotes);
    assert.equal(store.chats.rag.messages.at(-1).ragMode,'rag');
    await agent.respond('Обычный вопрос',{ragMode:'plain',toolsEnabled:false});
    assert.ok(!requests.at(-1).messages.some(message=>message.role==='system' && message.content.includes('Data classes store data')));
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
      const agent = new Agent({provider:'deepseek',model:'deepseek-flash'}, {fetchImpl:async (url, options) => {
        calls++;
        const response = sources.length ? {status:'answered',answer:'Второй факт [2].',sources,quotes:[{source:2,text:'Second fact exists.'}]}
            : {status:'unknown',answer:'Не знаю. Уточните вопрос.',sources:[],quotes:[]};
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(response)}}]})+'\n\ndata: [DONE]\n\n');
      }});
      const answer = await agent.respond('Вопрос', {documentSearch:{hits:[{text:'First fact exists.',score:.9},{text:'Second fact exists.',score:.9}]},toolsEnabled:false,onToken:t=>visible+=t});
      assert.match(answer,sources.length ? /Второй факт \[2\]/ : /Не знаю.*Уточните/s);
      assert.equal(visible,answer); assert.equal(calls,1);
      assert.deepEqual(agent.messages.at(-1).documentSearch.usedSources,sources);
    } finally { if(previousKey===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previousKey; }
  });
}
