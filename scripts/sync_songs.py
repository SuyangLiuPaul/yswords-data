#!/usr/bin/env python3
"""Rebuild `assets/songs.json` from the six church song catalogues.

2026-08-09 (v2 — API rewrite). The original version of this script
scraped fydt.org's WordPress *sitemap* and then re-parsed every song
page's HTML. That broke when fydt.org migrated its backend in 2025
(the APK changelog calls it "福音电台后台迁移改造"), which is why the
whole Songs feature was pulled in v1.3.126 with "the song links were
reported broken".

fydt.org now publishes a real JSON API — `fydt-api/v1` — so this
rewrite reads structured data instead of guessing at markup. It also
picks up two things the old scrape never had: the *media* set
(instrumental / accompaniment tracks, MV video, artwork, sheet music)
and the Indonesian sister site.

Sources
-------
  fydt    https://fydt.org                 — 福音电台, Chinese (213)
          `fydt-api/v1/songs/json/listSongsBySearchKey` enumerated over
          pinyin A–Z gives resolved media URLs; `wp/v2/song` supplies
          the taxonomy + Bible reference the custom API omits. A
          handful of legacy entries carry no pinyin term, so the
          canonical `wp/v2/song` list is diffed in as a backstop.

  cahaya  https://cahayapengharapan.org    — Indonesian
          Two hand-built pages (`/pujian/` audio, `/pujian/video-pujian/`
          video) in a rigid `<p><b>title</b><br><iframe…>` shape. No
          API — WordPress holds these as page bodies, not posts — so
          this stays a parse, but a narrow and well-anchored one.

  cdc     https://www.christiandiscipleschurch.org — English + Chinese
          Drupal 7, no API of any kind. The integrated-list-songs view
          gives (title, code) rows; each song's own page is then read
          for its real media links. An earlier version DERIVED those
          from the catalogue code and got it badly wrong — see
          [fetch_cdc] for what that cost.

  fuyindiantai.org is deliberately NOT fetched. It is fydt.org's old
  domain (it 301'd to fydt.org through 2025) and its DNS delegation is
  currently broken — both Google and Cloudflare return SERVFAIL because
  it still points at ns1/ns2.fydt.org, which stopped serving the zone
  when fydt.org moved to DigiCert DNS. Its songs ARE the fydt songs;
  see `_FUYINDIANTAI_NOTE` and the `_meta.sources` block we emit.

Usage
-----
    python3 scripts/sync_songs.py            # rewrite assets/songs.json
    python3 scripts/sync_songs.py --dry-run  # report, write nothing
"""

import argparse
import html
import json
import os
import re
import string
import sys
import time
import urllib.parse
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _default_out():
    """Where the catalogue lands, picked from the repo layout.

    The same script runs in two repos: here in yswords-data, where the
    catalogue is a published dataset under `data/`, and in the YsWords
    app repo, where it is a bundled Flutter asset under `assets/`.
    Rather than fork the script, detect which tree we are in — and let
    `--out` / `$SONGS_OUT` override either way.
    """
    override = os.environ.get('SONGS_OUT')
    if override:
        return os.path.abspath(override)
    if os.path.isdir(os.path.join(REPO_ROOT, 'data')):
        return os.path.join(REPO_ROOT, 'data', 'songs.json')
    return os.path.join(REPO_ROOT, 'assets', 'songs.json')


SONGS_JSON = _default_out()

USER_AGENT = 'YsWordsSongsSyncBot/2.0 (+https://yswords.netlify.app)'

# ── Source registry ───────────────────────────────────────────────
# `label` is what the UI shows on the source chip; `home` is the
# attribution link on the About page.
SOURCES = {
    'fydt': {
        'label': '福音电台 FYDT',
        'home': 'https://fydt.org',
        'language': 'zh',
    },
    'cahaya': {
        'label': 'Cahaya Pengharapan',
        'home': 'https://cahayapengharapan.org',
        'language': 'id',
    },
    'cdc': {
        'label': 'Christian Disciples Church',
        'home': 'https://www.christiandiscipleschurch.org',
        'language': 'en',
    },
    'cgdc': {
        'label': '基督門徒福音會 CGDC',
        'home': 'https://cgdc.hk',
        'language': 'zh',
    },
    'setapak': {
        'label': 'Setapak CDC',
        'home': 'https://www.setapakcdc.com',
        'language': 'en',
    },
    'ydh': {
        'label': '雅伟的话 Yahweh De Hua',
        'home': 'https://yahwehdehua.net',
        # The five songs are English compositions; one of them also
        # publishes a Chinese translation. See [fetch_ydh] on why the
        # default is 'en' even though the site itself is Chinese-first.
        'language': 'en',
    },
}

_FUYINDIANTAI_NOTE = (
    'fuyindiantai.org is fydt.org under its former domain (it 301-redirected '
    'to fydt.org through 2025). Its DNS delegation is currently broken '
    '(SERVFAIL — the NS records still point at ns1/ns2.fydt.org, which no '
    'longer serve the zone), so it is not fetched. Every song it published '
    'is already in this catalogue under source "fydt".'
)

FYDT_API = 'https://fydt.org/wp-json/fydt-api/v1'
FYDT_WP = 'https://fydt.org/wp-json/wp/v2'
CAHAYA_AUDIO = 'https://cahayapengharapan.org/pujian/'
CAHAYA_VIDEO = 'https://cahayapengharapan.org/pujian/video-pujian/'
CDC_ROOT = 'https://www.christiandiscipleschurch.org'
CDC_INDEX = f'{CDC_ROOT}/content/integrated-list-songs'

CGDC_ROOT = 'https://cgdc.hk'
CGDC_PAGES = (f'{CGDC_ROOT}/wp-json/wp/v2/pages'
              '?per_page=100&_fields=id,slug,link,title')

# The Hong Kong church publishes one Easter-camp songbook per year as a
# WordPress page whose slug is the year plus "mk" (2023mk, 2024mk, …).
# Matching the PATTERN rather than listing known years is the whole
# point: a 2027mk page goes live and the next weekly sync picks it up
# with no code change.
CGDC_MK_SLUG_RE = re.compile(r'^(\d{4})mk$')

# Those pages render through the Sonaar player, which emits one <li>
# per track carrying everything we need as data-attributes.
CGDC_TRACK_RE = re.compile(
    r'data-audiopath="(?P<url>[^"]+\.mp3)"'
    r'(?P<mid>[^>]*?)'
    r'data-trackTitle="(?P<title>[^"]*)"',
    re.IGNORECASE)
CGDC_ALBUM_RE = re.compile(r'data-albumTitle="([^"]*)"', re.IGNORECASE)
CGDC_TIME_RE = re.compile(r'data-trackTime="([^"]*)"', re.IGNORECASE)

# Album art. 2026-08-11: cgdc had 0 of 63 songs with artwork because
# nothing ever looked — `artworkUrl` was only ever read from fydt's
# WordPress API. Each songbook page carries exactly one songbook logo
# in wp-content/uploads.
#
# The player's own per-track `poster` is NOT used: it is a Vue binding
# (`:src="list.tracks[currentTrack].poster"`) filled over admin-ajax,
# so it is absent from the served HTML. The songbook logo is per-album
# rather than per-song, which is honest — that IS what this church
# publishes per Easter camp.
#
# Excluded: the site favicon (`cropped-cgdc_hk_website_icon-*`) and
# Elementor's generated thumbnails, which are crops of the same file
# under `/elementor/thumbs/`.
CGDC_IMG_RE = re.compile(
    r'https://cgdc\.hk/wp-content/uploads/[^"\'\s<>]+\.(?:jpg|jpeg|png|webp)',
    re.IGNORECASE)
CGDC_IMG_REJECT_RE = re.compile(
    r'website_icon|cropped-|/elementor/thumbs/|logo-\d+x\d+\.', re.IGNORECASE)
# WordPress srcset variants: prefer the original over `-1024x246.png`.
CGDC_IMG_SIZED_RE = re.compile(r'-\d+x\d+\.\w+$')



def _cgdc_album_art(page_html):
    """The one songbook logo on a cgdc songbook page, or None.

    Returns the FULL-SIZE original where the page also carries WordPress
    srcset variants, so the app gets to pick its own decode size rather
    than being stuck with whatever width the page happened to render.
    """
    seen = []
    for u in CGDC_IMG_RE.findall(page_html):
        if CGDC_IMG_REJECT_RE.search(u):
            continue
        if u not in seen:
            seen.append(u)
    if not seen:
        return None
    full = [u for u in seen if not CGDC_IMG_SIZED_RE.search(u)]
    return (full or seen)[0]


# ── setapakcdc.com ────────────────────────────────────────────────
# 2026-09-03. The Kuala Lumpur congregation, added as a fifth source
# for the two songs it publishes. WordPress with the REST API open, so
# this is an API read rather than a scrape.
#
# The two songs are POSTS, not a song custom-post-type: this site has
# no songbook, no catalogue codes and no albums. `/wp-json/wp/v2/posts`
# filtered to the song-ish categories is the whole index.
#
# Categories are resolved by SLUG, never by the numeric id the API
# returns — WordPress term ids are per-install and would silently point
# at some other category if the site were ever rebuilt.
SETAPAK_ROOT = 'https://www.setapakcdc.com'

# `music` and `video` are where a song lands; `media` is the generic
# parent both also carry, so it adds nothing and is not asked for.
SETAPAK_SONG_CATEGORIES = ('music', 'video')

# `messages` is the sermon category. Nothing is in both today, but a
# recorded sermon posted as a video is the one realistic way this
# fetcher starts inventing songs, so it is excluded up front.
SETAPAK_EXCLUDE_CATEGORIES = ('messages',)

# The YouTube embed WordPress writes for an oEmbed block.
SETAPAK_YT_RE = re.compile(
    r'youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_-]{11})')

# Credits sit in their own <p>, above the lyrics, in one of two shapes:
#   作曲：許冠傑, 作词：許冠傑/黎彼得   /   翻唱：Setapak Christian …
#   <em>Song by Hillsong Worship and Jadwin Gillies</em>
#   <em>Cover by Tham Chen Tong</em>
# Both are real conventions rather than one-off phrasing, so they are
# matched by their LABEL. Anything unlabelled is left null — a wrong
# credit on a cover is worse than no credit.
SETAPAK_CREDIT_RES = {
    'composer': re.compile(r'作曲\s*[:：]\s*([^,，。\n]+)'),
    'lyricist': re.compile(r'作[词詞]\s*[:：]\s*([^,，。\n]+)'),
    'artist': re.compile(
        r'(?:翻唱|演唱|主唱)\s*[:：]\s*([^,，。\n]+)'
        r'|(?:^|\n)\s*Cover by\s+([^\n]+)'),
}
# "Song by Hillsong Worship and Jadwin Gillies" — the written-by credit
# on an English cover, which maps to `composer`.
SETAPAK_SONG_BY_RE = re.compile(r'(?:^|\n)\s*Song by\s+([^\n]+)')

