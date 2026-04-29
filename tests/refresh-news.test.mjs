// Unit tests for the news refresh pipeline. Smoke-level; the full
// pipeline is exercised by the cron deploy-time validation.
//
// Run: `npm test`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	loadVerseCorpus,
	formatCorpusForPrompt,
	formatVerseFromCorpus,
	reuseDeepMatchFromCache,
	KEYWORD_THEME_FALLBACK_VERSE_ID,
} from '../scripts/refresh-news.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

test('daily_news.json parses and has world/china/australia sections', () => {
	const raw = readFileSync(join(repoRoot, 'data', 'daily_news.json'), 'utf8');
	const data = JSON.parse(raw);
	assert.ok(data.sections);
	for (const id of ['world', 'china', 'australia']) {
		assert.ok(data.sections[id], `missing ${id} section`);
		assert.ok(Array.isArray(data.sections[id].items));
	}
});

test('bible_evidence.json entries have valid categories', () => {
	const raw = readFileSync(join(repoRoot, 'data', 'bible_evidence.json'), 'utf8');
	const data = JSON.parse(raw);
	assert.ok(Array.isArray(data.evidences));
	assert.ok(data.evidences.length > 0);
	const cats = new Set(['Archaeology', 'History', 'Manuscripts', 'Science']);
	for (const e of data.evidences) {
		assert.ok(cats.has(e.category), `bad category: ${e.category} on ${e.id}`);
	}
});

test('daily_verses.json has at least 365 entries', () => {
	const raw = readFileSync(join(repoRoot, 'data', 'daily_verses.json'), 'utf8');
	const data = JSON.parse(raw);
	assert.ok(Array.isArray(data.verses));
	assert.ok(data.verses.length >= 365);
});

// ---------------------------------------------------------------------------
// Verse-corpus + deep-match pipeline tests
// ---------------------------------------------------------------------------

test('news_verse_corpus.json loads with required fields per verse', async () => {
	const corpus = await loadVerseCorpus();
	assert.ok(Array.isArray(corpus));
	assert.ok(corpus.length >= 50, `corpus too small: ${corpus.length}`);
	for (const v of corpus) {
		assert.ok(v.id, `verse missing id: ${JSON.stringify(v).slice(0, 100)}`);
		assert.ok(v.reference, `verse ${v.id} missing reference`);
		assert.ok(v.textEn, `verse ${v.id} missing textEn`);
		assert.ok(v['textZh-Hans'] || v.textZh, `verse ${v.id} missing zh text`);
		assert.ok(v.themeEn, `verse ${v.id} missing themeEn`);
		assert.ok(Array.isArray(v.tags), `verse ${v.id} tags not array`);
		assert.ok(v.applies, `verse ${v.id} missing applies`);
	}
});

test('verse corpus ids are unique', async () => {
	const corpus = await loadVerseCorpus();
	const ids = corpus.map((v) => v.id);
	const unique = new Set(ids);
	assert.equal(unique.size, ids.length, 'duplicate verse ids in corpus');
});

test('every keyword-theme fallback id resolves to a corpus verse', async () => {
	const corpus = await loadVerseCorpus();
	const ids = new Set(corpus.map((v) => v.id));
	for (const [theme, verseId] of Object.entries(KEYWORD_THEME_FALLBACK_VERSE_ID)) {
		assert.ok(ids.has(verseId), `fallback for theme "${theme}" -> "${verseId}" not in corpus`);
	}
});

test('formatCorpusForPrompt produces one line per verse with id+reference', async () => {
	const corpus = await loadVerseCorpus();
	const formatted = formatCorpusForPrompt(corpus.slice(0, 3));
	const lines = formatted.split('\n');
	assert.equal(lines.length, 3);
	assert.ok(lines[0].startsWith(corpus[0].id));
	assert.ok(lines[0].includes(corpus[0].reference));
	assert.ok(lines[0].includes('applies:'));
});

test('formatVerseFromCorpus applies divine-name preference', () => {
	const verse = formatVerseFromCorpus({
		id: 'test_1',
		reference: 'Test 1:1',
		textEn: 'the LORD is good',
		'textZh-Hans': '耶和华是好的',
		themeEn: 'Test',
		themeZh: '测试',
	});
	assert.equal(verse.textEn, 'Yahweh is good');
	assert.equal(verse.textZh, '雅伟是好的');
	assert.equal(verse.reference, 'Test 1:1');
});

test('formatVerseFromCorpus prefers Hans over textZh fallback', () => {
	const verse = formatVerseFromCorpus({
		id: 'test_2',
		reference: 'Test 2:2',
		textEn: 'a',
		textZh: 'should-not-use',
		'textZh-Hans': 'should-use',
		themeEn: 'T',
		themeZh: '测',
	});
	assert.equal(verse.textZh, 'should-use');
});

