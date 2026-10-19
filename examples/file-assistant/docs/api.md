# API

Модуль `src/api-client.js` предоставляет один экспорт — `fetchUser`.

```js
export async function fetchUser(userId, { signal } = {}) {
  const response = await fetch(`/api/v2/users/${encodeURIComponent(userId)}`, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
```

## Сигнатура

`fetchUser(userId, { signal } = {})`

| Параметр | Обязательность | Описание |
| --- | --- | --- |
| `userId` | обязательный | Идентификатор пользователя; кодируется через `encodeURIComponent` и подставляется в путь запроса. |
| `{ signal }` | необязательный, по умолчанию `{}` | `AbortSignal`, передаётся в `fetch` для отмены запроса. Если не передан, запрос не отменяется. |

## Эндпоинт

`GET /api/v2/users/:id`, где `:id` — значение `userId`.

## Возвращаемое значение и ошибки

- Успешный ответ: `response.json()` (промис с телом ответа).
- При не-OK статусе бросает `Error("HTTP <status>")`.

## Примеры использования

```js
// src/dashboard.js — с отменой запроса
import { fetchUser } from './api-client.js';
export const loadDashboard = (userId, signal) => fetchUser(userId, { signal });

// src/profile.js — без отмены
import { fetchUser } from './api-client.js';
export const loadProfile = userId => fetchUser(userId);
```