# ── yahwehdehua.net ───────────────────────────────────────────────
# 2026-09-03. 雅伟的话 / Yahweh De Hua Ministry — already the source of
# the CUVS-YHWH text this app bundles, and now of five songs.
#
# The songs live inside a SERIES page, not a songbook: hand-written
# Bootstrap 5 with two tabs, "Videos / 视频" and "Songs / 诗歌". The
# song tab is `<div class="tab-pane" id="nav-hymn">` and it holds one
# `.video-card` per song. Anchoring on that tab is the whole reason
# this parse is safe — the page's own structure says which embeds are
# songs and which are the 22 teaching videos, so the fetcher never has
# to guess, and [_ydh_song_cards] refuses rather than guessing if the
# tab ever disappears.
YDH_ROOT = 'https://yahwehdehua.net'

# One entry per series page. A second series with a Songs tab is a
# one-line change here, not new code.
YDH_SONG_PAGES = (f'{YDH_ROOT}/assets/page/easter/',)

# The song tab's pane. `id="nav-hymn"` (with the closing quote) matches
# the pane and NOT the `id="nav-hymn-tab"` button above it, which is
# the whole point of including the quote.
YDH_TAB_MARKER = 'id="nav-hymn"'
YDH_CARD_MARKER = '<div class="video-card">'
YDH_SCRIPTURE_MARKER = 'class="scripture"'

YDH_EMBED_RE = re.compile(
    r'youtube(?:-nocookie)?\.com/embed/([A-Za-z0-9_-]{11})')
YDH_TITLE_RE = re.compile(
    r'<h5[^>]*class="card-title"[^>]*>(.*?)</h5>', re.IGNORECASE | re.DOTALL)
YDH_P_RE = re.compile(r'<p[^>]*>(.*?)</p>', re.IGNORECASE | re.DOTALL)
YDH_BR_SPLIT_RE = re.compile(r'<br\s*/?>', re.IGNORECASE)

# The footer's own copyright line, in both languages:
#   Standing on the Cross Series © 2026 Rosablanca Suen
#   《在十字架下：人生十堂课》 系列 © 2026 Rosablanca Suen
# Taken from the page rather than hard-coded so a different series page
# credits whoever that page credits.
YDH_COPYRIGHT_RE = re.compile(r'©\s*\d{4}\s+([^<\n]+)')

# Scripture citation at the foot of a song card: "(Lk 9:22-23)",
# "(Acts 5:30-31)".
YDH_CITATION_RE = re.compile(
    r'\(\s*([1-3]?\s?[A-Za-z]{2,}\.?)\s*(\d+)\s*:\s*(\d+(?:\s*[-–]\s*\d+)?)'
    r'\s*\)')

# Abbreviation → the English book name the app's book filter expects.
#
# Deliberately SMALL. It covers the books this ministry's pages
# actually cite plus their full spellings; anything else yields no
# `verse` at all and prints a warning, because a mis-resolved book is a
# citation chip that opens the wrong passage — the exact P0 shape
# `tools/add_cross_series_refs.py` was written to avoid. Growing this
# map is a deliberate act with a page to check it against.
YDH_BOOKS = {
    'mt': 'Matthew', 'matt': 'Matthew', 'matthew': 'Matthew',
    'mk': 'Mark', 'mark': 'Mark',
    'lk': 'Luke', 'luke': 'Luke',
    'jn': 'John', 'john': 'John',
    'acts': 'Acts',
    'ps': 'Psalms', 'psalm': 'Psalms', 'psalms': 'Psalms',
}

# Those pages render through the Sonaar player, which emits one <li>
# per track carrying everything we need as data-attributes.
# ── Theme classifier ──────────────────────────────────────────────
# Applied to titles when the source publishes no taxonomy of its own
# (cdc, cahaya). fydt songs get their real `song_category` terms and
# skip this entirely.
THEME_KEYWORDS = [
    ('敬拜', ['敬拜', '尊崇', '颂赞', 'Worship', 'Adore', 'Praise', 'Bless', 'Extol', 'Memuja', 'Menyembah', 'Penyembahan']),
    ('赞美', ['赞美', '颂', '高举', 'Praise', 'Magnif', 'Glory', 'Lifted', '荣耀', '荣美', 'Puji', 'Mulia']),
    ('救恩', ['救', '拯救', 'Salvation', 'Saved', 'Ransomed', 'Redeem', 'Rescue', 'Selamat', 'Keselamatan']),
    ('圣灵', ['灵', '圣灵', 'Spirit', 'Empowered', '圣火', '风随意', 'Roh']),
    ('委身', ['委身', '献', '为你', '凡事', 'Commit', 'Devote', 'Consecrate', 'Allegiance', 'Wholly', 'Komitmen']),
    ('顺服', ['顺服', '跟从', '跟随', '遵', '行你旨意', 'Follow', 'Obey', 'Imitate', 'Submit', 'Taat', 'Kehendak']),
    ('得胜', ['得胜', '胜', '奔', '战', 'Overcome', 'Race', 'Run', 'Fight', 'Strong', 'Bold', 'Menang', 'Kuasa', 'Kekuatan']),
    ('重生', ['重生', '复活', '新', '活', 'Resurrection', 'Reborn', 'Renew', 'New', 'Living', 'Alive', 'Hidup', 'Baru']),
    ('圣洁', ['圣洁', '洁净', '圣', '完全', 'Holy', 'Clean', 'Pure', 'Holiness', 'Perfect', 'Kudus']),
    ('平安', ['平安', '安息', '安静', '宁', 'Peace', 'Rest', 'Still', 'Quiet', 'Damai', 'Tenang']),
    ('感恩', ['感恩', '感谢', '称谢', 'Thank', 'Gratitude', 'Syukur', 'Bersyukur']),
    ('警醒', ['警醒', '儆醒', '醒', '警觉', 'Watch', 'Alert', 'Wake', 'Berjaga']),
    ('信心', ['信心', '信靠', '信', 'Faith', 'Trust', 'Believe', 'Iman', 'Percaya']),
    ('爱', ['爱', 'Love', 'Beloved', 'Kasih', 'Mengasihi']),
    ('仰望', ['仰望', '盼望', '盼', '指望', 'Hope', 'Wait', 'Harap', 'Pengharapan']),
    ('门徒', ['门徒', '弟子', '使徒', 'Disciple', 'Apostle', 'Mission', 'Murid']),
    ('祷告', ['祷告', '祈祷', '求', 'Prayer', 'Pray', 'Mercy', 'Doa']),
    ('真理', ['真理', '真', '智慧', 'Truth', 'Wisdom', 'Word', '话语', '话', 'Kebenaran', 'Hikmat', 'Firman']),
    ('心', ['心', 'Heart', 'Mind', 'Hati']),
    ('神的名', ['雅伟', 'YHWH', 'Yahweh', 'LORD', 'Adonai', '神的名', 'Allah']),
    ('教会', ['教会', '同心', '合一', '联合', 'Church', 'Together', 'United', 'One Heart', 'Bond', '一致', '合意', 'Rukun', 'Gereja']),
    ('见证', ['见证', '传扬', '宣', '使万民', '万民', 'Declare', 'Proclaim', 'Witness', 'Testimony', 'Injil', 'Saksi']),
    ('生命', ['生命', '复生', '生', 'Life', 'Kehidupan']),
    ('诗篇', ['诗篇', 'Psalm', 'Mazmur']),
    ('儿童', ['孩', '童', '小', 'Child', 'Children', 'Anak']),
]

VERSE_RE_ZH = re.compile(r'诗篇\s*(\d+)')
VERSE_RE_EN = re.compile(r'Psalm\s*(\d+)', re.IGNORECASE)

# fydt's ACF `bible_reference` repeater already uses English book
# names ("Colossians", "2Corinthians") — just needs a space inserted
# after a leading numeral.
_NUMBERED_BOOK_RE = re.compile(r'^([123])([A-Z][a-z]+)$')

CDC_ROW_RE = re.compile(
    # Two-cell pattern on the integrated-list-songs view:
    #   <td …views-field-field-song-title…> <title> </td>
    #   <td …views-field-title…> <a href="/content/<code>">CODE</a>
    r'<td[^>]*views-field-field-song-title[^>]*>'
    r'\s*([^<]+?)\s*</td>'
    r'\s*<td[^>]*views-field-title[^>]*>'
    r'\s*<a[^>]+href="(/content/([defDEF]\d{3,5}))"',
    flags=re.IGNORECASE | re.DOTALL,
)

# Both Cahaya pages wrap one song per <p>: a bolded title, then the
# embed, then (audio page only) a "Download lembar lagu" sheet link.
CAHAYA_BLOCK_RE = re.compile(r'<p[^>]*>(.*?)</p>', re.IGNORECASE | re.DOTALL)
CAHAYA_TITLE_RE = re.compile(r'<b[^>]*>(.*?)</b>|<strong[^>]*>(.*?)</strong>',
                             re.IGNORECASE | re.DOTALL)
SOUNDCLOUD_RE = re.compile(r'api\.soundcloud\.com/tracks/(\d+)')
YOUTUBE_RE = re.compile(
    r'(?:youtube\.com/(?:embed/|watch\?v=)|youtu\.be/)([A-Za-z0-9_-]{11})')
CAHAYA_PDF_RE = re.compile(r'href="([^"]+\.pdf)"', re.IGNORECASE)

_BAD_TITLE_RE = re.compile(
    r'^[DEF]\d{3,5}$|&#\d+;|&amp;|&quot;|&#x[0-9a-f]+;', re.IGNORECASE)


# ── HTTP ──────────────────────────────────────────────────────────

def http_get(url, timeout=30, attempts=2):
    """GET as text, polite UA. Returns '' on failure (never raises —
    a single dead page must not abort a 500-song sync).

    Retries once on a non-HTTP failure (timeout, connection reset) —
    the kind of blip the 2026-08-29 CDC hymn incident turned out NOT
    to be (that was fast 200s with no `warn: GET … failed` lines at
    all), but the main() per-row regression guard now refuses to
    write over ANY single row losing its media, so an ordinary
    network blip that used to just cost one row's audio silently can
    now abort the whole write. A real HTTP error (404 etc.) is
    definitive and not retried.
    """
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('utf-8', errors='replace')
        except urllib.error.HTTPError as e:
            print(f'  warn: GET {url} failed: {e}', file=sys.stderr)
            return ''
        except Exception as e:
            if attempt == attempts - 1:
                print(f'  warn: GET {url} failed: {e}', file=sys.stderr)
                return ''
            time.sleep(1.0)