test('reuseDeepMatchFromCache returns null when cached item is missing fields', () => {
	const result = reuseDeepMatchFromCache({ id: 'a', link: 'l' }, null, []);
	assert.equal(result, null);

	const noVerse = reuseDeepMatchFromCache(
		{ id: 'a', link: 'l' },
		{ translationState: 'localized' },
		[],
	);
	assert.equal(noVerse, null);

	const fallbackState = reuseDeepMatchFromCache(
		{ id: 'a', link: 'l' },
		{ translationState: 'fallback', verse: { reference: 'X 1:1' } },
		[],
	);
	assert.equal(fallbackState, null);
});

test('reuseDeepMatchFromCache returns null when link changed', () => {
	const result = reuseDeepMatchFromCache(
		{ id: 'a', link: 'new-link' },
		{
			translationState: 'localized',
			link: 'old-link',
			verse: { reference: 'X 1:1', textEn: 'a', textZh: 'a' },
			reflection: { en: 'a', zh: 'b' },
		},
		[],
	);
	assert.equal(result, null);
});

test('reuseDeepMatchFromCache hydrates verse from corpus when aiVerseId matches', () => {
	const corpus = [
		{
			id: 'matt_5_9',
			reference: 'Matthew 5:9',
			textEn: 'Blessed are the peacemakers.',
			'textZh-Hans': '使人和睦的人有福了。',
			themeEn: 'Peacemaking',
			themeZh: '和睦',
		},
	];
	const result = reuseDeepMatchFromCache(
		{ id: 'a', link: 'l' },
		{
			id: 'a',
			link: 'l',
			translationState: 'localized',
			aiVerseId: 'matt_5_9',
			verse: { reference: 'Matthew 5:9', textEn: 'old', textZh: 'old' },
			reflection: { en: 'old reflection', zh: 'old 反思' },
			summary: { en: 'sum en', zh: 'sum zh' },
			title: { en: 't', zh: 't zh' },
		},
		corpus,
	);
	assert.ok(result);
	// Verse text comes from CORPUS, not stale cached version.
	assert.equal(result.verse.textEn, 'Blessed are the peacemakers.');
	assert.equal(result.verse.textZh, '使人和睦的人有福了。');
	assert.equal(result.verseId, 'matt_5_9');
	assert.equal(result.reflectionEn, 'old reflection');
	assert.equal(result.fromCache, true);
});

test('reuseDeepMatchFromCache falls back to cached verse when aiVerseId not in corpus', () => {
	const result = reuseDeepMatchFromCache(
		{ id: 'a', link: 'l' },
		{
			id: 'a',
			link: 'l',
			translationState: 'localized',
			aiVerseId: 'unknown_id',
			verse: { reference: 'X 1:1', textEn: 'cached en', textZh: 'cached zh', themeEn: 'X', themeZh: 'Y' },
			reflection: { en: 're en', zh: 're zh' },
			summary: { en: 's en', zh: 's zh' },
			title: { en: 't', zh: 't zh' },
		},
		[],
	);
	assert.ok(result);
	assert.equal(result.verse.textEn, 'cached en');
	assert.equal(result.verse.reference, 'X 1:1');
	assert.equal(result.fromCache, true);
});

test('reuseDeepMatchFromCache rejects legacy cache items without aiVerseId', () => {
	// Items produced by the OLD pipeline have no aiVerseId marker. Reusing
	// them would freeze the shallow verse picks the user complained about.
	// We require the marker so legacy items force a one-time re-AI pass.
	const result = reuseDeepMatchFromCache(
		{ id: 'a', link: 'l' },
		{
			id: 'a',
			link: 'l',
			translationState: 'localized',
			// no aiVerseId — was created by pre-deep-match pipeline
			verse: { reference: 'Old 1:1', textEn: 'shallow', textZh: 'shallow zh', themeEn: 'X', themeZh: 'Y' },
			reflection: { en: 're en', zh: 're zh' },
			summary: { en: 's en', zh: 's zh' },
			title: { en: 't', zh: 't zh' },
		},
		[],
	);
	assert.equal(result, null);
});

test('reuseDeepMatchFromCache rejects when reflections are missing', () => {
	const result = reuseDeepMatchFromCache(
		{ id: 'a', link: 'l' },
		{
			id: 'a',
			link: 'l',
			translationState: 'localized',
			verse: { reference: 'X 1:1', textEn: 'a', textZh: 'a' },
			reflection: { en: 'only en' },
		},
		[],
	);
	assert.equal(result, null);
});
