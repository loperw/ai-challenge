import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from pipeline import chunks, clean, load_index, save_index, search


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.document = {'text': 'one two three four five six seven eight nine ten',
                         'sha256': 'abc', 'source': 'test.pdf', 'file': 'test.pdf', 'title': 'Test',
                         'pages': [{'start': 0}, {'start': 24}],
                         'sections': [{'start': 0, 'title': 'A'}, {'start': 24, 'title': 'B'}]}

    def test_coverage_and_structure_boundaries(self):
        fixed = chunks(self.document, 'fixed', 4, 1)
        structured = chunks(self.document, 'structure', 4, 1)
        self.assertTrue(any(len(c['sections']) > 1 for c in fixed))
        self.assertTrue(all(len(c['sections']) == 1 for c in structured))
        for items in (fixed, structured):
            covered = set()
            for item in items:
                covered.update(range(item['start_char'], item['end_char']))
                self.assertLessEqual(item['char_count'], 4)
                self.assertGreaterEqual(item['page_start'], 1)
            self.assertTrue(all(i in covered for i, c in enumerate(self.document['text']) if not c.isspace()))
        self.assertEqual(fixed, chunks(self.document, 'fixed', 4, 1))

    def test_invalid_overlap(self):
        with self.assertRaises(ValueError):
            chunks(self.document, 'fixed', 4, 4)

    def test_reopen_and_search_and_model_mismatch(self):
        class Embedder:
            model, digest = 'test', 'digest'
            def embed(self, texts, query=False):
                return np.asarray([[0, 1]], dtype='<f4')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'index.sqlite'
            items = chunks(self.document, 'fixed', 30, 0)
            save_index(path, items, np.asarray([[1, 0], [0, 1]], dtype='<f4'),
                       {'model': 'test', 'model_digest': 'digest'})
            metadata, restored, vectors = load_index(path)
            self.assertEqual(items, restored)
            self.assertEqual(metadata['dimensions'], 2)
            self.assertEqual(search(path, 'question', Embedder(), 1)[0]['chunk_id'], items[1]['chunk_id'])
            previous = path.read_bytes()
            with self.assertRaises(ValueError):
                save_index(path, items, np.zeros((1, 2)), {})
            self.assertEqual(previous, path.read_bytes())
            embedder = Embedder()
            embedder.digest = 'new-model'
            with self.assertRaises(ValueError):
                search(path, 'question', embedder)

    def test_soft_hyphen_and_whitespace(self):
        self.assertEqual(clean('ин\n\u00ad\nдекс  текста'), 'индекс текста')


if __name__ == '__main__':
    unittest.main()