def http_json(url, timeout=40):
    """GET + parse JSON. Returns None on failure."""
    raw = http_get(url, timeout=timeout)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        print(f'  warn: bad JSON from {url}: {e}', file=sys.stderr)
        return None


# ── Helpers ───────────────────────────────────────────────────────

def clean_title(raw):
    """Decode entities, collapse whitespace, strip the fydt site
    suffix that creeps in via <title> tags."""
    if not raw:
        return None
    t = html.unescape(raw).strip()
    t = re.sub(r'\s*[\-–—|]\s*FYDT.*$', '', t, flags=re.IGNORECASE).strip()
    t = re.sub(r'\s*[\-–—|]\s*福音电台.*$', '', t).strip()
    t = re.sub(r'<[^>]+>', '', t)
    return re.sub(r'\s+', ' ', t).strip() or None


def detect_language(title, default='en'):
    """zh / id / en from a title. The catalogue is bilingual at the
    title level (whole title in one language), never paragraph-mixed,
    so a CJK sniff is enough to separate zh; everything else keeps
    the source's declared default."""
    if any('一' <= c <= '鿿' for c in title):
        return 'zh'
    return default


def infer_themes(title):
    out = set()
    for theme, keywords in THEME_KEYWORDS:
        for kw in keywords:
            if kw.lower() in title.lower():
                out.add(theme)
                break
    return sorted(out)


def infer_verse(title):
    m = VERSE_RE_ZH.search(title) or VERSE_RE_EN.search(title)
    if m:
        return f'Psalms {m.group(1)}'
    if 'Shema' in title:
        return 'Deuteronomy 6:4'
    if 'Our Father' in title or '主祷文' in title:
        return 'Matthew 6:9-13'
    return None


def normalise_book(name):
    """'2Corinthians' → '2 Corinthians'. fydt already stores English
    book names; they just lack the space after a leading numeral."""
    if not name:
        return None
    m = _NUMBERED_BOOK_RE.match(name.strip())
    return f'{m.group(1)} {m.group(2)}' if m else name.strip()


def format_verse(refs):
    """Render fydt's `bible_reference` repeater as 'Colossians 1:9-11'.
    Only the first citation is kept — the app's book-filter chip is
    single-valued and a two-book string would match neither."""
    if not isinstance(refs, list) or not refs:
        return None
    r = refs[0]
    if not isinstance(r, dict):
        return None
    book = normalise_book(r.get('books'))
    if not book:
        return None
    chapter = str(r.get('chaptertyped') or '').strip()
    verses = str(r.get('verses') or '').strip()
    if chapter and verses:
        return f'{book} {chapter}:{verses}'
    if chapter:
        return f'{book} {chapter}'
    return book


def duration_to_seconds(value):
    """fydt's custom API returns integer seconds; the ACF field is a
    'm:ss' string. Accept either."""
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    if isinstance(value, str) and ':' in value:
        parts = value.strip().split(':')
        try:
            nums = [int(p) for p in parts]
        except ValueError:
            return None
        secs = 0
        for n in nums:
            secs = secs * 60 + n
        return secs or None
    return None


def strip_lyrics(raw):
    """fydt ships lyrics either as plain text with \\r\\n (custom API)
    or as span-wrapped HTML (`body_lyrics_display`). Normalise both to
    plain text with \\n breaks."""
    if not raw:
        return None
    t = re.sub(r'(?is)<(script|style).*?</\1>', '', raw)
    t = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</span>\s*\r?\n', '\n', t)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t).replace('\r\n', '\n').replace('\r', '\n')
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip() or None


def normalise_url(url):
    """Percent-encode a URL's path so it is a valid URI.

    cgdc.hk publishes filenames with raw Chinese characters
    (`2026-04-Increase-开展.mp3`). Browsers quietly encode those on
    request, so the links work when clicked — but the raw string is not
    a valid URI, the JSON Schema's `format: uri` rejects it, and
    Dart's Uri/http handling of unencoded UTF-8 in a path is not
    something to rely on. Encoding at sync time means every consumer
    receives something unambiguous.

    Already-encoded URLs pass through unchanged: `%` is in the safe
    set, so `%E5%BC%80` is not re-encoded into `%25E5%25BC%2580`.
    """
    if not url:
        return url
    return urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%~")


def first_url(items, *keys):
    """Pull the first non-empty URL out of one of fydt's repeater
    groups, e.g. `songFiles: [{songId, songUrl}]`."""
    if not isinstance(items, list):
        return None
    for it in items:
        if isinstance(it, str) and it.strip():
            return it.strip()
        if isinstance(it, dict):
            for k in keys:
                v = it.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
    return None


def _is_bad_title(t):
    """Titles that should be replaced by a fresh fetch: entity-laden,
    site-suffix-padded, or a bare catalogue code."""
    if not t:
        return True
    if _BAD_TITLE_RE.search(t):
        return True
    return 'FYDT' in t.upper() or '福音电台' in t


def _now_iso():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


# Canonical key order for every catalogue row. Enforced on write so
# entries carried over from the pre-v2 schema line up with fresh ones
# and `git diff` on songs.json stays readable.
FIELD_ORDER = (
    'id', 'title', 'language', 'source', 'sourceLabel', 'code', 'url',
    'album', 'artist', 'composer', 'lyricist', 'durationSec',
    'audioUrl', 'instrumentalUrl', 'accompanimentUrl', 'audioTracks',
    'videoUrl', 'youtubeId', 'soundcloudTrackId',
    'scoreUrl', 'artworkUrl', 'lyrics',
    'themes', 'verse', 'firstSeenAt', 'updatedAt',
)

# Fields whose empty value is a list, not None.
LIST_FIELDS = ('themes', 'audioTracks')

# Pre-v2 field names, mapped to where they live now. `pdfUrl` became
# `scoreUrl` when Cahaya joined — its PDFs are sheet music ("lembar
# lagu"), not the generic attachment the old name implied.
LEGACY_FIELDS = {'pdfUrl': 'scoreUrl'}


def make_entry(source, slug, title, url, **extra):
    """Build one catalogue row with every media field present (None
    when absent) so the Dart decoder never has to branch on shape."""
    src = SOURCES[source]
    entry = {k: None for k in FIELD_ORDER}
    entry.update({
        'id': f'{source}:{slug}',
        'title': title,
        'language': extra.pop('language', None) or src['language'],
        'source': source,
        'sourceLabel': src['label'],
        'code': extra.pop('code', None),
        'url': url,
    })
    for k in LIST_FIELDS:
        entry[k] = []
    entry.update({k: v for k, v in extra.items() if k in entry})
    return entry


def normalise(entry):
    """Fold pre-v2 field names into their current homes and re-emit in
    canonical order, dropping anything the schema no longer carries."""
    row = dict(entry)
    for old, new in LEGACY_FIELDS.items():
        value = row.pop(old, None)
        if value and not row.get(new):
            row[new] = value
    out = {k: (row.get(k) or []) if k in LIST_FIELDS else row.get(k)
           for k in FIELD_ORDER}
    # Encode every media URL centrally rather than at each fetcher, so
    # a new source cannot forget to. See [normalise_url].
    for k in ('audioUrl', 'instrumentalUrl', 'accompanimentUrl',
              'videoUrl', 'scoreUrl', 'artworkUrl', 'url'):
        if out.get(k):
            out[k] = normalise_url(out[k])
    out['audioTracks'] = [
        {**t, 'url': normalise_url(t['url'])}
        for t in (out.get('audioTracks') or []) if t.get('url')
    ]
    return out


# ── fydt.org ──────────────────────────────────────────────────────

def fetch_fydt_taxonomy():
    """song_category term id → Chinese name."""
    terms = http_json(
        f'{FYDT_WP}/song_category?per_page=100&_fields=id,name') or []
    return {t['id']: t['name'] for t in terms if t.get('id')}


def fetch_fydt_wp_index():
    """Canonical `wp/v2/song` list keyed by post id. Supplies the
    taxonomy terms and Bible reference the custom API omits, and acts
    as the completeness backstop for the pinyin enumeration."""
    index = {}
    for page in range(1, 8):  # 213 songs today; cap well clear of it
        url = (f'{FYDT_WP}/song?per_page=100&page={page}'
               '&_fields=id,title,link,acf,song_category')
        rows = http_json(url)
        if not rows:
            break
        for p in rows:
            index[p['id']] = p
        if len(rows) < 100:
            break
    return index


FYDT_MEDIA_RE = re.compile(
    r'https?://[^\s"\'()<>]+\.(?:mp3|m4a|pdf)', re.IGNORECASE)


def fydt_media_from_page(url):
    """Media links scraped from a song's own page on fydt.org.

    The custom API is the source of truth and covers 212 of 213 songs.
    The exception is a legacy row — 你们是世上的光 (S01_038) — that the
    API returns with every media field empty and that `wp/v2/song`
    does not list at all, while its PAGE links a score PDF. Trusting
    the API alone therefore published a song with no audio, no score
    and nothing to tap, next to a website that clearly offers the
    sheet music. A user noticed and asked why.

    Only called when the API gave nothing, so this costs one extra
    request for the handful of rows that need it rather than 213.

    Returns (audio, score), either of which may be None.
    """
    html_text = http_get(url)
    if not html_text:
        return None, None
    audio = score = None
    for raw in FYDT_MEDIA_RE.findall(html_text):
        low = raw.lower()
        if low.endswith('.pdf'):
            score = score or normalise_url(raw)
        elif audio is None:
            audio = normalise_url(raw)
    return audio, score


