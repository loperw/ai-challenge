# API и схемы данных

## Запрос к чату

`POST /api/chat` принимает JSON: `conversationId` (идентификатор диалога), `message` (текст), `provider`, `model`, а также параметры генерации `temperature`, `maxTokens`, `jsonMode`. Для обычного сохранённого чата conversationId обязателен. Команда помощи передаётся как `message: "/help Где хранится история?"`.

Ответ передаётся как `text/event-stream`. Текст приходит в `choices[0].delta.content`. События могут содержать `mcpTrace`; итоговое событие содержит `messages`, `context` и `tokenStats`. Поток завершается `data: [DONE]`. Ошибки до начала потока возвращаются JSON с полем `error`, после начала — SSE с полем `error`.

## Диалоги

`GET /api/chats` возвращает сохранённые чаты. `POST /api/chat/reset` сбрасывает диалог по conversationId. `POST /api/chats/clear` очищает чаты. `POST /api/chat/branch` создаёт ветку контекста диалога; это не Git-ветка.

## Схема хранения

SQLite-таблица `conversations` содержит `id`, `settings_json`, `token_stats_json`, `context_json`, `updated_at`. Таблица `agent_messages` хранит `conversation_id`, `position`, `payload_json`. Таблица `messages` содержит текстовые сообщения с ролью и признаками команды памяти. Таблица `memories` содержит область `working` или `longTerm`, идентификатор диалога, ключ, содержимое и временные отметки. Детальная схема создаётся в `sqlite-store.js`.
