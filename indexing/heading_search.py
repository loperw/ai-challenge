"""Conservative title matching alongside vector retrieval; never changes cosine scores."""
import re

STOP = {'и', 'в', 'во', 'на', 'с', 'со', 'по', 'для', 'из', 'к', 'о', 'об', 'от', 'как', 'a', 'the', 'of', 'in', 'and'}
GENERIC = {'класс', 'данн', 'свойств', 'основ', 'тип', 'объект', 'функц', 'пример', 'kotlin', 'android'}
ALIASES = {'data class': 'классы данных', 'enum class': 'классы перечислений', 'sealed class': 'запечатанные классы'}


def tokens(text):
    words = re.findall(r'[a-zа-я0-9]+', text.lower().replace('ё', 'е'))
    result = []
    for word in words:
        if word in STOP:
            continue
        if re.fullmatch('[а-я]+', word):
            word = re.sub(r'(иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ия|ии|ий|ые|ое|ая|ой|ей|ов|ев|ам|ям|ом|ем|ых|их|ы|и|а|я|у|ю|е|о)$', '', word)
        if word:
            result.append(word)
    return result


def heading_candidates(items, query, limit=3):
    expanded = query.lower()
    for alias, title in ALIASES.items():
        if re.search(r'(?<!\w)' + re.escape(alias) + r'(?!\w)', expanded):
            expanded += ' ' + title
    query_words = set(tokens(expanded))
    matches = []
    for index, item in enumerate(items):
        titles = {section.split(' / ')[-1].strip() for section in [item.get('section', ''), *item.get('sections', [])]}
        for title in titles:
            words = tokens(title)
            if not words or not set(words).issubset(query_words):
                continue
            if len(words) == 1 and (words[0] in GENERIC or len(words[0]) < 5):
                continue
            # Introductory chunks contain the title; continuations follow in document order.
            body = tokens(item.get('text', ''))
            opening = any(body[pos:pos + len(words)] == words for pos in range(len(body) - len(words) + 1))
            matches.append((index, title, len(words), opening, item.get('start_char', index)))
    matches.sort(key=lambda value: (-value[2], -value[3], value[4], value[0]))
    selected = {}
    for index, title, _, _, _ in matches:
        if index not in selected:
            selected[index] = title
        if len(selected) >= limit:
            break
    return selected
