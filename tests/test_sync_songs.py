#!/usr/bin/env python3
"""Tests for scripts/sync_songs.py — the parts that failed in production.

    python3 -m unittest discover -s tests -p 'test_*.py' -v

Everything here is offline: `http_get` is replaced with a stub, so the
church servers are never touched and the suite runs in well under a
second. `CDC_MIN_INTERVAL` is forced to 0 except in the one test that
is specifically about pacing, or the throttle would make the suite
sleep for minutes.

Why these tests exist, in one line each:

  * 2026-08-30 → 2026-09-05: "Refresh songs" failed six days running
    because ONE 15-song collection came back without its mp3 links and
    that raised out of main()'s combined six-source fetch expression,
    so nothing at all was published — including two brand-new sources
    that had never been published even once.
  * The same six days, "Refresh songs" reported SUCCESS every day,
    because the email-deduplication step rewrote the exit code.
  * The hymn extractor demanded an absolute URL on a site whose other
    extractor, reading the same pages, had always accepted the
    root-relative form too.
"""

import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault('CDC_MIN_INTERVAL', '0')
os.environ.setdefault('CDC_STRIPPED_BACKOFF', '0')

_spec = importlib.util.spec_from_file_location(
    'sync_songs', os.path.join(REPO_ROOT, 'scripts', 'sync_songs.py'))
ss = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ss)


MP3 = ('https://www.christiandiscipleschurch.org/sites/default/files/'
       'hymns/mp3/Amazing_Grace.mp3')
PDF = ('https://www.christiandiscipleschurch.org/sites/default/files/'
       'hymns/pdf/Amazing_Grace.pdf')

# The three forms a hymn page actually prints its mp3 in, verified
# against a live fetch of /content/h01 on 2026-09-05: absolute inside
# the jPlayer playlist anchor, JSON-escaped inside the Drupal.settings
# blob, root-relative in the download-link field.
PAGE_ABSOLUTE = f'<a href="{MP3}" id="x">Amazing_Grace.mp3</a>'
PAGE_ESCAPED = ('{"jplayerInstances":{"j1":{"files":[{"mp3":'
                '"https:\\/\\/www.christiandiscipleschurch.org\\/sites\\/'
                'default\\/files\\/hymns\\/mp3\\/Amazing_Grace.mp3"}]}}}')
PAGE_RELATIVE = ('<a class="linkstyle" '
                 'href="/sites/default/files/hymns/mp3/Amazing_Grace.mp3" '
                 'download>Download</a>')

# What the GitHub runner was actually served: a full-length, perfectly
# valid page with every media link absent.
PAGE_STRIPPED = '<html><body>' + ('filler ' * 2000) + '</body></html>'


def quiet(fn, *args, **kwargs):
    """Run fn, swallowing its stdout/stderr; returns (result, stderr)."""
    err = io.StringIO()
    with redirect_stdout(io.StringIO()), redirect_stderr(err):
        result = fn(*args, **kwargs)
    return result, err.getvalue()


class HymnUrlForms(unittest.TestCase):
    """A hymn page's mp3 is readable in every form the page prints it."""

    def test_absolute(self):
        self.assertEqual(
            ss.cdc_hymn_media(PAGE_ABSOLUTE, ss.CDC_HYMN_MP3_RE), MP3)

    def test_root_relative(self):
        # This is the one the old `https?://…`-anchored regex missed.
        self.assertEqual(
            ss.cdc_hymn_media(PAGE_RELATIVE, ss.CDC_HYMN_MP3_RE), MP3)

    def test_json_escaped(self):
        self.assertEqual(
            ss.cdc_hymn_media(PAGE_ESCAPED, ss.CDC_HYMN_MP3_RE), MP3)

    def test_pdf_relative(self):
        page = '<a href="/sites/default/files/hymns/pdf/Amazing_Grace.pdf">s</a>'
        self.assertEqual(
            ss.cdc_hymn_media(page, ss.CDC_HYMN_PDF_RE), PDF)

    def test_no_media_at_all(self):
        self.assertIsNone(
            ss.cdc_hymn_media(PAGE_STRIPPED, ss.CDC_HYMN_MP3_RE))

    def test_does_not_match_a_different_collection(self):
        # /files/music/ is the 283-song D/E catalogue, not the hymns.
        page = '<a href="/sites/default/files/music/mp3/D0180.mp3">x</a>'
        self.assertIsNone(ss.cdc_hymn_media(page, ss.CDC_HYMN_MP3_RE))


