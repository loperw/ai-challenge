import unittest
from heading_search import heading_candidates


class HeadingSearchTest(unittest.TestCase):
    def setUp(self):
        self.items = [
            {'section': 'Глава / Классы / Классы данных', 'text': 'Продолжение про equals', 'start_char': 200},
            {'section': 'Глава / Классы / Классы данных', 'text': 'Классы данных — представление структурированных данных.', 'start_char': 100},
            {'section': 'Глава / Свойства', 'text': 'Свойства', 'start_char': 50},
        ]

    def test_inflected_question_selects_definition_first(self):
        self.assertEqual(list(heading_candidates(self.items, 'Что называется классами данных?')), [1, 0])

    def test_english_language_term(self):
        self.assertEqual(list(heading_candidates(self.items, 'Для чего нужны data class в Kotlin?')), [1, 0])

    def test_generic_ambiguous_and_unrelated_questions_do_not_match(self):
        for query in ['Что такое классы?', 'Как обработать данные?', 'Какая масса Юпитера?', 'А для чего они нужны?', 'Классификация данных', 'metadata classes']:
            self.assertEqual(heading_candidates(self.items, query), {}, query)

    def test_fixed_chunk_crossing_section_boundary(self):
        item = {'section': 'Глава / Объекты-компаньоны', 'sections': ['Глава / Объекты-компаньоны', 'Глава / Классы данных'], 'text': 'Конец раздела. Классы данных — это ...'}
        self.assertEqual(heading_candidates([item], 'Классы данных'), {0: 'Классы данных'})

    def test_title_match_is_not_a_body_keyword_match(self):
        self.assertEqual(heading_candidates([{'section': 'Примеры', 'text': 'data class Классы данных'}], 'Классы данных'), {})


if __name__ == '__main__':
    unittest.main()