def fetch_fydt(taxonomy, wp_index):
    """Enumerate the custom API over pinyin A–Z (that is the only
    listing endpoint it exposes), then diff against `wp/v2/song` and
    build the stragglers — legacy entries with no pinyin term — from
    WordPress alone."""
    by_post_id = {}

    for letter in string.ascii_uppercase:
        payload = http_json(
            f'{FYDT_API}/songs/json/listSongsBySearchKey'
            f'?search_type=pinyin&search_key={letter}')
        for s in (payload or {}).get('data') or []:
            if isinstance(s, dict) and s.get('id') is not None:
                by_post_id[s['id']] = s
        time.sleep(0.15)  # be a good neighbour on the church's box

    print(f'  fydt: {len(by_post_id)} via pinyin A-Z, '
          f'{len(wp_index)} in wp/v2 index')

    entries = []
    for post_id, wp in sorted(wp_index.items()):
        api = by_post_id.get(post_id) or {}
        acf = wp.get('acf') or {}

        title = (clean_title(api.get('title'))
                 or clean_title(acf.get('title'))
                 or clean_title((wp.get('title') or {}).get('rendered')))
        if not title:
            continue

        themes = [taxonomy[t] for t in (wp.get('song_category') or [])
                  if t in taxonomy]

        page_url = api.get('webSiteUrl') or wp.get('link')
        audio_url = first_url(api.get('songFiles'), 'songUrl')
        instrumental = first_url(api.get('songInstrumentalFiles'), 'songUrl')
        accompaniment = first_url(api.get('songAccompanyFiles'), 'songUrl')
        score_url = first_url(api.get('scoresUrl'), 'url')

        # Nothing at all from the API → look at the page itself before
        # publishing a row with no media. See fydt_media_from_page.
        if not any((audio_url, instrumental, accompaniment, score_url)) \
                and page_url:
            page_audio, page_score = fydt_media_from_page(page_url)
            audio_url = audio_url or page_audio
            score_url = score_url or page_score
            if page_audio or page_score:
                print(f'  fydt: recovered media from the page for {title}',
                      file=sys.stderr)

        entries.append(make_entry(
            'fydt', str(post_id), title,
            page_url,
            code=acf.get('song_id_number') or None,
            artist=api.get('artist') or None,
            composer=api.get('composer') or None,
            lyricist=api.get('lyricist') or None,
            durationSec=(duration_to_seconds(api.get('duration'))
                         or duration_to_seconds(
                             acf.get('time_length_of_song'))),
            audioUrl=audio_url,
            instrumentalUrl=instrumental,
            accompanimentUrl=accompaniment,
            # Same uniform track list CDC now produces, so a consumer
            # can render every mix from one field regardless of source.
            audioTracks=build_tracks([
                (audio_url, 'vocal', None),
                (instrumental, 'instrumental', None),
                (accompaniment, 'accompaniment', None),
            ]),
            videoUrl=first_url(api.get('mvUrls'), 'url'),
            scoreUrl=score_url,
            artworkUrl=api.get('artworkUrl') or None,
            lyrics=(strip_lyrics(api.get('lyrics'))
                    or strip_lyrics(acf.get('body_lyrics_display'))),
            themes=themes or infer_themes(title),
            verse=(format_verse(acf.get('bible_reference'))
                   or infer_verse(title)),
        ))
    return entries


# ── cahayapengharapan.org ─────────────────────────────────────────

def _cahaya_blocks(page_html, base_url):
    """Yield (title, block_html) for each <p> that holds one song."""
    for m in CAHAYA_BLOCK_RE.finditer(page_html):
        block = m.group(1)
        tm = CAHAYA_TITLE_RE.search(block)
        if not tm:
            continue
        title = clean_title(tm.group(1) or tm.group(2))
        if not title or len(title) > 120:
            continue
        yield title, block, base_url


def _cahaya_slug(title):
    slug = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
    return slug or 'song'


def fetch_cahaya():
    """Merge the audio page (SoundCloud + sheet music) with the video
    page (YouTube) on normalised title, so a song published in both
    places lands as ONE entry carrying both."""
    by_key = {}

    audio_html = http_get(CAHAYA_AUDIO)
    for title, block, base in _cahaya_blocks(audio_html, CAHAYA_AUDIO):
        sc = SOUNDCLOUD_RE.search(block)
        pdf = CAHAYA_PDF_RE.search(block)
        if not sc and not pdf:
            continue
        key = title.casefold()
        entry = make_entry(
            'cahaya', _cahaya_slug(title), title, CAHAYA_AUDIO,
            soundcloudTrackId=sc.group(1) if sc else None,
            scoreUrl=(urllib.parse.urljoin(base, html.unescape(pdf.group(1)))
                      if pdf else None),
            themes=infer_themes(title),
            verse=infer_verse(title),
        )
        by_key[key] = entry

    video_html = http_get(CAHAYA_VIDEO)
    for title, block, _ in _cahaya_blocks(video_html, CAHAYA_VIDEO):
        yt = YOUTUBE_RE.search(block)
        if not yt:
            continue
        key = title.casefold()
        if key in by_key:
            by_key[key]['youtubeId'] = yt.group(1)
            continue
        by_key[key] = make_entry(
            'cahaya', _cahaya_slug(title), title, CAHAYA_VIDEO,
            youtubeId=yt.group(1),
            themes=infer_themes(title),
            verse=infer_verse(title),
        )

    entries = list(by_key.values())
    audio_n = sum(1 for e in entries if e['soundcloudTrackId'])
    video_n = sum(1 for e in entries if e['youtubeId'])
    print(f'  cahaya: {len(entries)} songs '
          f'({audio_n} audio, {video_n} video)')
    return entries


# ── christiandiscipleschurch.org ──────────────────────────────────

# CDC's filename suffixes, learned by reading the published pages:
#   D0180.mp3           the sung track
#   D0375_English.mp3   \ bilingual songs publish one per language and
#   D0375_Chinese.mp3   / usually have no bare-code file at all
#   D0180i.mp3          instrumental  (same 'i' convention fydt uses)
#   D0415m.mp3          minus-one / accompaniment
#   D0180_melody.mp3    melody-only guide track
#   E0440R.mp3          a revised re-recording; still the sung take
_CDC_SUFFIXES = [
    ('_english', 'vocal', 'en'),
    ('_chinese', 'vocal', 'zh'),
    ('melody', 'instrumental', None),
    ('_melody', 'instrumental', None),
    ('i', 'instrumental', None),
    ('m', 'accompaniment', None),
    ('r', 'vocal', None),
    ('', 'vocal', None),
]

_MP3_RE = re.compile(r'["\'(]([^"\'()\s\\]+\.mp3)["\')]', re.IGNORECASE)
_PDF_RE = re.compile(r'["\'(]([^"\'()\s\\]+\.pdf)["\')]', re.IGNORECASE)


#: Suffixes seen in the wild that were not in the original list —
#: recorded so the sync can report them rather than silently guess.
UNKNOWN_CDC_SUFFIXES = set()


def classify_cdc_track(filename, code):
    """('vocal'|'instrumental'|'accompaniment', lang|None) for a CDC
    mp3 filename, or None when it does not belong to `code`.

    Deliberately PERMISSIVE about suffixes it does not recognise. The
    first version of this only accepted a fixed list and returned None
    otherwise — so `E0440R.mp3` was dropped and that song showed up as
    having no audio at all, which is how this whole class of bug got
    reported in the first place. Anything whose stem starts with the
    catalogue code is that song's audio; an unrecognised suffix is
    treated as another vocal take and recorded in
    [UNKNOWN_CDC_SUFFIXES] so a new convention surfaces in the sync log
    instead of quietly costing us a track.
    """
    stem = filename[:-4] if filename.lower().endswith('.mp3') else filename
    # Drupal appends _0, _1… when a file is re-uploaded; same track.
    stem = re.sub(r'_\d+$', '', stem)
    if not stem.upper().startswith(code.upper()):
        return None
    suffix = stem[len(code):].lower()
    for candidate, kind, lang in _CDC_SUFFIXES:
        if suffix == candidate:
            return kind, lang
    UNKNOWN_CDC_SUFFIXES.add(suffix)
    return 'vocal', None


def parse_cdc_media(page_html, code):
    """Pull the real media links out of one CDC song page."""
    if not page_html:
        return {'tracks': [], 'score': None}

    # Keyed on the normalised filename stem, NOT on (kind, lang):
    # since unrecognised suffixes all classify as plain vocal, keying
    # on the classification would make `D0180.mp3` and `D0180R.mp3`
    # collide and silently drop one. Each page lists every file twice
    # (player markup + download link) and `_0` re-uploads normalise
    # onto the same stem, so this still dedupes what should dedupe.
    tracks = {}
    for raw in _MP3_RE.findall(page_html):
        name = raw.rsplit('/', 1)[-1]
        classified = classify_cdc_track(name, code)
        if not classified:
            continue
        kind, lang = classified
        stem = re.sub(r'_\d+$', '', name[:-4]).lower()
        url = urllib.parse.urljoin(CDC_ROOT, raw.replace('\\/', '/'))
        tracks.setdefault(stem, {'url': url, 'kind': kind, 'lang': lang})

    score = None
    for raw in _PDF_RE.findall(page_html):
        name = raw.rsplit('/', 1)[-1]
        if name.upper().startswith(code.upper()):
            score = urllib.parse.urljoin(CDC_ROOT, raw.replace('\\/', '/'))
            break

    # Sung takes first (language-tagged before the bare one), then the
    # instrumental, then the minus-one — the order the detail sheet
    # shows them in.
    def rank(t):
        kind_rank = {'vocal': 0, 'instrumental': 1, 'accompaniment': 2}
        return (kind_rank.get(t['kind'], 3), t['lang'] is None, t['url'])

    return {'tracks': sorted(tracks.values(), key=rank), 'score': score}


def build_tracks(candidates):
    """[(url, kind, lang), …] → the audioTracks list, dropping empties."""
    return [{'url': url, 'kind': kind, 'lang': lang}
            for url, kind, lang in candidates if url]


def _track_url(tracks, kind):
    for t in tracks or []:
        if t['kind'] == kind:
            return t['url']
    return None


def pick_primary_audio(tracks, language):
    """Which track the play button uses.

    Prefer a vocal take in the song's own language — a title listed in
    English should not start playing in Chinese — then any vocal, then
    nothing. Instrumentals are never primary: someone tapping play on a
    song expects to hear it sung.
    """
    vocals = [t for t in (tracks or []) if t['kind'] == 'vocal']
    if not vocals:
        return None
    for t in vocals:
        if t['lang'] == language:
            return t['url']
    for t in vocals:
        if t['lang'] is None:
            return t['url']
    return vocals[0]['url']


