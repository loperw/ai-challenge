const DEEPSEEK_MODELS = new Set(['deepseek-flash']);
const GEMINI_MODELS = new Set(['gemini-3.5-flash-lite', 'gemini-3.5-flash']);

const JSON_SYSTEM_PROMPT = 'Формат ответа: строгий JSON. Верни строго один валидный JSON-объект без Markdown, пояснений или текста вне JSON.';

class AgentError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'AgentError';
    this.status = status;
  }
}

async function upstreamError(upstream, fallback) {
  try {
    const payload = await upstream.json();
    return payload.error?.message || payload.error?.status || payload.message || fallback;
  } catch {
    return fallback;
  }
}

async function* ssePayloads(body) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop();
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }

  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) {
    if (line.startsWith('data:')) yield line.slice(5).trim();
  }
}

function validatedSettings(settings) {
  const provider = settings.provider;
  const model = settings.model;
  if (!['deepseek', 'openrouter', 'gemini'].includes(provider)) {
    throw new AgentError('Неизвестный провайдер модели.', 400);
  }
  if (typeof model !== 'string'
    || (provider === 'deepseek' && !DEEPSEEK_MODELS.has(model))
    || (provider === 'gemini' && !GEMINI_MODELS.has(model))
    || (provider === 'openrouter' && model !== 'openrouter/free' && !model.endsWith(':free'))) {
    throw new AgentError('Выберите модель из списка.', 400);
  }

  const maxTokens = settings.maxTokens === '' || settings.maxTokens === undefined
    ? undefined
    : Number(settings.maxTokens);
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 384000)) {
    throw new AgentError('Количество токенов должно быть целым числом от 1 до 384000.', 400);
  }

  const temperature = settings.temperature === '' || settings.temperature === undefined
    ? 1
    : Number(settings.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new AgentError('Температура должна быть числом от 0 до 2.', 400);
  }

  return {
    provider,
    model,
    temperature,
    maxTokens,
    jsonMode: Boolean(settings.jsonMode),
    stopSequence: typeof settings.stopSequence === 'string' ? settings.stopSequence.trim() : '',
    systemPrompt: typeof settings.systemPrompt === 'string' ? settings.systemPrompt.trim() : ''
  };
}

class Agent {
  constructor(settings, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Для агента необходим fetch.');
    this.fetch = fetchImpl;
    this.messages = [];
    this.busy = false;
    this.configure(settings);
  }

  configure(settings) {
    this.settings = validatedSettings(settings);
  }

  reset() {
    if (this.busy) throw new AgentError('Дождитесь завершения ответа агента.', 409);
    this.messages = [];
  }

  systemPrompt() {
    return [this.settings.systemPrompt, this.settings.jsonMode ? JSON_SYSTEM_PROMPT : '']
      .filter(Boolean).join('\n\n');
  }

  async respond(userRequest, { onStart = () => {}, onToken = () => {} } = {}) {
    const content = typeof userRequest === 'string' ? userRequest.trim() : '';
    if (!content) throw new AgentError('Добавьте сообщение.', 400);
    if (this.busy) throw new AgentError('Агент уже обрабатывает сообщение.', 409);

    this.busy = true;
    const historyLength = this.messages.length;
    this.messages.push({ role: 'user', content });
    let answer = '';

    try {
      const upstream = await this.createCompletion();
      onStart();
      for await (const token of this.readCompletion(upstream)) {
        answer += token;
        onToken(token);
      }
      if (!answer) throw new AgentError('Сервис не вернул текст ответа.', 502);
      this.messages.push({ role: 'assistant', content: answer });
      return answer;
    } catch (error) {
      this.messages.length = historyLength;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async createCompletion() {
    if (this.settings.provider === 'gemini') return this.createGeminiCompletion();

    const isDeepSeek = this.settings.provider === 'deepseek';
    const environmentKey = isDeepSeek ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY';
    const apiKey = process.env[environmentKey];
    if (!apiKey) throw new AgentError(`В локальном файле .env не задан ${environmentKey}.`);

    const systemPrompt = this.systemPrompt();
    const body = {
      model: this.settings.model,
      messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...this.messages],
      temperature: this.settings.temperature,
      stream: true,
      ...(isDeepSeek && { thinking: { type: 'disabled' } }),
      ...(this.settings.maxTokens !== undefined && { max_tokens: this.settings.maxTokens }),
      ...(this.settings.stopSequence && { stop: [this.settings.stopSequence] }),
      ...(this.settings.jsonMode && { response_format: { type: 'json_object' } })
    };
    const serviceName = isDeepSeek ? 'DeepSeek' : 'OpenRouter';
    const upstream = await this.fetch(isDeepSeek
      ? 'https://api.deepseek.com/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body)
    });
    if (!upstream.ok) {
      throw new AgentError(await upstreamError(upstream, `${serviceName} вернул ошибку.`), upstream.status);
    }
    return { provider: this.settings.provider, body: upstream.body };
  }

  async createGeminiCompletion() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new AgentError('В локальном файле .env не задан GEMINI_API_KEY.');

    const systemPrompt = this.systemPrompt();
    const body = {
      contents: this.messages.map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      })),
      ...(systemPrompt && { systemInstruction: { parts: [{ text: systemPrompt }] } }),
      generationConfig: {
        temperature: this.settings.temperature,
        ...(this.settings.maxTokens !== undefined && { maxOutputTokens: this.settings.maxTokens }),
        ...(this.settings.stopSequence && { stopSequences: [this.settings.stopSequence] }),
        ...(this.settings.jsonMode && { responseMimeType: 'application/json' })
      }
    };
    const upstream = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.settings.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!upstream.ok) {
      throw new AgentError(await upstreamError(upstream, 'Gemini вернул ошибку.'), upstream.status);
    }
    return { provider: 'gemini', body: upstream.body };
  }

  async *readCompletion(upstream) {
    for await (const data of ssePayloads(upstream.body)) {
      if (!data || data === '[DONE]') continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new AgentError('LLM вернула некорректный поток данных.', 502);
      }
      if (payload.error) throw new AgentError(payload.error.message || 'LLM вернула ошибку.', 502);

      if (upstream.provider === 'gemini') {
        for (const part of payload.candidates?.[0]?.content?.parts || []) {
          if (part.text) yield part.text;
        }
      } else {
        const token = payload.choices?.[0]?.delta?.content;
        if (token) yield token;
      }
    }
  }
}

class AgentRegistry {
  constructor(options = {}) {
    this.options = options;
    this.agents = new Map();
  }

  get(conversationId, settings) {
    let agent = this.agents.get(conversationId);
    if (!agent) {
      agent = new Agent(settings, this.options);
      this.agents.set(conversationId, agent);
    } else {
      agent.configure(settings);
    }
    return agent;
  }

  reset(conversationId) {
    const agent = this.agents.get(conversationId);
    if (agent) agent.reset();
  }
}

module.exports = { Agent, AgentError, AgentRegistry, validatedSettings };
