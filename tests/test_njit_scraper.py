"""Synthetic Banner contract fixtures; no live upstream requests."""
import copy
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

import requests

from src.njit_scraper import BannerValidationError, get_sections, parse_all_sections

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / 'tests/fixtures/banner-snapshots.json').read_text())


class ParserTests(unittest.TestCase):
    def test_valid_snapshot_preserves_crn_and_over_enrollment(self):
        sections = parse_all_sections(FIXTURES['valid'])
        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0]['crn'], '01234')
        self.assertEqual(sections[0]['max_enrollment'], 30)
        self.assertEqual(sections[0]['current_enrollment'], 31)
        self.assertEqual(sections[0]['seats_remaining'], -1)
        self.assertEqual(sections[0]['section'], 'H01')

    def test_explicit_empty_list(self):
        self.assertEqual(parse_all_sections(FIXTURES['empty']), [])

    def test_structurally_valid_omissions_are_observations_not_completeness_proof(self):
        for name in ('preservation_full', 'preservation_full_items'):
            self.assertEqual({row['crn'] for row in parse_all_sections(FIXTURES[name])},
                             {'01234', '01235', '02234'})
        for name, expected in (
            ('preservation_missing_row', {'01234', '02234'}),
            ('preservation_missing_course', {'01234', '01235'}),
            ('preservation_missing_item', {'01234', '01235'}),
        ):
            with self.subTest(fixture=name):
                rows = parse_all_sections(FIXTURES[name])
                self.assertEqual({row['crn'] for row in rows}, expected)
                observed = next(row for row in rows if row['crn'] == '01234')
                self.assertEqual((observed['status'], observed['current_enrollment']), ('CLOSED', 30))

    def test_malformed_data_never_becomes_empty_or_partial_success(self):
        for name in ('missing_table', 'partial', 'truncated', 'unexpected_empty_markup',
                     'invalid_status', 'invalid_crn', 'invalid_enrollment',
                     'unexpected_course', 'invalid_envelope', 'unmatched_table'):
            with self.subTest(name=name), self.assertRaises(BannerValidationError) as caught:
                parse_all_sections(FIXTURES[name])
            self.assertEqual(set(caught.exception.validation), {'field', 'row_index', 'reason'})
            self.assertNotIn('PRIVATE-UNSUPPORTED-VALUE', str(caught.exception))
        for data in (None, {}, '', [None], [{}], [{'SECTIONS_TABLE': None}], [{'SECTIONS_TABLE': ''}]):
            with self.subTest(data=data), self.assertRaises(BannerValidationError):
                parse_all_sections(data)

    def test_orphaned_markup_is_not_silently_discarded(self):
        for markup in ('<h4>Missing course ID</h4>', '<table><tr><td>Unexpected table</td></tr></table>',
                       '<tr><td>Orphan row</td></tr>', '<td>Orphan cell</td>'):
            with self.subTest(markup=markup), self.assertRaises(BannerValidationError):
                parse_all_sections([{'SECTIONS_TABLE': FIXTURES['valid'][0]['SECTIONS_TABLE'] + markup}])

    def test_bad_later_item_rejects_entire_response(self):
        with self.assertRaises(BannerValidationError):
            parse_all_sections(FIXTURES['valid'] + FIXTURES['missing_table'])

    def test_unsupported_columns_and_values(self):
        for before, after in (('<td>H01</td>', '<td colspan="2">H01</td>'),
                              ('<td>30</td>', '<td>4294967296</td>'),
                              ('<td>31</td>', '<td>1.5</td>'),
                              ('<td>H01</td>', '<td></td>'),
                              ('<td>H01</td>', '<td>' + 'x' * 21 + '</td>'),
                              ('<tr>', '<tr><td>extra</td>')):
            with self.subTest(after=after), self.assertRaises(BannerValidationError):
                parse_all_sections([{'SECTIONS_TABLE': FIXTURES['valid'][0]['SECTIONS_TABLE'].replace(before, after)}])

    def test_header_rows_and_whitespace_are_supported(self):
        data = copy.deepcopy(FIXTURES['valid'])
        html = data[0]['SECTIONS_TABLE'].replace('id="DS 644"', 'id=" DS\u00a0 644 "')
        html = html.replace('<tr>', '<tr>' + '<th>Column</th>' * 13 + '</tr><tr>', 1)
        data[0]['SECTIONS_TABLE'] = html
        self.assertEqual(parse_all_sections(data)[0]['course'], 'DS 644')

    @patch('src.njit_scraper.requests.get')
    def test_fetch_disallows_redirects_and_rejects_non_json_or_non_200(self, fetch):
        response = Mock(status_code=200)
        response.json.return_value = FIXTURES['valid']
        fetch.return_value = response
        self.assertEqual(get_sections('DS', '202710'), FIXTURES['valid'])
        self.assertEqual(fetch.call_args.kwargs, {'timeout': (5, 30), 'allow_redirects': False})
        for status in (204, 302):
            response.status_code = status
            with self.assertRaises(ValueError):
                get_sections('DS', '202710')
        response.status_code = 200
        response.json.side_effect = ValueError('PRIVATE-UPSTREAM-BODY')
        with self.assertRaises(ValueError) as caught:
            get_sections('DS', '202710')
        self.assertNotIn('PRIVATE', str(caught.exception))
        fetch.side_effect = requests.Timeout('PRIVATE-URL')
        with self.assertRaises(requests.RequestException) as caught:
            get_sections('DS', '202710')
        self.assertNotIn('PRIVATE', str(caught.exception))

    def test_allowlist_matches_reviewed_offline_evidence(self):
        evidence = json.loads((ROOT / 'docs/department-verification.json').read_text())
        codes = json.loads((ROOT / 'src/departments.json').read_text())
        sources = evidence['catalog_sources'] + evidence['supplemental_sources']
        self.assertEqual(codes, sorted({code for source in sources for code in source['codes']}))
        self.assertFalse(set(codes) & set(evidence['excluded_rutgers']['codes']))
        self.assertFalse(set(codes) & set(evidence['unresolved_candidate_codes']))
        self.assertIn('DS', codes)
        self.assertIn('ET', codes)
        self.assertIn('MNE', codes)


if __name__ == '__main__':
    unittest.main()
