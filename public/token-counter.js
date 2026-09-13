// Portable preview heuristic, NOT a model tokenizer. API usage is authoritative.
(function (root) {
  function estimateTokens(text = '') {
    let weight = 0;
    for (const char of text) weight += char.codePointAt(0) <= 127 ? 0.25 : 0.5;
    return Math.ceil(weight);
  }
  function estimateHistory(messages = []) {
    return messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  }
  const api = { estimateTokens, estimateHistory };
  if (typeof module !== 'undefined') module.exports = api;
  else root.TokenCounter = api;
})(globalThis);
