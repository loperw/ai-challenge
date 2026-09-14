// Use the outermost list so nested examples do not become separate branches.
function extractBranchOptions(answer) {
  const lines = answer.split(/\r?\n/);
  const headings = lines.map((line, index) => {
    const match = line.match(/^\s*(#{1,6})\s+(?:\d+[.)]\s*)?(.+)$/);
    return match ? { index, level: match[1].length, text: match[2] } : null;
  }).filter(Boolean);
  const listed = lines.map((line, index) => {
    const match = line.match(/^(\s*)(\d+[.)]|[-*+•])\s+(.+)$/);
    return match ? { index, indent: match[1].length, numbered: /^\d/.test(match[2]), text: match[3] } : null;
  }).filter(Boolean);
  // Section headings enclose their bullet-point descriptions. Examine the
  // heading hierarchy first, even when the descriptions contain long lists.
  let items = [];
  for (const level of [...new Set(headings.map(item => item.level))].sort()) {
    const peers = headings.filter(item => item.level === level);
    if (peers.length >= 2 && (!listed.length || peers[0].index < listed[0].index)) {
      items = peers;
      break;
    }
  }
  if (!items.length) {
    const minIndent = Math.min(...listed.map(item => item.indent));
    const outer = listed.filter(item => item.indent === minIndent);
    const numbered = outer.filter(item => item.numbered);
    items = numbered.length >= 2 && numbered[0].index === outer[0]?.index ? numbered : outer;
  }
  if (items.length < 2) return [];
  return items.map((item, index) => {
    const bold = item.text.match(/^\*\*(.+?)\*\*/);
    const name = (bold?.[1] || item.text.split(/\s+[—–]\s+|:\s/)[0])
      .replace(/[*`_]/g, '').trim().slice(0, 100);
    const detail = lines.slice(item.index, items[index + 1]?.index ?? lines.length).join('\n');
    return { name, detail };
  });
}

module.exports = { extractBranchOptions };
