const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('diff precedes question and Yes/No buttons; each sends only proposal ID and decision', async () => {
  const source = fs.readFileSync('public/app.js', 'utf8');
  const render = source.slice(source.indexOf('function renderProposals('));
  class Element {
    children = []; events = {}; textContent = ''; disabled = false;
    append(...items) { this.children.push(...items); }
    querySelector() { return null; }
    addEventListener(name, action) { this.events[name] = action; }
  }
  for (const approve of [true, false]) {
    const requests = [], body = new Element();
    const context = { WorkspaceDiff: { render: (node, proposal) => { node.textContent = proposal.diff; } }, document: { createElement: () => new Element() }, currentChat: () => ({ id: 'chat-1' }), saveChats() {},
      apiFetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ proposal: { status: approve ? 'applied' : 'rejected' } }) }; } };
    vm.createContext(context); vm.runInContext(render, context);
    context.renderProposals({ querySelector: () => body }, [{ id: 'proposal-1', diff: '-old\n+new', status: 'pending', purpose: 'documentation_update' }]);
    const panel = body.children[0].children[0];
    assert.equal(panel.children[0].textContent, '-old\n+new');
    assert.equal(panel.children[1].textContent, 'Исправить устаревшие сведения и сохранить изменения?');
    assert.deepEqual(panel.children.slice(2).map(e => e.textContent), ['Да', 'Нет']);
    assert.equal(requests.length, 0);
    await panel.children[approve ? 2 : 3].events.click();
    assert.deepEqual(requests, [{ url: '/api/workspace/decision', body: { conversationId: 'chat-1', id: 'proposal-1', approve } }]);
    assert.ok(panel.children.slice(2).every(e => e.disabled));
    assert.equal(panel.children[1].textContent, approve ? 'Изменения сохранены.' : 'Изменения отменены.');
  }
});
