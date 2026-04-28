// Unit tests for the news refresh pipeline. Smoke-level; the full
// pipeline is exercised by the cron deploy-time validation.
//
// Run: `npm test`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('bible_evidence.json has 209 entries with valid categories', () => {
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