class CdcPacing(unittest.TestCase):
    """Request STARTS are spaced, across threads, by CDC_MIN_INTERVAL."""

    def test_requests_are_paced(self):
        starts = []

        def fake_get(url, timeout=30):
            starts.append(time.monotonic())
            return 'ok'

        with mock.patch.object(ss, 'http_get', fake_get), \
                mock.patch.object(ss, 'CDC_MIN_INTERVAL', 0.05):
            ss._cdc_last_start[0] = 0.0
            for _ in range(4):
                ss.cdc_get('https://example.invalid/x')

        gaps = [b - a for a, b in zip(starts, starts[1:])]
        self.assertEqual(len(gaps), 3)
        for gap in gaps:
            self.assertGreaterEqual(gap, 0.045, f'gaps were {gaps}')

    def test_zero_interval_disables_the_gate(self):
        with mock.patch.object(ss, 'http_get', lambda u, timeout=30: 'ok'), \
                mock.patch.object(ss, 'CDC_MIN_INTERVAL', 0):
            t0 = time.monotonic()
            for _ in range(20):
                ss.cdc_get('https://example.invalid/x')
            self.assertLess(time.monotonic() - t0, 0.5)


class HymnCarryForward(unittest.TestCase):
    """A hymn day that goes wrong must not take the other five sources
    down with it — and must not pass silently either."""

    def setUp(self):
        ss.SOURCE_HEALTH.clear()
        self.addCleanup(ss.SOURCE_HEALTH.clear)

    def stored(self):
        return {
            f'cdc:h{n:02d}': ss.make_entry(
                'cdc', f'h{n:02d}', f'Hymn {n}',
                f'https://www.christiandiscipleschurch.org/content/h{n:02d}',
                code=f'H{n:02d}', language='en', audioUrl=MP3,
                audioTracks=ss.build_tracks([(MP3, 'vocal', 'en')]))
            for n in range(1, 16)
        }

    @staticmethod
    def no_bypass(*a, **k):
        raise AssertionError(
            'CDC traffic must go through cdc_get(), not http_get()')

    def test_stripped_pages_carry_the_stored_rows_forward(self):
        with mock.patch.object(ss, 'http_get', self.no_bypass), \
                mock.patch.object(ss, 'cdc_get',
                                  lambda url, timeout=30: PAGE_STRIPPED):
            rows, err = quiet(ss.fetch_cdc_hymns, self.stored())
        self.assertEqual(len(rows), 15)
        self.assertTrue(all(r['audioUrl'] == MP3 for r in rows))
        self.assertIn('cdc', ss.SOURCE_HEALTH)
        self.assertIn('DEGRADED cdc', err)

    def test_nothing_stored_and_nothing_fetched_still_refuses(self):
        with mock.patch.object(ss, 'cdc_get',
                               lambda url, timeout=30: PAGE_STRIPPED):
            with self.assertRaises(RuntimeError):
                quiet(ss.fetch_cdc_hymns, {})

    def test_a_good_day_registers_no_degradation(self):
        page = PAGE_ABSOLUTE + PAGE_RELATIVE

        with mock.patch.object(ss, 'cdc_get', lambda url, timeout=30: page):
            rows, _ = quiet(ss.fetch_cdc_hymns, {})
        self.assertEqual(len(rows), 15)
        self.assertEqual(ss.SOURCE_HEALTH, {})

    def test_a_partial_day_carries_only_the_missing_ones(self):
        def page_for(url, timeout=30):
            return PAGE_ABSOLUTE if url.endswith(('h01', 'h02')) \
                else PAGE_STRIPPED

        with mock.patch.object(ss, 'cdc_get', page_for):
            rows, err = quiet(ss.fetch_cdc_hymns, self.stored())
        self.assertEqual(len(rows), 15)
        self.assertIn('13 of 15', err)
        self.assertIn('cdc', ss.SOURCE_HEALTH)


SONG_MP3 = ('https://www.christiandiscipleschurch.org/sites/default/'
            'files/music/mp3/D0001.mp3')


def cdc_index_html(codes):
    """The two <td>s CDC_ROW_RE anchors on, one row per code."""
    return ''.join(
        f'<td class="views-field-field-song-title">Song {c}</td>'
        f'<td class="views-field-title"><a href="/content/{c.lower()}">x</a>'
        f'</td>' for c in codes)


