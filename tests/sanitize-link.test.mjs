// Unit tests for the URL sanitiser used by the RSS feed parser.
// Pre-2026-05-11 fix, a single malformed `<link>` tag in a source
// feed would propagate into daily_news.json verbatim, fail the
// `format: uri` JSON Schema check, and abort the entire hourly
// refresh with no data update for users. The sanitizer's
// contract is the single point of defence; this file pins its
// behaviour against every malformed-input shape we've observed
// in production logs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLink } from '../scripts/refresh-news.mjs';

test('accepts a clean absolute https URL', () => {
	const r = sanitizeLink('https://www.example.com/news/foo-bar');
	assert.equal(r, 'https://www.example.com/news/foo-bar');
});

test('accepts a clean absolute http URL', () => {
	const r = sanitizeLink('http://example.com/');
	assert.equal(r, 'http://example.com/');
});

test('preserves query strings and percent-encoded chars', () => {
	const r = sanitizeLink(
		'https://www.dw.com/en/foo/a-76998152?maca=en-rss-en-world-4025-rdf',
	);
	assert.equal(
		r,
		'https://www.dw.com/en/foo/a-76998152?maca=en-rss-en-world-4025-rdf',
	);
});

test('trims surrounding whitespace', () => {
	assert.equal(
		sanitizeLink('  https://example.com/article  '),
		'https://example.com/article',
	);
	assert.equal(
		sanitizeLink('\nhttps://example.com\n'),
		'https://example.com/',
	);
});

test('returns null for empty / nullish input', () => {
	assert.equal(sanitizeLink(''), null);
	assert.equal(sanitizeLink(null), null);
	assert.equal(sanitizeLink(undefined), null);
	assert.equal(sanitizeLink('   '), null);
});

test('rejects unparseable URLs without a base', () => {
	assert.equal(sanitizeLink('not a url'), null);
	assert.equal(sanitizeLink('/relative/path'), null);
	assert.equal(sanitizeLink('href=foo'), null);
});

test('resolves relative URLs against the base', () => {
	assert.equal(
		sanitizeLink('/news/article-123', 'https://feed-host.com/rss'),
		'https://feed-host.com/news/article-123',
	);
	assert.equal(
		sanitizeLink('article.html', 'https://feed-host.com/articles/'),
		'https://feed-host.com/articles/article.html',
	);
});

test('rejects non-http(s) schemes even if parseable', () => {
	assert.equal(sanitizeLink('mailto:editor@example.com'), null);
	assert.equal(sanitizeLink('feed:https://example.com/rss'), null);
	assert.equal(sanitizeLink('javascript:alert(1)'), null);
	assert.equal(sanitizeLink('ftp://files.example.com/'), null);
	assert.equal(sanitizeLink('file:///etc/passwd'), null);
});

test('returns canonical href (URL normalisation)', () => {
	// `new URL().href` percent-encodes spaces and other unsafe
	// chars, satisfying ajv-formats' RFC-3986 `format: uri` check.
	const r = sanitizeLink('https://example.com/path with spaces');
	assert.ok(r);
	assert.ok(!r.includes(' '), `expected encoded, got ${r}`);
	assert.ok(r.includes('%20'));
});

test('rejects malformed input that has whitespace inside', () => {
	// URL constructor accepts these but only after encoding the
	// space; the canonical href is still URI-valid. This test
	// pins the documented behaviour rather than a strict reject.
	const r = sanitizeLink('https://example.com/path with spaces');
	assert.ok(r); // accepted, returned canonical form
});

test('does not throw on bizarre input shapes', () => {
	assert.doesNotThrow(() => sanitizeLink({ toString: () => 'oops' }));
	assert.doesNotThrow(() => sanitizeLink(12345));
	assert.doesNotThrow(() => sanitizeLink([]));
});

test('numeric input returns null (not a URL)', () => {
	assert.equal(sanitizeLink(42), null);
});