def fetch_cdc():
    """Walk the paginated integrated-list-songs view for (title, code,
    path) rows, then read each song's own page for its real media
    links.

    2026-08-09: this used to DERIVE the URLs from the catalogue code
    (`D0180` → `.../mp3/D0180.mp3`) and HEAD-check the guesses. That
    was wrong in both directions, and a user caught it:

      • It missed every bilingual song. CDC publishes those as
        `D0375_English.mp3` + `D0375_Chinese.mp3` with no plain
        `D0375.mp3`, so the guess 404'd and the sync concluded the
        audio "was never uploaded". It was there the whole time,
        under a name the guess could not reach — that is where the
        supposed 23 missing files went.
      • It missed the instrumental and accompaniment tracks on
        essentially every CDC song (`D0180i.mp3`, `D0415m.mp3`),
        because it only ever looked for the bare code.

    Reading the page costs ~283 fetches per sync instead of ~566 HEAD
    checks, and returns what the church actually published rather than
    what we hoped it had named things.
    """
    import concurrent.futures

    rows = []
    seen = set()
    for page in range(0, 10):
        page_html = http_get(f'{CDC_INDEX}?page={page}')
        if not page_html:
            continue
        before = len(seen)
        for m in CDC_ROW_RE.finditer(page_html):
            title_raw, path, code = m.group(1), m.group(2), m.group(3).upper()
            if code in seen:
                continue
            title = clean_title(title_raw)
            if not title or _is_bad_title(title):
                continue
            seen.add(code)
            rows.append((title, code, path))
        if len(seen) == before:
            break

    print(f'  cdc: {len(rows)} songs, reading each page for media…')

    def build(row):
        title, code, path = row
        url = f'{CDC_ROOT}{path}'
        media = parse_cdc_media(http_get(url), code)
        language = detect_language(title, default='en')
        return make_entry(
            'cdc', code.lower(), title, url,
            code=code,
            language=language,
            audioUrl=pick_primary_audio(media['tracks'], language),
            instrumentalUrl=_track_url(media['tracks'], 'instrumental'),
            accompanimentUrl=_track_url(media['tracks'], 'accompaniment'),
            audioTracks=media['tracks'],
            scoreUrl=media['score'],
            themes=infer_themes(title),
            verse=infer_verse(title),
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        entries = list(pool.map(build, rows))

    with_audio = sum(1 for e in entries if e['audioUrl'])
    extra = sum(len(e['audioTracks'] or []) for e in entries)
    print(f'  cdc: {with_audio}/{len(entries)} have audio, '
          f'{extra} tracks total')
    if UNKNOWN_CDC_SUFFIXES:
        # Not a failure — the file IS captured, as a vocal take. But a
        # new suffix means CDC has a convention we do not model yet, so
        # say so rather than let it pass unnoticed.
        print(f'  cdc: note — unrecognised filename suffixes treated as '
              f'vocal: {sorted(UNKNOWN_CDC_SUFFIXES)}')
    return entries



CDC_HYMNS_INDEX = f'{CDC_ROOT}/content/classic-piano-hymns'
# The hymn pages are h01…h15 — a two-digit code, NOT the four-digit
# `[a-z]\d{4}` every other CDC song uses, which is exactly why they
# were invisible to this sync for so long.
CDC_HYMN_SLUG = 'h{:02d}'
CDC_HYMN_MP3_RE = re.compile(
    r'https?://[^\s"\')]+/files/hymns/mp3/[^\s"\')]+\.mp3', re.I)
CDC_HYMN_PDF_RE = re.compile(
    r'https?://[^\s"\')]+/files/hymns/pdf/[^\s"\')]+\.pdf', re.I)


def fetch_cdc_hymns(existing=None):
    """CDC's "Classic Piano Hymns" — 15 public-domain hymns.

    A separate collection from the 283-song D/E catalogue, and it was
    missed entirely until a user said songs were still missing. Three
    things hid it: the pages are numbered `h01`…`h15` rather than the
    four-digit codes everything else uses, the audio lives under
    `/files/hymns/mp3/` instead of `/files/music/mp3/`, and none of
    them appear in `integrated-list-songs`, which is the only index
    this sync used to read.

    The church's own note says these were downloaded from
    divinerevelations.info, which places them in the public domain and
    explicitly invites redistribution; CDC re-edited the audio and
    produced the PDF lyric sheets. Every one has both an mp3 and a PDF.

    Titles come from the media filename — the pages are titled just
    "h01" — so `I_Sing_the_Mighty_Power_of_God.mp3` becomes
    "I Sing the Mighty Power of God".

    `existing` (the `{id: row}` map `load_existing()` produces) is the
    carry-forward source for the all-pages-answered-but-no-mp3 case
    below — see there for why this single collection used to take the
    other five sources down with it.
    """
    entries = []
    pages_read = 0
    for n in range(1, 16):
        slug = CDC_HYMN_SLUG.format(n)
        link = f'{CDC_ROOT}/content/{slug}'
        html = http_get(link)
        if not html:
            continue
        pages_read += 1
        mp3 = CDC_HYMN_MP3_RE.search(html)
        if not mp3:
            # No audio means nothing to add: these exist to be heard,
            # and a lyric PDF on its own is already in the score-only
            # rows the D/E catalogue provides.
            print(f'  cdc hymns: {slug} has no mp3', file=sys.stderr)
            continue
        pdf = CDC_HYMN_PDF_RE.search(html)
        audio = normalise_url(mp3.group(0))
        stem = urllib.parse.unquote(audio.rsplit('/', 1)[-1])
        title = clean_title(re.sub(r'\.mp3$', '', stem, flags=re.I)
                            .replace('_', ' '))
        entries.append(make_entry(
            'cdc', slug, title, link,
            code=slug.upper(),
            language='en',
            audioUrl=audio,
            # Marked as the ordinary take rather than `instrumental`.
            # The church calls them "played beautifully on the piano"
            # but also mentions stanzas, so whether a voice is present
            # is genuinely unclear from the page — and `vocal` is the
            # classification that cannot make a song unplayable, since
            # an instrumental-only row is skipped under the default
            # preference.
            audioTracks=build_tracks([(audio, 'vocal', 'en')]),
            scoreUrl=normalise_url(pdf.group(0)) if pdf else None,
            album='Classic Piano Hymns',
            themes=infer_themes(title),
            verse=infer_verse(title),
        ))
    # 2026-08-29: all 15 pages once answered fast (0.73s total, zero
    # `warn: GET … failed` lines) with 200s that carried no mp3 link in
    # any of them — a partial-content response, not CDC deleting its
    # whole hymn collection overnight. The per-source guards in main()
    # (which bucket hymns under the same 'cdc' source as the 283-song
    # D/E catalogue) can miss a loss this size entirely: the blended
    # source count and audio ratio both stay inside tolerance while
    # these 15 rows vanish underneath them.
    #
    # 2026-09-05: this used to `raise` the moment ALL 15 came back
    # empty, and that raise aborted `main()`'s entire six-source fetch
    # expression — cdc/fydt/cgdc/cahaya/setapak/ydh all withheld
    # because one 15-song collection had a bad day. That ran six days
    # straight (2026-08-30 onward) and, because setapak/ydh had just
    # been ported but never had a single successful run to publish
    # from, held two whole sources out of the shipped app indefinitely.
    #
    # Gating on "ALL 15 empty" was itself too narrow a trigger: a
    # PARTIAL failure (a few pages fetch fine, the rest don't — plenty
    # plausible for a block whose cause is still unconfirmed) or a
    # total connection failure (`http_get` returns '' for every page,
    # so `pages_read` never even reaches 1) both fell through this
    # check untouched, straight into the per-row regression guard in
    # main() (`dropped = set(existing) - set(merged)`), which aborts
    # unconditionally on ANY missing id — reproducing the exact
    # whole-sync abort this function exists to prevent, just from a
    # different-shaped failure.
    #
    # So this reconciles per ID, not all-or-nothing: whichever of the
    # 15 expected ids didn't get a fresh row this run — for any reason,
    # no mp3 found, page fetch failed, or the whole server was down —
    # gets its previously-stored row carried forward unchanged instead
    # (merge() sees identical values and leaves updatedAt alone). The
    # refusal to DELETE a row nobody could re-derive is still correct
    # and unchanged; only the blast radius was wrong. An id missing
    # from BOTH this run and the stored catalogue is not a regression —
    # nothing existed before either — so it is simply left out, same as
    # any ordinary "this one page has no mp3" case always has been.
    expected_ids = {f'cdc:{CDC_HYMN_SLUG.format(n)}' for n in range(1, 16)}
    got_ids = {e['id'] for e in entries}
    missing = sorted(expected_ids - got_ids)
    carried = [existing[sid] for sid in missing if existing and sid in existing]
    if missing:
        print(f'  warn: cdc hymns: {len(missing)} of 15 page(s) did not '
              f'yield a fresh row this run (no mp3 found, or the fetch '
              f'itself failed) — treating as a failed fetch for those, '
              f'not an upstream deletion. Carrying forward {len(carried)} '
              f'previously-stored row(s) unchanged so the rest of the '
              f'sync is not blocked; {len(missing) - len(carried)} have no '
              f'stored fallback either and stay absent.', file=sys.stderr)
    all_entries = entries + carried
    if pages_read and not all_entries:
        # Genuinely nothing to ship and nothing stored to protect —
        # first run, or the rows were already lost. This is the only
        # case left that still refuses to write.
        raise RuntimeError(
            f'cdc hymns: {pages_read} page(s) answered but NONE '
            f'contained an mp3, and nothing stored to carry forward — '
            f'refusing to write an empty hymn collection')
    print(f'  cdc hymns: {len(entries)} fresh + {len(carried)} '
          f'carried-forward = {len(all_entries)} classic piano hymns')
    return all_entries


# ── cgdc.hk ───────────────────────────────────────────────────────

def fetch_cgdc():
    """The Hong Kong church's Easter-camp songbooks, one page per year.

    Years are DISCOVERED, never listed: `wp/v2/pages` is filtered by the
    `\\d{4}mk` slug pattern, so next year's book joins the catalogue on
    its own. Hard-coding 2023–2026 would have meant a code change every
    Easter, and in practice it would just have been forgotten.

    Note the printed songbooks for 2021 and 2022 carry QR codes to
    `cgdc.hk/2021mk` / `2022mk`, and BOTH 404 — those pages are not on
    the site (no draft, no private copy; checked against the full page
    list). Nothing can be synced for them until the church republishes;
    the pattern match will pick them up automatically if it ever does.
    """
    pages = http_json(CGDC_PAGES) or []
    books = []
    for p in pages:
        m = CGDC_MK_SLUG_RE.match(p.get('slug') or '')
        if m:
            books.append((m.group(1), p.get('link')))
    books.sort()

    if not books:
        print('  cgdc: no MK songbook pages found', file=sys.stderr)
        return []

    # Album names come from the sr_playlist post titles, which are
    # curated ("2024 Bravery 刚强奋勇"). The pages' own
    # `data-albumTitle` is not trustworthy — on the 2024 page it is
    # literally the string "https://cgdc.hk/2024mk", which would
    # otherwise be carried into the catalogue as an album name.
    albums_by_year = {}
    for a in http_json(f'{CGDC_ROOT}/wp-json/wp/v2/sr_playlist'
                       '?per_page=100&_fields=title') or []:
        name = clean_title((a.get('title') or {}).get('rendered'))
        if not name:
            continue
        year = re.match(r'^(\d{4})', name)
        if year:
            albums_by_year[year.group(1)] = name

    entries = []
    for year, link in books:
        page_html = http_get(link)
        if not page_html:
            continue

        album = albums_by_year.get(year)
        if not album:
            page_album = CGDC_ALBUM_RE.search(page_html)
            candidate = (clean_title(page_album.group(1))
                         if page_album else None)
            # Reject the URL-shaped values some pages carry.
            album = (candidate
                     if candidate and not candidate.startswith('http')
                     else None)
        times = CGDC_TIME_RE.findall(page_html)
        # One logo per songbook, shared by every track in it.
        album_art = _cgdc_album_art(page_html)

        # Sheet music sits on the same page, keyed by the track number
        # ("2024-01"). Matching on the FULL filename does not work:
        # audio carries recording-date suffixes
        # (2024-01-当刚强非常壮胆-01-04-2024.mp3) while the PDF does
        # not, and several tracks ship both a Chinese-named and an
        # English-named score. The track number is the only part both
        # sides agree on.
        pdfs = {}
        for raw in _PDF_RE.findall(page_html):
            name = urllib.parse.unquote(raw.rsplit('/', 1)[-1])
            num = re.match(r'^(\d{4}-\d+)', name)
            if num:
                pdfs.setdefault(num.group(1),
                                urllib.parse.urljoin(CGDC_ROOT, raw))

        seen = set()
        for idx, m in enumerate(CGDC_TRACK_RE.finditer(page_html)):
            url = urllib.parse.urljoin(CGDC_ROOT, m.group('url'))
            if url in seen:
                continue
            seen.add(url)

            raw_title = clean_title(html.unescape(m.group('title')))
            stem = urllib.parse.unquote(
                m.group('url').rsplit('/', 1)[-1])[:-4]
            title = raw_title or clean_title(stem)
            if not title:
                continue
            # Titles arrive as "2023-02 多结果子" — the track number is
            # useful as a code, not as part of the name.
            code = None
            numbered = re.match(r'^(\d{4}-\d+)\s+(.*)$', title)
            if numbered:
                code, title = numbered.group(1), numbered.group(2).strip()

            entries.append(make_entry(
                'cgdc', f'{year}-{len(seen):02d}', title, link,
                code=code,
                language=detect_language(title, default='zh'),
                durationSec=duration_to_seconds(
                    times[idx] if idx < len(times) else None),
                audioUrl=url,
                audioTracks=build_tracks([(url, 'vocal', None)]),
                scoreUrl=pdfs.get(code or ''),
                # Per-ALBUM, not per-song — see _cgdc_album_art. Before
                # this, all 63 cgdc songs had no artwork at all.
                artworkUrl=album_art,
                # The songbook name ("2023 多结果子 Fruitfulness") is an
                # album, not a theme — themes are a closed vocabulary
                # with localised labels, and stuffing a free-text
                # album in there would break that contract.
                album=album,
                themes=infer_themes(title),
                verse=infer_verse(title),
            ))

    years = ', '.join(y for y, _ in books)
    print(f'  cgdc: {len(entries)} songs across {len(books)} '
          f'songbooks ({years})')
    return entries


# ── setapakcdc.com ────────────────────────────────────────────────

def _setapak_category_ids(slugs):
    """WordPress term ids for [slugs], resolved through the API.

    Returns {} when the lookup fails, which the caller treats as "do
    not fetch" rather than "fetch everything" — an unfiltered
    `wp/v2/posts` here would sweep in 83 Moments posts and 26 sermons.
    """
    out = {}
    for slug in slugs:
        terms = http_json(
            f'{SETAPAK_ROOT}/wp-json/wp/v2/categories'
            f'?slug={urllib.parse.quote(slug)}&_fields=id,slug') or []
        for t in terms:
            if t.get('slug') == slug and t.get('id'):
                out[slug] = t['id']
    return out


def _setapak_credits(text):
    """Composer / lyricist / performer from a post's credit lines.

    Label-anchored on purpose (see SETAPAK_CREDIT_RES). An unlabelled
    line yields nothing: with a catalogue this small a guess would be
    indistinguishable from data, and both songs here are COVERS, where
    a mis-assigned credit names the wrong person entirely.
    """
    out = {}
    for field, rx in SETAPAK_CREDIT_RES.items():
        m = rx.search(text)
        if m:
            value = next((g for g in m.groups() if g), None)
            if value:
                out[field] = value.strip()
    if 'composer' not in out:
        m = SETAPAK_SONG_BY_RE.search(text)
        if m:
            out['composer'] = m.group(1).strip()
    return out


def fetch_setapak():
    """The Setapak (Kuala Lumpur) congregation's two songs.

    Added 2026-09-03 at the user's direction, over a recommendation not
    to: both are members' own YouTube uploads, one of them explicitly a
    cover, with no audio file, no score, no catalogue code and no album.
    That is a real shape the app already renders — 20 Cahaya rows are
    the same YouTube-only shape — so the objection was to the *value*,
    not to the mechanics, and the decision was the user's to make.

    **Lyrics are deliberately not carried.** Both posts print the full
    lyrics, and both are covers of songs this church does not own —
    許冠傑's 父母恩 and Hillsong's "Man of Sorrows". Every other source
    in this catalogue publishes its OWN songs, which is what the app's
    "used with permission" line rests on; that permission does not
    reach a third party's lyrics. `lyrics` is in `_REFRESH_FIELDS`, so
    a fresh non-empty value would overwrite a stored null — not
    scraping them is therefore the only way the omission survives a
    sync, and this comment is why it must not be "fixed" later.

    Artwork is likewise left null. YouTube publishes a thumbnail for
    both, but hot-linking i.ytimg.com is the failure mode
    `song_source_icons.dart` exists to avoid; the bundled Setapak mark
    fills the slot instead, exactly as it does for the Cahaya rows.
    """
    cats = _setapak_category_ids(
        SETAPAK_SONG_CATEGORIES + SETAPAK_EXCLUDE_CATEGORIES)
    wanted = [cats[s] for s in SETAPAK_SONG_CATEGORIES if s in cats]
    if not wanted:
        print('  setapak: no song categories resolved — skipping',
              file=sys.stderr)
        return []
    excluded = {cats[s] for s in SETAPAK_EXCLUDE_CATEGORIES if s in cats}

    posts = http_json(
        f'{SETAPAK_ROOT}/wp-json/wp/v2/posts'
        f'?categories={",".join(str(c) for c in wanted)}'
        '&per_page=100&_fields=id,slug,link,title,content,categories') or []

    entries = []
    seen = set()
    for p in posts:
        if p['id'] in seen:
            continue
        if excluded & set(p.get('categories') or []):
            continue

        content = (p.get('content') or {}).get('rendered') or ''
        yt = SETAPAK_YT_RE.search(content)
        if not yt:
            # A song post with no video is nothing this app can offer:
            # there is no audio file anywhere on this site.
            continue

        title = clean_title((p.get('title') or {}).get('rendered'))
        if not title:
            continue
        seen.add(p['id'])

        # Post id, not slug, as the stable half of the row id. The
        # slug is editable — this site's own is `man-of-sorrrow`, a
        # typo someone may well correct one day, and that would orphan
        # every playlist and favourite pointing at the old id.
        credits = _setapak_credits(strip_lyrics(content) or '')
        entries.append(make_entry(
            'setapak', str(p['id']), title, p.get('link'),
            language=detect_language(title, default='en'),
            youtubeId=yt.group(1),
            themes=infer_themes(title),
            verse=infer_verse(title),
            **credits,
        ))

    print(f'  setapak: {len(entries)} songs')
    return entries


# ── yahwehdehua.net ───────────────────────────────────────────────

def _ydh_song_cards(page_html):
    """The `.video-card` blocks inside a page's "Songs / 诗歌" tab.

    Returns [] — never a partial guess — when the tab is not found.
    The alternative would be to sweep the whole page, and on the Easter
    page that means 22 teaching videos filed as songs.

    The intersection guard is the second half of the same idea: every
    YouTube id in the slice must be absent from everything before it.
    A redesign that merges the two tabs, or drops the pane while
    keeping the id somewhere else, then produces zero songs and a
    warning instead of 27.
    """
    marker = page_html.find(YDH_TAB_MARKER)
    if marker < 0:
        print(f'  warn: no {YDH_TAB_MARKER} pane — not parsing songs',
              file=sys.stderr)
        return []
    end = page_html.find('</main>', marker)
    tab = page_html[marker:end if end > 0 else len(page_html)]

    before = set(YDH_EMBED_RE.findall(page_html[:marker]))
    inside = set(YDH_EMBED_RE.findall(tab))
    if before & inside:
        print('  warn: the songs tab repeats videos from above it '
              f'({sorted(before & inside)}) — refusing to parse',
              file=sys.stderr)
        return []

    return [c for c in tab.split(YDH_CARD_MARKER)[1:]
            if YDH_EMBED_RE.search(c)]


def _ydh_lyrics(fragment):
    """Lyrics from a card's `<p>` blocks: one line per printed line.

    NOT the shared [strip_lyrics]. That one is built for fydt, where
    the source newline IS the line break; here every printed line ends
    in `<br/>` and the file's own newlines are only indentation, so
    feeding it this markup doubles every break and makes a stanza gap
    indistinguishable from an ordinary line ending. The source's
    wrapping is therefore unwound FIRST, and `<br/>` alone decides
    where a line ends — which also means a stanza's blank line
    survives as a blank line, and `[Chorus]` keeps its own row.
    """
    out = []
    for p in YDH_P_RE.findall(fragment):
        t = re.sub(r'\s*\r?\n\s*', ' ', p)
        t = re.sub(r'(?i)<br\s*/?>', '\n', t)
        t = re.sub(r'<[^>]+>', '', t)
        t = html.unescape(t)
        # The NBSP is written as an escape rather than as the
        # character: the page indents with `&nbsp;`, `html.unescape`
        # turns those into U+00A0, and `.strip()` does not remove
        # one — while a literal NBSP sitting invisibly in this file
        # would be worse than the bug it fixes.
        lines = [re.sub('[ \t\u00a0]+', ' ', ln).strip()
                 for ln in t.split('\n')]
        block = re.sub(r'\n{3,}', '\n\n', '\n'.join(lines)).strip()
        if block:
            out.append(block)
    # The English block and, where the card prints one, the Chinese
    # translation — joined by a blank line, in the order the page shows
    # them. See [fetch_ydh] on why they share one field.
    return '\n\n'.join(out) or None


def _ydh_verse(scripture_html):
    """'Luke 9:22-23' from a card's scripture block, or None.

    Only the ENGLISH paragraph is read. The Chinese one repeats the
    citation in Chinese book names (徒 5:30-31), and this page family
    has already been caught printing a wrong verse in a Chinese block
    while the English block had it right (see
    `tools/add_cross_series_refs.py`, episode 9).
    """
    m = YDH_CITATION_RE.search(scripture_html)
    if not m:
        return None
    key = re.sub(r'[\s.]', '', m.group(1)).lower()
    book = YDH_BOOKS.get(key)
    if not book:
        print(f'  warn: ydh cites "{m.group(1)}", which YDH_BOOKS does not '
              'know — leaving the verse empty rather than guessing',
              file=sys.stderr)
        return None
    verses = re.sub(r'\s*[-–]\s*', '-', m.group(3))
    return f'{book} {m.group(2)}:{verses}'


def fetch_ydh():
    """The five Good Friday / Easter songs on yahwehdehua.net.

    Added 2026-09-03 at the user's direction — the queue asked whether
    songs published beside a video series belong in the Songs section
    and the answer was yes. The page itself agrees: it files them under
    its own "Songs / 诗歌" tab, separately from the ten teachings.

    **Lyrics ARE carried here, and that is not a reversal of
    [fetch_setapak].** The rule both obey is the same one: carry the
    words when the publisher owns them. Setapak's two posts are covers
    of 許冠傑 and Hillsong, whom nobody in this catalogue can license.
    These five are the church's own compositions — the page's footer
    reads "Standing on the Cross Series © 2026 Rosablanca Suen. All
    writing, scripts, images, songs, and media are the intellectual
    property of the content creator" — published in full, by the
    ministry whose Bible text this app already ships with permission.

    **They are not all bilingual, whatever the queue entry says.** Only
    song 1 prints a Chinese translation; songs 2-5 are English only.
    That was read off the page, so nothing here fabricates a second
    language: the lyrics field carries exactly the blocks the card
    prints, in the order it prints them.

    Empty on purpose: no audio file, no score, no catalogue code, no
    album and no duration — this is a series page, not a songbook, and
    the song IS the YouTube video. `artworkUrl` stays null for the same
    reason [fetch_setapak] gives; the bundled ydh mark fills the slot.

    The row id is `ydh:<youtube id>`. There is no post id to use — the
    page is static HTML with no CMS behind it — and the video id is the
    only identifier on it that cannot be edited. Position on the page
    and the title both can.
    """
    entries = []
    seen = set()
    for page in YDH_SONG_PAGES:
        page_html = http_get(page)
        if not page_html:
            continue

        credit = YDH_COPYRIGHT_RE.search(page_html)
        composer = credit.group(1).strip() if credit else None

        for card in _ydh_song_cards(page_html):
            yt = YDH_EMBED_RE.search(card)
            if not yt or yt.group(1) in seen:
                continue
            video_id = yt.group(1)

            body = card.split('<div class="card-body">', 1)
            if len(body) < 2:
                continue
            body = body[1]

            heading = YDH_TITLE_RE.search(body)
            if not heading:
                continue
            # The card prints the English title first and, where it has
            # one, the Chinese title on a second line. Both are kept —
            # a reader searching in either language has to find the row
            # — and the FIRST line is what decides `language`, so a
            # translated title does not refile an English song as
            # Chinese.
            lines = [clean_title(x) for x in
                     YDH_BR_SPLIT_RE.split(heading.group(1))]
            lines = [x for x in lines if x]
            if not lines:
                continue
            title = ' / '.join(lines)

            # Lyrics are every <p> above the scripture box; the box's
            # own paragraphs are a citation, not part of the song.
            split_at = body.find(YDH_SCRIPTURE_MARKER)
            lyric_html = body[:split_at] if split_at > 0 else body
            lyric_html = YDH_TITLE_RE.sub('', lyric_html, count=1)
            lyrics = _ydh_lyrics(lyric_html)

            verse = _ydh_verse(body[split_at:]) if split_at > 0 else None

            seen.add(video_id)
            entries.append(make_entry(
                'ydh', video_id, title, page,
                language=detect_language(lines[0], default='en'),
                youtubeId=video_id,
                composer=composer,
                lyrics=lyrics,
                themes=infer_themes(title),
                verse=verse,
            ))

    print(f'  ydh: {len(entries)} songs')
    return entries


# ── Merge ─────────────────────────────────────────────────────────

# Fields refreshed from upstream, keeping the stored value when the
# fresh one is empty. Descriptive metadata only.
_REFRESH_FIELDS = (
    'url', 'sourceLabel', 'language', 'code', 'album', 'artist',
    'composer', 'lyricist', 'durationSec', 'artworkUrl', 'lyrics',
)

# Media links, where the fresh value is AUTHORITATIVE — including when
# it is empty. Each song's own page is the only source of truth for
# what it currently offers, so a re-fetch that finds no mp3 clears the
# stored one rather than keeping a link the church may have removed.
#
# That makes a partial-content response (the page answers 200 but the
# fetch/parse misses media that IS there) indistinguishable, at this
# single field, from a real removal. Nothing here defends against
# that — the defence is the per-row regression guard in main(), which
# looks at the whole run and refuses to write if any row loses its
# only audio/video/score with no replacement. Do not resurrect a
# per-field "retries so a blip can't clear a good URL" comment here:
# this spot used to carry exactly that claim, about a HEAD-recheck
# (`prune_derived_urls`) that had quietly stopped being called from
# anywhere, and the false comment was the only thing still asserting
# the protection existed (found + fixed 2026-08-30).
_MEDIA_FIELDS = (
    'audioUrl', 'instrumentalUrl', 'accompanimentUrl', 'audioTracks',
    'videoUrl', 'youtubeId', 'soundcloudTrackId', 'scoreUrl',
)


def has_media(row):
    """True if a row offers ANY way to hear, watch, or read it.

    Mirrors `pull_songs_snapshot.py`'s `has_media` in the yswords repo
    (the downstream guard this one is meant to make unnecessary) —
    keep the two in sync if either grows a field.
    """
    return bool(
        row.get('audioUrl') or row.get('audioTracks')
        or row.get('soundcloudTrackId') or row.get('videoUrl')
        or row.get('youtubeId') or row.get('scoreUrl'))


def merge(existing, new):
    """Fold a freshly-fetched entry over the stored one.

    `firstSeenAt` never moves and `updatedAt` only bumps when
    something actually changed — otherwise the weekly cron would
    restamp all 500 rows every run and destroy the "Recently updated"
    sort. Hand-curated `verse` and `themes` are never overwritten,
    only backfilled.
    """
    if not existing:
        out = dict(new)
        out['firstSeenAt'] = _now_iso()
        out['updatedAt'] = out['firstSeenAt']
        return normalise(out)

    merged = dict(existing)
    merged.setdefault('firstSeenAt', _now_iso())
    changed = False

    new_title = new.get('title')
    if new_title and _is_bad_title(merged.get('title')) \
            and new_title != merged.get('title'):
        merged['title'] = new_title
        changed = True

    for k in _REFRESH_FIELDS:
        v = new.get(k)
        if v not in (None, '') and merged.get(k) != v:
            merged[k] = v
            changed = True

    for k in _MEDIA_FIELDS:
        v = new.get(k) or None
        if merged.get(k) != v:
            merged[k] = v
            changed = True

    # Backfill only — a hand-edited value wins over the classifier.
    if not merged.get('themes') and new.get('themes'):
        merged['themes'] = new['themes']
        changed = True
    if not merged.get('verse') and new.get('verse'):
        merged['verse'] = new['verse']
        changed = True

    # Any field the older schema never had.
    for k, v in new.items():
        if k not in merged:
            merged[k] = v
            changed = True

    merged['updatedAt'] = _now_iso() if changed \
        else merged.get('updatedAt', merged['firstSeenAt'])
    return normalise(merged)


def verify_links(songs, workers=2, delay=0.25, timeout=10,
                 abort_after_timeouts=25):
    """HEAD every media URL in the catalogue and report the dead ones.

    This exists because the Songs feature was pulled in v1.3.126 with
    "the song links were reported broken" — nobody noticed the fydt
    backend migration had rotted the whole catalogue until users did.
    Run it after a sync (or from the weekly cron) so rot surfaces as a
    diff instead of a bug report.

    DELIBERATELY SLOW. There are ~1400 URLs across four small church
    servers, and checking them hard gets the checker firewalled: on
    2026-08-09 this machine was blocked by fydt.org and then by
    christiandiscipleschurch.org after exactly that. A blocked run
    reports hundreds of "dead" links that are nothing of the kind, and
    if it happened to the GitHub Actions runner the weekly sync would
    break outright. Two workers with a short delay puts the whole pass
    at roughly three minutes — irrelevant for a weekly job, and gentle
    enough to stay welcome.
    """
    import concurrent.futures

    targets = []
    seen = set()
    for s in songs:
        for field in ('audioUrl', 'instrumentalUrl', 'accompanimentUrl',
                      'videoUrl', 'scoreUrl'):
            if s.get(field):
                targets.append((s['id'], s['title'], field, s[field]))
                seen.add(s[field])
        # The scalar fields above are drawn FROM audioTracks, but the
        # extra language variants live only here — check those too, or
        # a dead Chinese take would ride along unnoticed behind a
        # healthy English one.
        for t in s.get('audioTracks') or []:
            if t.get('url') and t['url'] not in seen:
                targets.append(
                    (s['id'], s['title'],
                     f"track:{t.get('kind')}/{t.get('lang') or '-'}",
                     t['url']))
                seen.add(t['url'])

    def check(t):
        _id, title, field, url = t
        # Space the requests out — see the note above on being
        # firewalled for checking too hard.
        if delay > 0:
            time.sleep(delay)
        req = urllib.request.Request(
            url, method='HEAD', headers={'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return t, r.status, None
        except urllib.error.HTTPError as e:
            return t, e.code, None
        except Exception as e:
            return t, None, str(e)[:60]

    print(f'\nVerifying {len(targets)} media URLs '
          f'({workers} workers)…')
    dead = []
    checked = 0
    consecutive_timeouts = 0
    aborted = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for i, (t, status, err) in enumerate(pool.map(check, targets), 1):
            checked = i
            if status != 200:
                dead.append((t, status, err))
            # A run of timeouts means we are being throttled, not that
            # the church deleted its music. Grinding through the rest
            # costs hours (a blocked run once took 2h12m at 25s a
            # request) and every result after this point is noise.
            if status is None:
                consecutive_timeouts += 1
                if consecutive_timeouts >= abort_after_timeouts:
                    aborted = True
                    break
            else:
                consecutive_timeouts = 0
            if i % 100 == 0:
                print(f'  …{i}/{len(targets)} checked, {len(dead)} dead')

    if aborted:
        print(f'  ! aborted after {consecutive_timeouts} consecutive '
              f'timeouts at {checked}/{len(targets)} — the server is '
              f'refusing us, not missing files. Not treated as a '
              f'failure.', file=sys.stderr)
        return 0

    if not dead:
        print(f'  ✓ all {len(targets)} media URLs return 200')
        return 0

    # Distinguish "the file is gone" from "we could not reach the
    # server". Only the first is the catalogue's problem; a wall of
    # timeouts means we are being throttled and the run is worthless.
    timeouts = [d for d in dead if d[1] is None]
    http_errors = [d for d in dead if d[1] is not None]
    if timeouts:
        print(f'  ! {len(timeouts)} network timeout(s) — could not reach '
              f'the server. NOT counted as dead links: a timeout means '
              f'we were refused, not that the file is gone.',
              file=sys.stderr)
    if not http_errors:
        return 0
    print(f'  ✗ {len(http_errors)} URL(s) returned an HTTP error:')
    dead = http_errors
    for (_id, title, field, url), status, err in dead[:40]:
        print(f'    {status or err}  {_id}  {field}  {title[:30]}')
        print(f'      {url}')
    if len(dead) > 40:
        print(f'    … and {len(dead) - 40} more')
    return len(dead)


def load_existing():
    if not os.path.exists(SONGS_JSON):
        return {}
    try:
        with open(SONGS_JSON, encoding='utf-8') as f:
            doc = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f'  warn: could not read {SONGS_JSON}: {e}', file=sys.stderr)
        return {}
    return {s['id']: s for s in doc.get('songs', []) if s.get('id')}


def main():
    global SONGS_JSON

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--dry-run', action='store_true',
                    help='report what would change, write nothing')
    ap.add_argument('--verify', action='store_true',
                    help='HEAD every media URL afterwards and report '
                         'dead links (exits non-zero if any are dead)')
    ap.add_argument('--verify-only', action='store_true',
                    help='skip the sync; just verify the stored catalogue')
    ap.add_argument('--allow-regression', action='store_true',
                    help='write even if a row lost its only audio/video/'
                         'score or vanished outright (see the per-row '
                         'regression guard below)')
    ap.add_argument('--out', metavar='PATH',
                    help='where to write the catalogue (default: '
                         f'{_default_out()})')
    args = ap.parse_args()

    if args.out:
        SONGS_JSON = os.path.abspath(args.out)

    if args.verify_only:
        stored = load_existing()
        if not stored:
            print('No catalogue to verify.', file=sys.stderr)
            return 1
        return 1 if verify_links(list(stored.values())) else 0

    print('Syncing church song catalogues…')
    existing = load_existing()
    print(f'  existing catalogue: {len(existing)} songs')

    taxonomy = fetch_fydt_taxonomy()
    wp_index = fetch_fydt_wp_index()
    try:
        fresh = (fetch_fydt(taxonomy, wp_index)
                 + fetch_cahaya()
                 + fetch_cdc()
                 + fetch_cdc_hymns(existing)
                 + fetch_cgdc()
                 + fetch_setapak()
                 + fetch_ydh())
    except RuntimeError as e:
        print(f'ERROR: {e} — refusing to write.', file=sys.stderr)
        return 1

    if not fresh:
        print('ERROR: every source returned nothing — refusing to write an '
              'empty catalogue.', file=sys.stderr)
        return 1

    # Per-source regression guard.
    #
    # The "is `fresh` empty?" check above only catches TOTAL failure. It
    # does not catch the far more likely case: one site is down, rate-
    # limiting us, or has changed its markup, while the others answer
    # fine. That run looks successful and quietly deletes every song
    # from the failed source — which is exactly what happened on
    # 2026-08-09, when fydt.org stopped responding mid-sync and a run
    # produced 393 songs with all 213 fydt entries marked "no longer
    # upstream".
    #
    # A church does not delete 90% of its songbook overnight. Treat a
    # collapse like that as a failed fetch, not as real news, and exit
    # non-zero so the weekly workflow fails loudly with the previous
    # catalogue still in place.
    if existing:
        before = {}
        for s in existing.values():
            before[s['source']] = before.get(s['source'], 0) + 1
        after = {}
        for e in fresh:
            after[e['source']] = after.get(e['source'], 0) + 1

        collapsed = []
        for source, was in before.items():
            now = after.get(source, 0)
            if was >= 10 and now < was * 0.5:
                collapsed.append(f'{source}: {was} → {now}')
        if collapsed:
            print('ERROR: a source collapsed — almost certainly a failed '
                  'fetch, not an upstream deletion. Refusing to write.\n'
                  '       ' + '; '.join(collapsed) +
                  '\n       Re-run; if the loss is real, delete the '
                  'stored catalogue to accept it.', file=sys.stderr)
            return 1

        # The count guard is not enough on its own.
        #
        # 2026-08-10: a run kept all 283 CDC songs and quietly dropped
        # the AUDIO from 36 of them — christiandiscipleschurch.org was
        # refusing the runner ("aborted after 25 consecutive timeouts"),
        # so those song pages came back without their media and were
        # recorded as having none. The song count never moved, so this
        # guard saw nothing, and the app shipped 36 hymns with a dead
        # play button. Checked afterwards: every one of those pages
        # still lists its mp3.
        #
        # Media coverage is the thing a listener actually notices, so
        # it gets its own guard.
        def with_audio(rows):
            out = {}
            for r in rows:
                if r.get('audioUrl') or r.get('audioTracks'):
                    out[r['source']] = out.get(r['source'], 0) + 1
            return out

        a_before = with_audio(existing.values())
        a_after = with_audio(fresh)
        thinned = []
        for source, was in a_before.items():
            now = a_after.get(source, 0)
            if was >= 20 and now < was * 0.9:
                thinned.append(f'{source}: {was} → {now} with audio')
        if thinned:
            print('ERROR: a source lost a tenth of its AUDIO while keeping '
                  'its songs — that is what a refused fetch looks like, not '
                  'an upstream deletion. Refusing to write.\n'
                  '       ' + '; '.join(thinned) +
                  '\n       Re-run when the server is answering; if the '
                  'loss is real, delete the stored catalogue to accept it.',
                  file=sys.stderr)
            return 1

    merged = {}
    for entry in fresh:
        merged[entry['id']] = merge(existing.get(entry['id']), entry)

    dropped = sorted(set(existing) - set(merged))
    added = sorted(set(merged) - set(existing))

    # Per-row regression guard.
    #
    # The two guards above catch a whole SOURCE collapsing or thinning.
    # They can both miss a narrower loss: individual rows silently
    # losing their only way to be heard, or vanishing outright, while
    # the aggregate stays inside tolerance. That is exactly what
    # happened on 2026-08-29 — CDC served fast 200s for 15 hymn pages
    # with no mp3 in any of them (now caught directly in
    # `fetch_cdc_hymns`), and separately cdc's blended audio coverage
    # (hymns + the D/E catalogue share the 'cdc' source) went 286 with
    # audio → 264, a 7.69% drop that missed the 10%-thinning threshold
    # above by 6.6 rows. Named ids, not just a ratio, so the failure is
    # legible without re-deriving it —
    # mirrors `pull_songs_snapshot.py`'s `check_regression` downstream
    # in the yswords repo, which enforces the same contract on the
    # published snapshot as a second line of defence.
    if existing and not args.allow_regression:
        lost_media = sorted(
            sid for sid, row in existing.items()
            if sid in merged and has_media(row) and not has_media(merged[sid]))
        problems = []
        if lost_media:
            problems.append(
                f'{len(lost_media)} row(s) lost their only audio/video/'
                f'score and gained no replacement: ' + ', '.join(lost_media))
        if dropped:
            problems.append(
                f'{len(dropped)} row(s) present before this run vanished '
                f'entirely: ' + ', '.join(dropped))
        if problems:
            print('ERROR: per-row regression — refusing to write.\n  '
                  + '\n  '.join(problems) +
                  '\n  Re-run when the source is answering fully; if the '
                  'loss is real, pass --allow-regression.', file=sys.stderr)
            return 1

    songs = sorted(merged.values(),
                   key=lambda s: (s['source'], s['title']))

    by_source = {}
    by_language = {}
    for s in songs:
        by_source[s['source']] = by_source.get(s['source'], 0) + 1
        by_language[s['language']] = by_language.get(s['language'], 0) + 1

    with_audio = sum(1 for s in songs
                     if s.get('audioUrl') or s.get('soundcloudTrackId'))
    with_video = sum(1 for s in songs
                     if s.get('videoUrl') or s.get('youtubeId'))
    with_score = sum(1 for s in songs if s.get('scoreUrl'))
    with_lyrics = sum(1 for s in songs if s.get('lyrics'))

    doc = {
        '_meta': {
            'generatedAt': _now_iso(),
            'generator': 'scripts/sync_songs.py v2',
            'count': len(songs),
            'bySource': by_source,
            'byLanguage': by_language,
            'withAudio': with_audio,
            'withVideo': with_video,
            'withScore': with_score,
            'withLyrics': with_lyrics,
            'sources': {
                k: {'label': v['label'], 'home': v['home']}
                for k, v in SOURCES.items()
            },
            'notes': {'fuyindiantai.org': _FUYINDIANTAI_NOTE},
        },
        'songs': songs,
    }

    print(f'\n  total     {len(songs)}')
    print(f'  by source {by_source}')
    print(f'  by lang   {by_language}')
    print(f'  audio {with_audio} · video {with_video} · '
          f'score {with_score} · lyrics {with_lyrics}')
    if added:
        print(f'  + {len(added)} new')
    if dropped:
        print(f'  - {len(dropped)} no longer upstream: {dropped[:8]}')

    if args.dry_run:
        print('\n(dry run — nothing written)')
        return verify_links(songs) and 1 or 0 if args.verify else 0

    os.makedirs(os.path.dirname(SONGS_JSON), exist_ok=True)
    with open(SONGS_JSON, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=1)
        f.write('\n')
    size = os.path.getsize(SONGS_JSON)
    print(f'\n✓ wrote {SONGS_JSON} ({size:,} bytes)')

    if args.verify:
        return 1 if verify_links(songs) else 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