class CdcStrippedSongPages(unittest.TestCase):
    """The failure that cost the catalogue its tail: full 200s with the
    media links gone. It must be retried, and if it persists, named."""

    def setUp(self):
        ss.SOURCE_HEALTH.clear()
        self.addCleanup(ss.SOURCE_HEALTH.clear)

    def fetch(self, song_pages):
        """song_pages: dict code -> list of successive page bodies."""
        served = {}

        def fake(url, timeout=30):
            if 'integrated-list-songs' in url:
                return cdc_index_html(['D0001']) if url.endswith('page=0') \
                    else ''
            code = url.rsplit('/', 1)[-1].upper()
            seq = song_pages[code]
            i = min(served.get(code, 0), len(seq) - 1)
            served[code] = served.get(code, 0) + 1
            return seq[i]

        # Every CDC request must go through the paced `cdc_get`. If a
        # fetcher is ever changed back to calling `http_get` directly it
        # bypasses the rate gate that keeps the server answering, and
        # this sentinel is what says so — loudly, and without touching
        # the network to find out.
        def no_bypass(*a, **k):
            raise AssertionError(
                'CDC traffic must go through cdc_get(), not http_get()')

        with mock.patch.object(ss, 'cdc_get', fake), \
                mock.patch.object(ss, 'http_get', no_bypass), \
                mock.patch.object(ss, 'CDC_STRIPPED_BACKOFF', 0):
            return quiet(ss.fetch_cdc)

    def test_a_stripped_page_that_recovers_on_retry_is_not_degradation(self):
        good = f'<a href="{SONG_MP3}">D0001.mp3</a>'
        (rows, err) = self.fetch({'D0001': [PAGE_STRIPPED, good]})
        self.assertEqual(rows[0]['audioUrl'], SONG_MP3)
        self.assertEqual(ss.SOURCE_HEALTH, {})
        self.assertIn('retry', err)

    def test_a_page_stripped_twice_is_recorded_as_degradation(self):
        (rows, err) = self.fetch({'D0001': [PAGE_STRIPPED, PAGE_STRIPPED]})
        self.assertIsNone(rows[0]['audioUrl'])
        self.assertIn('cdc', ss.SOURCE_HEALTH)
        self.assertIn('DEGRADED cdc', err)
        self.assertIn('D0001', err)

    def test_a_healthy_page_is_never_retried_or_flagged(self):
        good = f'<a href="{SONG_MP3}">D0001.mp3</a>'
        (rows, err) = self.fetch({'D0001': [good, PAGE_STRIPPED]})
        self.assertEqual(rows[0]['audioUrl'], SONG_MP3)
        self.assertEqual(ss.SOURCE_HEALTH, {})
        self.assertNotIn('retry', err)


