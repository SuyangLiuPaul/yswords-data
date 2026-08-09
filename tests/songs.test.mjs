// Contract tests for data/songs.json and its schema.
//
// `npm run validate` proves the catalogue matches the schema. That is
// only worth something if the schema also REJECTS the shapes we care
// about — a permissive schema passes everything and catches nothing.
// So these tests do both: pin the real catalogue's invariants, and
// assert the schema actually refuses malformed entries.
//
// The failure this guards against is concrete. The consuming app's
// Songs feature was deleted once because the catalogue rotted
// silently: links went dead after fydt.org migrated its backend and
// nothing in the pipeline noticed until users reported it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const songs = JSON.parse(
	readFileSync(join(repoRoot, 'data', 'songs.json'), 'utf8'),
);
const schema = JSON.parse(
	readFileSync(join(repoRoot, 'schemas', 'songs.schema.json'), 'utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

/** A minimal entry that passes, for negative tests to mutate. */
function validEntry(overrides = {}) {
	return {
		id: 'fydt:1',
		title: 'x',
		language: 'zh',
		source: 'fydt',
		url: 'https://fydt.org/song/x/',
		themes: [],
		...overrides,
	};
}

function validDoc(entry) {
	return {
		_meta: { generatedAt: 'now', count: 1, bySource: { fydt: 1 } },
		songs: [entry],
	};
}

test('the published catalogue validates', () => {
	assert.equal(validate(songs), true, JSON.stringify(validate.errors));
});

test('_meta counts agree with the rows', () => {
	assert.equal(songs._meta.count, songs.songs.length);
	for (const [source, n] of Object.entries(songs._meta.bySource)) {
		const actual = songs.songs.filter((s) => s.source === source).length;
		assert.equal(actual, n, `bySource.${source} disagrees with the rows`);
	}
});

test('all three catalogues are present and ids are unique', () => {
	const sources = new Set(songs.songs.map((s) => s.source));
	for (const expected of ['fydt', 'cahaya', 'cdc']) {
		assert.ok(sources.has(expected), `missing source ${expected}`);
	}
	const ids = new Set(songs.songs.map((s) => s.id));
	assert.equal(ids.size, songs.songs.length, 'duplicate song ids');
});

test('every id is namespaced by its own source', () => {
	for (const s of songs.songs) {
		assert.ok(
			s.id.startsWith(`${s.source}:`),
			`${s.id} is not namespaced by ${s.source}`,
		);
	}
});

test('the catalogue actually carries media', () => {
	// Guards against a sync that "succeeds" while stripping every
	// link — which is indistinguishable from a healthy run if you
	// only check that the file parses.
	const withAudio = songs.songs.filter(
		(s) => s.audioUrl || s.soundcloudTrackId,
	).length;
	const withScore = songs.songs.filter((s) => s.scoreUrl).length;
	assert.ok(
		withAudio > songs.songs.length / 2,
		`only ${withAudio}/${songs.songs.length} songs have audio`,
	);
	assert.ok(withScore > songs.songs.length / 2);
});

test('every media URL is absolute https', () => {
	const fields = [
		'audioUrl',
		'instrumentalUrl',
		'accompanimentUrl',
		'videoUrl',
		'scoreUrl',
		'artworkUrl',
	];
	for (const s of songs.songs) {
		for (const f of fields) {
			if (!s[f]) continue;
			assert.ok(
				s[f].startsWith('https://'),
				`${s.id}.${f} is not https: ${s[f]}`,
			);
		}
	}
});

// ── the schema has to say no to something ─────────────────────────

test('schema rejects a plain-http media URL', () => {
	// The app is served over https; a mixed-content media load is
	// blocked outright by the browser, so this must never publish.
	const ok = validate(
		validDoc(validEntry({ audioUrl: 'http://fydt.org/a.mp3' })),
	);
	assert.equal(ok, false, 'http:// media URL should have been rejected');
});

test('schema rejects an unknown source', () => {
	const ok = validate(
		validDoc(validEntry({ id: 'nope:1', source: 'nope' })),
	);
	assert.equal(ok, false, 'unknown source should have been rejected');
});

test('schema rejects an unknown language', () => {
	const ok = validate(validDoc(validEntry({ language: 'fr' })));
	assert.equal(ok, false, 'unknown language should have been rejected');
});

test('schema rejects a missing id and a missing url', () => {
	const noId = validEntry();
	delete noId.id;
	assert.equal(validate(validDoc(noId)), false, 'missing id passed');

	const noUrl = validEntry();
	delete noUrl.url;
	assert.equal(validate(validDoc(noUrl)), false, 'missing url passed');
});

test('schema rejects a malformed youtube id', () => {
	// YouTube ids are exactly 11 chars; anything else means the page
	// parse grabbed the wrong substring.
	const ok = validate(validDoc(validEntry({ youtubeId: 'too-short' })));
	assert.equal(ok, false, 'malformed youtube id should have been rejected');
});

test('schema accepts nulls for every optional medium', () => {
	const ok = validate(
		validDoc(
			validEntry({
				audioUrl: null,
				instrumentalUrl: null,
				videoUrl: null,
				scoreUrl: null,
				youtubeId: null,
				soundcloudTrackId: null,
				lyrics: null,
				verse: null,
			}),
		),
	);
	assert.equal(ok, true, JSON.stringify(validate.errors));
});
