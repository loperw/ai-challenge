"""Local PDF indexing. PDF content is data, never executable instructions."""
import argparse
import bisect
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time
import urllib.error
import urllib.request

import numpy as np
from pypdf import PdfReader
from heading_search import heading_candidates


def clean(text):
    text = re.sub(r"(\w)\s*\u00ad\s*(\w)", r"\1\2", text)
    return re.sub(r"\s+", " ", text.replace("\u00ad", "")).strip()


def extract(pdf):
    started = time.perf_counter()
    path = Path(pdf).resolve()
    reader = PdfReader(path)
    pages, starts, parts = [], [], []
    offset = 0
    for number, page in enumerate(reader.pages, 1):
        text = clean(page.extract_text() or "")
        starts.append(offset)
        pages.append({"page": number, "start": offset, "chars": len(text)})
        parts.append(text)
        offset += len(text) + 1
    text = "\n".join(parts)
    if not text.strip():
        raise ValueError("PDF не содержит извлекаемого текста. Сначала выполните OCR.")
    sections = []

    def walk(items, parents=()):
        previous = parents
        for item in items:
            if isinstance(item, list):
                walk(item, previous)
                continue
            title = clean(str(item.get('/Title', '')))
            previous = parents + (title,)
            number = reader.get_destination_page_number(item)
            if number is None or number < 0 or number >= len(parts):
                continue
            # Prefer the actual heading position; page start is an explicit fallback.
            match = re.search(re.escape(title), parts[number], re.IGNORECASE) if title else None
            sections.append({"start": starts[number] + (match.start() if match else 0),
                             "title": " / ".join(previous), "page": number + 1,
                             "boundary": "heading" if match else "bookmark-page"})

    walk(reader.outline)
    if not sections:
        # PDFs without bookmarks: detect conservative numbered/chapter headings
        # in the original line layout, then locate them in normalized text.
        for number, page in enumerate(reader.pages):
            for line in (page.extract_text(extraction_mode='layout') or '').splitlines():
                title = clean(line)
                if len(title) < 150 and re.match(r'^(?:Глава\s+\d+|Chapter\s+\d+|\d+(?:\.\d+)+\s+\S)', title, re.I):
                    at = parts[number].find(title)
                    if at >= 0:
                        sections.append({"start": starts[number] + at, "title": title,
                                         "page": number + 1, "boundary": "heading"})
    # Same-page bookmarks may resolve to one location. Keep the first, never invent offsets.
    unique = {}
    for section in sorted(sections, key=lambda s: s['start']):
        unique.setdefault(section['start'], section)
    sections = list(unique.values())
    if not sections or sections[0]['start'] > 0:
        sections.insert(0, {"start": 0, "title": "Начало документа", "page": 1,
                            "boundary": "document"})
    return {"source": str(path), "file": path.name,
            "title": clean(str((reader.metadata or {}).get('/Title') or path.stem)),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "text": text, "pages": pages, "sections": sections,
            "empty_pages": [p['page'] for p in pages if p['chars'] == 0],
            "extraction_seconds": time.perf_counter() - started}


def chunks(document, strategy, size=1000, overlap=150):
    if strategy not in ('fixed', 'structure'):
        raise ValueError('Unknown strategy')
    if size <= 0 or not 0 <= overlap < size:
        raise ValueError('size > 0 and 0 <= overlap < size required')
    text = document['text']
    if not text.strip():
        return []
    sections = document['sections']
    section_starts = [s['start'] for s in sections]
    page_starts = [p['start'] for p in document['pages']]
    ranges = [(0, len(text))]
    if strategy == 'structure':
        boundaries = sorted(set([0, len(text)] + section_starts))
        ranges = list(zip(boundaries, boundaries[1:]))
    result = []
    for first, last in ranges:
        position = first
        while position < last:
            end = min(position + size, last)
            start_char, end_char = position, end
            fragment = text[start_char:end_char]
            if not fragment.strip():
                break
            current = max(0, bisect.bisect_right(section_starts, start_char) - 1)
            touched = [sections[current]['title']] + [s['title'] for s in sections if start_char < s['start'] < end_char]
            identity = f"{document['sha256']}:{strategy}:{size}:{overlap}:{start_char}:{end_char}"
            result.append({"chunk_id": hashlib.sha256(identity.encode()).hexdigest()[:24],
                           "source": document['source'], "title": document['title'],
                           "file": document['file'], "section": sections[current]['title'],
                           "sections": touched, "strategy": strategy,
                           "page_start": bisect.bisect_right(page_starts, start_char),
                           "page_end": bisect.bisect_right(page_starts, end_char - 1),
                           "start_char": start_char, "end_char": end_char,
                           "char_count": len(fragment), "word_count": len(fragment.split()), "text": fragment})
            if end == last:
                break
            position = end - overlap
    return result