class DegradedRunStillPublishes(unittest.TestCase):
    """The whole point of the 2026-09-05 change: one bad upstream must
    not withhold the other five, and the run must still be red."""

    def setUp(self):
        ss.SOURCE_HEALTH.clear()
        self.addCleanup(ss.SOURCE_HEALTH.clear)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = os.path.join(self.tmp.name, 'songs.json')

    @staticmethod
    def row(source, slug, audio=MP3, video=None):
        return ss.make_entry(
            source, slug, f'{source} {slug}',
            f'https://example.invalid/{slug}', code=slug.upper(),
            language='en', audioUrl=audio,
            audioTracks=ss.build_tracks([(audio, 'vocal', 'en')])
            if audio else [], videoUrl=video)

    def write_stored(self, rows):
        with open(self.out, 'w', encoding='utf-8') as f:
            json.dump({'_meta': {}, 'songs': [ss.normalise(r) for r in rows]},
                      f)

    def run_main(self, fetchers, argv):
        patches = {name: (lambda *a, _rows=rows, **k: list(_rows))
                   for name, rows in fetchers.items()}
        with mock.patch.object(ss, 'fetch_fydt_taxonomy', lambda: {}), \
                mock.patch.object(ss, 'fetch_fydt_wp_index', lambda: {}), \
                mock.patch.object(sys, 'argv', ['sync_songs.py', *argv]):
            with mock.patch.multiple(ss, **patches):
                return quiet(ss.main)

    def test_a_degraded_source_publishes_and_exits_2(self):
        # 30 fydt rows so the "source collapsed" guard has a baseline,
        # plus one cdc row that loses its audio this run.
        stored = [self.row('fydt', f'f{n}') for n in range(30)]
        stored.append(self.row('cdc', 'd0001'))
        self.write_stored(stored)

        fresh_cdc = [self.row('cdc', 'd0001', audio=None)]
        rc, err = self.run_main(
            {'fetch_fydt': [self.row('fydt', f'f{n}') for n in range(30)],
             'fetch_cahaya': [], 'fetch_cdc': fresh_cdc,
             'fetch_cdc_hymns': [], 'fetch_cgdc': [],
             'fetch_setapak': [self.row('setapak', 's1')],
             'fetch_ydh': [self.row('ydh', 'y1')]},
            ['--out', self.out])

        self.assertEqual(rc, 2, err)
        with open(self.out, encoding='utf-8') as f:
            doc = json.load(f)
        ids = {s['id'] for s in doc['songs']}
        # The brand-new sources reached the file...
        self.assertIn('setapak:s1', ids)
        self.assertIn('ydh:y1', ids)
        # ...the degraded row kept the audio it had...
        cdc = next(s for s in doc['songs'] if s['id'] == 'cdc:d0001')
        self.assertEqual(cdc['audioUrl'], MP3)
        # ...and the file says so out loud.
        self.assertEqual(
            doc['_meta']['sourceHealth']['cdc']['status'], 'degraded')

    def test_no_carry_forward_restores_the_refusal(self):
        stored = [self.row('fydt', f'f{n}') for n in range(30)]
        stored.append(self.row('cdc', 'd0001'))
        self.write_stored(stored)
        with open(self.out, encoding='utf-8') as f:
            before = f.read()

        rc, err = self.run_main(
            {'fetch_fydt': [self.row('fydt', f'f{n}') for n in range(30)],
             'fetch_cahaya': [], 'fetch_cdc': [self.row('cdc', 'd0001',
                                                        audio=None)],
             'fetch_cdc_hymns': [], 'fetch_cgdc': [],
             'fetch_setapak': [], 'fetch_ydh': []},
            ['--out', self.out, '--no-carry-forward'])

        self.assertEqual(rc, 1, err)
        with open(self.out, encoding='utf-8') as f:
            self.assertEqual(f.read(), before)

    def test_audio_only_thinning_is_caught_even_when_media_survives(self):
        """`has_media()` counts video too, so a source that loses ALL its
        audio while every row keeps a video link looks like zero
        regression to the per-row lost-media/dropped guard: nothing
        vanished, nothing lost its only media. Audio-thinning is the
        only guard watching audio specifically, and this is the case it
        exists for."""
        video = 'https://example.invalid/watch'
        stored = [self.row('fydt', f'f{n}') for n in range(30)]
        stored += [self.row('cdc', f'd{n:02d}', video=video)
                   for n in range(25)]
        self.write_stored(stored)

        fresh_cdc = [self.row('cdc', f'd{n:02d}', audio=None, video=video)
                     for n in range(25)]
        rc, err = self.run_main(
            {'fetch_fydt': [self.row('fydt', f'f{n}') for n in range(30)],
             'fetch_cahaya': [], 'fetch_cdc': fresh_cdc,
             'fetch_cdc_hymns': [], 'fetch_cgdc': [],
             'fetch_setapak': [], 'fetch_ydh': []},
            ['--out', self.out, '--no-carry-forward'])

        self.assertEqual(rc, 1, err)
        self.assertIn('AUDIO', err)

    def test_a_clean_run_exits_0_and_writes_no_health_block(self):
        stored = [self.row('fydt', f'f{n}') for n in range(30)]
        self.write_stored(stored)

        rc, err = self.run_main(
            {'fetch_fydt': [self.row('fydt', f'f{n}') for n in range(30)],
             'fetch_cahaya': [], 'fetch_cdc': [], 'fetch_cdc_hymns': [],
             'fetch_cgdc': [], 'fetch_setapak': [], 'fetch_ydh': []},
            ['--out', self.out])

        self.assertEqual(rc, 0, err)
        with open(self.out, encoding='utf-8') as f:
            doc = json.load(f)
        self.assertNotIn('sourceHealth', doc['_meta'])

    def test_a_source_collapsing_is_still_a_hard_refusal(self):
        # Carry-forward is for rows that lost their media, not for a
        # source that stopped answering: 30 → 2 is not a bad day, it is
        # a broken fetcher, and nothing should be written.
        stored = [self.row('fydt', f'f{n}') for n in range(30)]
        self.write_stored(stored)
        with open(self.out, encoding='utf-8') as f:
            before = f.read()

        rc, err = self.run_main(
            {'fetch_fydt': [self.row('fydt', 'f0'), self.row('fydt', 'f1')],
             'fetch_cahaya': [], 'fetch_cdc': [], 'fetch_cdc_hymns': [],
             'fetch_cgdc': [], 'fetch_setapak': [], 'fetch_ydh': []},
            ['--out', self.out])

        self.assertEqual(rc, 1, err)
        self.assertIn('collapsed', err)
        with open(self.out, encoding='utf-8') as f:
            self.assertEqual(f.read(), before)


if __name__ == '__main__':
    unittest.main()
