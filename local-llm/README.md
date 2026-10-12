# Локальная LLM — ветка 26

Ollama + `qwen3:1.7b` в Q4_K_M. Используется локальная установка из ветки 21,
модель скачивается отдельно. Сервер слушает только `127.0.0.1:11434`.
Запросы ниже выполняются на ноутбуке. Для скачивания нужен интернет;
после скачивания локальная генерация не требует облачного API или ключа.

Фактические ответы, скорость и найденная ошибка модели: [отчёт](RESULTS.md).

## Запуск из корня проекта (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/start-index-ollama.ps1
& ./data/tools/ollama/ollama.exe pull qwen3:1.7b
& ./data/tools/ollama/ollama.exe run qwen3:1.7b
```

`pull` нужен только при первом скачивании или намеренном обновлении модели.
В интерактивном чате можно ввести `/set nothink`, затем обычный вопрос.
Выход из чата: `/bye`. Он не останавливает сервер.

Бинарные файлы лежат в `data/tools/ollama/`, модели — в `data/ollama-models/`;
они исключены из Git. В новом клоне установите Ollama с
https://ollama.com/download/windows, затем используйте `ollama` вместо локального пути.
Скрипт запуска также поддерживает установленную Ollama из PATH.

## HTTP API

```powershell
$body = @{
    model = 'qwen3:1.7b'
    prompt = 'Столица Франции? Ответь одним словом.'
    stream = $false
    think = $false
    options = @{ num_ctx = 4096; temperature = 0; num_predict = 256 }
} | ConvertTo-Json -Depth 4

$result = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/generate' `
    -Method Post -ContentType 'application/json; charset=utf-8' `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$result.response
```

## Проверка и остановка

Проверить загруженную модель:

```powershell
& ./data/tools/ollama/ollama.exe ps
```

Чтобы освободить память модели:

```powershell
& ./data/tools/ollama/ollama.exe stop qwen3:1.7b
```

Эта инструкция не подключает Qwen к веб-интерфейсу основного приложения: взаимодействие
с моделью в этой ветке выполняется через CLI и HTTP API.
