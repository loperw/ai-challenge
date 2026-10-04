const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { describeIndexes } = require('../document-indexes');

test('index panel reads persisted metadata and tolerates absent/corrupt indexes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'document-panel-'));
  try {
    assert.equal(describeIndexes(directory).book, null);
    const db = new DatabaseSync(path.join(directory, 'fixed.sqlite'));
    db.exec('CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE chunks(text TEXT,metadata_json TEXT);');
    const metadata = {source:'book.pdf',source_sha256:'abc',dimensions:768,model:'nomic',size_chars:1000,overlap_chars:150};
    for (const [key,value] of Object.entries(metadata)) db.prepare('INSERT INTO metadata VALUES (?,?)').run(key,JSON.stringify(value));
    db.prepare('INSERT INTO chunks VALUES (?,?)').run('Example',JSON.stringify({chunk_id:'one',section:'Introduction',page_start:1,page_end:1}));
    db.close();
    fs.writeFileSync(path.join(directory,'structure.sqlite'),'corrupt');
    fs.writeFileSync(path.join(directory,'preparation.json'),JSON.stringify({sha256:'another-book',pages:99}));
    const result=describeIndexes(directory);
    assert.equal(result.strategies.fixed.chunks,1);
    assert.equal(result.strategies.fixed.samples[0].section,'Introduction');
    assert.equal(result.book.pages,null);
    assert.equal(result.strategies.structure.available,false);
    assert.equal(result.strategies.fixed.seconds,null);
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});
