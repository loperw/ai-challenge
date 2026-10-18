# История развития проекта

## В какой ветке впервые появился RAG

RAG впервые добавлен в ветке `codex/ai-challenge-21`, коммит `3b1e0982edebf425aed77cf82bf3282ae089df48` от 4 октября 2026 года. Название коммита: `feat: add local PDF indexing and book-grounded agent chat`.

Это уже полноценный RAG: индексация PDF, эмбеддинги `nomic-embed-text`, поиск фрагментов в SQLite и передача найденного контекста языковой модели для генерации ответа. В этой версии `server.js` вызывает `searchBook` и передаёт `documentSearch` в `agent.respond`; `agent.js` добавляет `documentPrompt(this.documentSearch)` к запросу модели. Поэтому первое появление RAG относится к ветке 21, а не к 22, 23 или 31.

## Последующие изменения RAG по веткам

- `codex/ai-challenge-21`: первый RAG по PDF-книге, включая генерацию ответа на основе найденных фрагментов; коммит `3b1e098`.
- `codex/ai-challenge-22`: явные режимы «С RAG / Без RAG» и отображение выбранных источников; коммит `9770f33`. Это развитие уже существующего RAG.
- `codex/ai-challenge-23`: фильтрация по сходству, переформулировка запроса (query rewrite) и сравнение режимов поиска; коммит `c358465`.
- `codex/ai-challenge-24`: источники, цитаты и отказ при слабом контексте; коммит `325bdbd`.
- `codex/ai-challenge-31`: RAG по документации самого проекта (README и docs) для команды `/help` плюс текущий контекст Git через MCP. Это новый источник знаний для RAG, а не первое появление RAG в приложении.

## Как проверена история

Сведения сверены с локальными коммитами и исходниками: `git log codex/ai-challenge-20..codex/ai-challenge-21`, `git show codex/ai-challenge-21:document-search.js`, `git show codex/ai-challenge-21:server.js`, `git show codex/ai-challenge-21:agent.js`. MCP `git_context` возвращает текущую ветку и commit; он не анализирует историю появления функций. На вопросы о прошлых ветках `/help` отвечает по этой документации.