class Ollama:
    def __init__(self, url='http://localhost:11434', model='nomic-embed-text'):
        self.url, self.model = url.rstrip('/'), model
        tags = self.request('/api/tags')['models']
        resolved = next((m for m in tags if m['name'] == model or m['name'] == model + ':latest'), None)
        if not resolved:
            raise ValueError(f'Модель отсутствует. Выполните ollama pull {model}')
        self.digest = resolved['digest']
        self.model = resolved['name']

    def request(self, route, body=None):
        request = urllib.request.Request(self.url + route,
                                        data=json.dumps(body).encode() if body is not None else None,
                                        headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode('utf-8', errors='replace')
            raise RuntimeError(f'Ollama {route}: HTTP {error.code}: {detail}') from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise RuntimeError(f'Ollama {route}: {error}. Проверьте ollama serve и модель.') from error

    def embed(self, texts, query=False):
        prefix = 'search_query: ' if query else 'search_document: '
        response = self.request('/api/embed', {'model': self.model,
                                'input': [prefix + text for text in texts],
                                'truncate': False, 'keep_alive': '10m'})
        vectors = np.asarray(response['embeddings'], dtype='<f4')
        if vectors.ndim != 2 or len(vectors) != len(texts) or not np.isfinite(vectors).all():
            raise ValueError('Некорректный ответ embeddings')
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if (norms <= 0).any():
            raise ValueError('Нулевой эмбеддинг')
        return vectors / norms


def save_index(target, items, vectors, metadata):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if len(items) != len(vectors) or not items:
        raise ValueError('Chunks/vectors mismatch or empty index')
    fd, temporary = tempfile.mkstemp(dir=target.parent, suffix='.sqlite.tmp')
    os.close(fd)
    try:
        with closing(sqlite3.connect(temporary)) as db, db:
            db.executescript('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);'
                             'CREATE TABLE chunks(chunk_id TEXT PRIMARY KEY, text TEXT NOT NULL, '
                             'metadata_json TEXT NOT NULL, embedding BLOB NOT NULL);')
            metadata = dict(metadata, dimensions=int(vectors.shape[1]), format_version=1,
                            vector_dtype='float32-little-endian', similarity='cosine')
            db.executemany('INSERT INTO metadata VALUES (?,?)', [(k, json.dumps(v, ensure_ascii=False)) for k, v in metadata.items()])
            db.executemany('INSERT INTO chunks VALUES (?,?,?,?)',
                           [(item['chunk_id'], item['text'],
                             json.dumps({k: v for k, v in item.items() if k != 'text'}, ensure_ascii=False),
                             np.asarray(vector, dtype='<f4').tobytes()) for item, vector in zip(items, vectors)])
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_index(path):
    if not Path(path).is_file():
        raise ValueError(f'Индекс не найден: {path}')
    with closing(sqlite3.connect(f'{Path(path).resolve().as_uri()}?mode=ro', uri=True)) as db:
        metadata = {k: json.loads(v) for k, v in db.execute('SELECT key,value FROM metadata')}
        rows = list(db.execute('SELECT text,metadata_json,embedding FROM chunks ORDER BY rowid'))
    items = [dict(json.loads(row[1]), text=row[0]) for row in rows]
    vectors = np.stack([np.frombuffer(row[2], dtype='<f4') for row in rows])
    if vectors.shape[1] != metadata['dimensions']:
        raise ValueError('Повреждённый индекс: размерность')
    return metadata, items, vectors


def search(path, query, embedder, top=5, headings=True):
    metadata, items, vectors = load_index(path)
    if metadata['model_digest'] != embedder.digest or metadata['model'] != embedder.model:
        raise ValueError('Модель поиска отличается от модели индекса. Перестройте индекс.')
    vector = embedder.embed([query], query=True)[0]
    if vector.shape[0] != vectors.shape[1]:
        raise ValueError('Размерность запроса отличается от индекса')
    scores = vectors @ vector
    lexical = heading_candidates(items, query, min(3, top)) if headings else {}
    ordered = list(lexical) + [int(i) for i in np.argsort(-scores) if int(i) not in lexical]
    return [dict(items[i], score=float(scores[i]), **({'headingMatch': lexical[i], 'headingRank': list(lexical).index(i)} if i in lexical else {})) for i in ordered[:top]]


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def prepare(args):
    destination = Path(args.output)
    destination.mkdir(parents=True, exist_ok=True)
    document = extract(args.pdf)
    write_json(destination / 'extracted.json', document)
    stats = {}
    for strategy in ('fixed', 'structure'):
        started = time.perf_counter()
        items = chunks(document, strategy, args.size, args.overlap)
        write_json(destination / f'{strategy}-chunks.json', items)
        counts = [item['word_count'] for item in items]
        lengths = [item['char_count'] for item in items]
        stats[strategy] = {'chunks': len(items), 'chars_min': min(lengths),
                           'chars_mean': sum(lengths) / len(lengths), 'chars_max': max(lengths), 'words_min': min(counts),
                           'words_mean': sum(counts) / len(counts), 'words_max': max(counts),
                           'cross_section_chunks': sum(len(item['sections']) > 1 for item in items),
                           'chunking_seconds': time.perf_counter() - started}
    write_json(destination / 'preparation.json', {'source': document['source'],
               'sha256': document['sha256'], 'pages': len(document['pages']),
               'sections': len(document['sections']), 'empty_pages': document['empty_pages'],
               'extraction_seconds': document['extraction_seconds'],
               'size_chars': args.size, 'overlap_chars': args.overlap, 'strategies': stats})
    return document, stats


def index(args):
    document, stats = prepare(args)
    destination = Path(args.output)
    embedder = Ollama(args.url, args.model)
    # Warmup excluded from indexing timings and reported separately.
    started = time.perf_counter()
    embedder.embed(['warmup'])
    warmup = time.perf_counter() - started
    for strategy in ('fixed', 'structure'):
        items = json.loads((destination / f'{strategy}-chunks.json').read_text(encoding='utf-8'))
        batches = []
        started = time.perf_counter()
        for offset in range(0, len(items), args.batch):
            batches.append(embedder.embed([item['text'] for item in items[offset:offset + args.batch]]))
            print(f'{strategy}: {min(offset + args.batch, len(items))}/{len(items)}', flush=True)
        embedding_seconds = time.perf_counter() - started
        vectors = np.concatenate(batches)
        started = time.perf_counter()
        target = destination / f'{strategy}.sqlite'
        save_index(target, items, vectors, {'source': document['source'], 'source_sha256': document['sha256'],
                   'model': embedder.model, 'model_digest': embedder.digest, 'strategy': strategy,
                   'size_chars': args.size, 'overlap_chars': args.overlap,
                   'created_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
        storage_seconds = time.perf_counter() - started
        stats[strategy].update(embedding_seconds=embedding_seconds, storage_seconds=storage_seconds,
                              total_seconds=document['extraction_seconds'] + stats[strategy]['chunking_seconds'] + embedding_seconds + storage_seconds,
                              index_bytes=target.stat().st_size, dimensions=int(vectors.shape[1]))
        write_json(destination / 'comparison.json', {'source': document['source'], 'model': embedder.model,
                   'model_digest': embedder.digest, 'warmup_seconds': warmup,
                   'note': 'Downloads and model warmup excluded. Strategies run sequentially; hardware/load may affect timings.',
                   'strategies': stats})
    print(json.dumps(stats, ensure_ascii=False, indent=2))


def compare(args):
    destination = Path(args.output)
    cases = json.loads(Path(args.queries).read_text(encoding='utf-8'))
    if not cases:
        raise ValueError('Нужны контрольные запросы')
    embedder = Ollama(args.url, args.model)
    signatures = []
    for strategy in ('fixed', 'structure'):
        metadata, _, _ = load_index(destination / f'{strategy}.sqlite')
        signatures.append((metadata['source_sha256'], metadata['model_digest'],
                           metadata['size_chars'], metadata['overlap_chars']))
    if signatures[0] != signatures[1]:
        raise ValueError('Для сравнения нужны один PDF, одна модель и одинаковые параметры разбиения')
    report = {}
    for strategy in ('fixed', 'structure'):
        results = []
        for case in cases:
            hits = search(destination / f'{strategy}.sqlite', case['query'], embedder, args.top)
            relevant = [i + 1 for i, hit in enumerate(hits)
                        if any(hit['page_start'] <= page <= hit['page_end'] for page in case['relevant_pages'])]
            results.append({'query': case['query'], 'relevant_pages': case['relevant_pages'],
                            'hit_at_k': bool(relevant), 'reciprocal_rank': 1 / relevant[0] if relevant else 0,
                            'hits': hits})
        report[strategy] = {'hit_at_k': sum(r['hit_at_k'] for r in results) / len(results),
                            'mrr_at_k': sum(r['reciprocal_rank'] for r in results) / len(results),
                            'cases': results}
    write_json(destination / 'retrieval-comparison.json', {'k': args.top, 'strategies': report,
               'note': 'Small manually labelled page-level benchmark, not a general quality guarantee.'})
    timings = json.loads((destination / 'comparison.json').read_text(encoding='utf-8'))
    lines = ['# Сравнение стратегий индексации', '',
             f"Документ: {Path(timings['source']).name}",
             f"Модель: {timings['model']}; digest: `{timings['model_digest']}`.", '',
             '| Показатель | Фиксированный размер | По структуре |',
             '| --- | ---: | ---: |']
    for label, key, formatter in [
        ('Чанки', 'chunks', lambda n: str(n)),
        ('Средний размер, символы', 'chars_mean', lambda n: f'{n:.1f}'),
        ('Пересекают разделы', 'cross_section_chunks', lambda n: str(n)),
        ('Извлечение + chunking + embeddings + запись, секунды', 'total_seconds', lambda n: f'{n:.2f}'),
        ('Генерация embeddings, секунды', 'embedding_seconds', lambda n: f'{n:.2f}'),
        ('SQLite, МиБ', 'index_bytes', lambda n: f'{n / 1024**2:.2f}'),
        ('Размерность', 'dimensions', lambda n: str(n))]:
        values = [formatter(timings['strategies'][s][key]) for s in ('fixed', 'structure')]
        lines.append(f'| {label} | {values[0]} | {values[1]} |')
    for label, key in [(f'Hit@{args.top}', 'hit_at_k'), (f'MRR@{args.top}', 'mrr_at_k')]:
        lines.append(f"| {label} | {report['fixed'][key]:.3f} | {report['structure'][key]:.3f} |")
    lines += ['', f"Параметры: {metadata['size_chars']} символов и перекрытие {metadata['overlap_chars']}.",
              f"Прогрев модели: {timings['warmup_seconds']:.2f} с, исключён из времени индексации.",
              'Размер SQLite исключает исходный PDF, модель, Ollama и JSON-экспорты.', '',
              'Fixed пересекает разделы и сохраняет соседний контекст через перекрытия.',
              'Structure сохраняет границы разделов, но создаёт дополнительные и иногда очень короткие фрагменты.',
              'Число пересечений относится к распознанным границам, а не к ручной разметке всей книги.', '',
              f'Проверка поиска: {len(cases)} одинаковых русских запросов с вручную заданными релевантными страницами PDF.',
              'Hit — найден ли нужный фрагмент в top-k; MRR — обратный ранг первого совпадения.',
              'Разметка по страницам приблизительна. Маленькая выборка не позволяет объявить одну стратегию универсально лучшей.',
              'Стратегии запускались последовательно. Тайминги зависят от текущей нагрузки.', '',
              '## Результаты контрольных запросов', '', '| Запрос | Fixed: первый релевантный ранг | Structure: первый релевантный ранг |',
              '| --- | ---: | ---: |']
    for position, case in enumerate(cases):
        ranks = [report[s]['cases'][position]['reciprocal_rank'] for s in ('fixed', 'structure')]
        values = [str(round(1 / rank)) if rank else 'не найден в top-k' for rank in ranks]
        lines.append(f"| {case['query'].replace('|', '/')} | {values[0]} | {values[1]} |")
    (destination / 'comparison.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({s: {k: v for k, v in r.items() if k != 'cases'} for s, r in report.items()}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('prepare', 'index'):
        command = sub.add_parser(name)
        command.add_argument('pdf')
        command.add_argument('--output', default='data/document-index')
        command.add_argument('--size', type=int, default=1000, help='Unicode characters, not model tokens')
        command.add_argument('--overlap', type=int, default=150)
        if name == 'index':
            command.add_argument('--batch', type=int, default=16)
    command = sub.add_parser('search')
    command.add_argument('database')
    command.add_argument('query')
    command.add_argument('--top', type=int, default=5)
    command.add_argument('--vector-only', action='store_true', help='Disable exact normalized section-title matching')
    command = sub.add_parser('compare')
    command.add_argument('--output', default='data/document-index')
    command.add_argument('--queries', default='indexing/kotlin-queries.json')
    command.add_argument('--top', type=int, default=5)
    for name in ('index', 'search', 'compare'):
        sub.choices[name].add_argument('--url', default='http://localhost:11434')
        sub.choices[name].add_argument('--model', default='nomic-embed-text')
    args = parser.parse_args()
    if getattr(args, 'batch', 1) <= 0 or getattr(args, 'top', 1) <= 0:
        parser.error('batch and top must be positive')
    try:
        if args.command == 'prepare':
            _, stats = prepare(args)
            print(json.dumps(stats, ensure_ascii=False, indent=2))
        elif args.command == 'index':
            index(args)
        elif args.command == 'compare':
            compare(args)
        else:
            print(json.dumps(search(args.database, args.query, Ollama(args.url, args.model), args.top, not args.vector_only), ensure_ascii=False, indent=2))
    except (ValueError, RuntimeError, OSError) as error:
        parser.exit(1, f'{error}\n')


if __name__ == '__main__':
    main()
