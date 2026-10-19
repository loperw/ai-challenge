# Демонстрационный проект

Профиль и dashboard используют API через `src/api-client.js`.

`fetchUser(userId, { signal })` принимает обязательный `userId` и необязательный `{ signal }` для отмены запроса и обращается к `GET /api/v2/users/:id`.

- `src/profile.js` — `loadProfile(userId)` вызывает `fetchUser(userId)` без отмены.
- `src/dashboard.js` — `loadDashboard(userId, signal)` вызывает `fetchUser(userId, { signal })`.

Подробное описание контракта — в `docs/api.md`.
