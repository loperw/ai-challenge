// Ollama stays on loopback: selecting a local model cannot route to a cloud provider.
const ENDPOINT = 'http://127.0.0.1:11434/api/chat';
const { localOptions } = require('./local-model-config');

async function* localStream(body, AgentError) {
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  function convert(line) {
    let item;
    try { item = JSON.parse(line); }
    catch { throw new AgentError('Ollama вернула некорректный поток данных.', 502); }
    if (item.error) throw new AgentError(String(item.error), 502);
    done ||= item.done === true;
    return Buffer.from(`data: ${JSON.stringify({
      choices: [{ delta: { content: item.message?.content || '' }, finish_reason: item.done ? (item.done_reason || 'stop') : null }],
      ...(item.done && { usage: {
        prompt_tokens: item.prompt_eval_count,
        completion_tokens: item.eval_count,
        total_tokens: (item.prompt_eval_count || 0) + (item.eval_count || 0)
      } })
    })}\n\n`);
  }
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) yield convert(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield convert(buffer);
    if (!done) throw new AgentError('Поток ответа Ollama оборвался. Повторите запрос.', 502);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('Соединение с Ollama прервано. Проверьте локальный сервер и повторите запрос.', 502);
  }
}

async function createLocalCompletion(agent, options, AgentError) {
  const settings = agent.settings;
  const system = [agent.systemPrompt(), options.toolPrompt].filter(Boolean).join('\n\n');
  const messages = options.messages || agent.contextMessages().map(({ role, content }) => ({ role, content }));
  const requestMessages = [...(system ? [{ role: 'system', content: system }] : []), ...messages];
  const generationOptions = localOptions(settings, requestMessages, agent.responseTokenLimit(options));
  let response;
  try {
    response = await agent.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(300_000),
      body: JSON.stringify({
        model: settings.model, stream: true, think: false,
        messages: requestMessages,
        ...((settings.jsonMode || agent.documentSearch) && { format: 'json' }),
        options: {
          ...generationOptions,
          ...(settings.stopSequence && { stop: [settings.stopSequence] })
        }
      })
    });
  } catch {
    throw new AgentError('Ollama недоступна или не ответила вовремя. Запустите scripts/start-index-ollama.ps1 и повторите запрос.', 503);
  }
  if (!response.ok) {
    if (response.status === 404) throw new AgentError(`Локальная модель не установлена. Выполните: ollama pull ${settings.model}`, 503);
    let detail = '';
    try { detail = (await response.json()).error || ''; } catch { }
    throw new AgentError(`Ошибка Ollama: ${detail || response.status}`, 502);
  }
  return { provider: 'local', body: localStream(response.body, AgentError) };
}

module.exports = { createLocalCompletion };
