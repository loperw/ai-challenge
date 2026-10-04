const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Agent } = require('../agent');
const { SQLiteStore } = require('../sqlite-store');
const { searchBook } = require('../document-search');

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
        return new Response('data: '+JSON.stringify({choices:[{delta:{content:'Ответ [1], PDF 34.'}}]})+'\n\ndata: [DONE]\n\n');
      }
    });
    await agent.respond('data class', {documentSearch:result,toolsEnabled:false});
    assert.match(requests[0].messages[0].content,/Data classes store data/);
    assert.deepEqual(agent.messages.at(-1).documentSearch,result);
    assert.equal(agent.documentSearch,null);
    store.database.close(); store = new SQLiteStore(file);
    assert.deepEqual(store.chats.rag.messages.at(-1).documentSearch,result);
    await agent.respond('Обычный вопрос',{toolsEnabled:false});
    assert.ok(!requests[1].messages.some(message=>message.role==='system' && message.content.includes('Data classes store data')));
    assert.equal(agent.messages.at(-1).documentSearch,undefined);
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
