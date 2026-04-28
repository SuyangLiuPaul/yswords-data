#!/usr/bin/env node
//
// Validate every dataset in `data/` against its JSON Schema in `schemas/`.
// Exits non-zero on any failure so CI blocks bad data from reaching users.
//
// Run with: `npm run validate`
//

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const dataDir = join(repoRoot, 'data');
const schemaDir = join(repoRoot, 'schemas');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const datasets = [
	{ data: 'bible_evidence.json', schema: 'bible_evidence.schema.json' },
	{ data: 'daily_news.json', schema: 'daily_news.schema.json' },
	{ data: 'daily_verses.json', schema: 'daily_verses.schema.json' },
];

let failed = 0;
for (const { data, schema } of datasets) {
	process.stdout.write(`validating ${data}… `);
	let payload;
	let schemaJson;
	try {
		payload = JSON.parse(readFileSync(join(dataDir, data), 'utf8'));
		schemaJson = JSON.parse(readFileSync(join(schemaDir, schema), 'utf8'));
	} catch (err) {
		console.log(`PARSE ERROR: ${err.message}`);
		failed++;
		continue;
	}
	const validate = ajv.compile(schemaJson);
	if (validate(payload)) {
		console.log('ok');
	} else {
		console.log('FAILED');
		const errs = validate.errors || [];
		for (const e of errs.slice(0, 10)) {
			console.log(`  ${e.instancePath || '/'} ${e.message}`);
		}
		if (errs.length > 10) console.log(`  …and ${errs.length - 10} more`);
		failed++;
	}
}

// Sanity: every file in data/ has a corresponding schema (and vice-versa).
const dataFiles = new Set(readdirSync(dataDir).filter((f) => f.endsWith('.json')));
for (const { data } of datasets) dataFiles.delete(data);
dataFiles.delete('_manifest.json'); // generated, not validated
if (dataFiles.size > 0) {
	console.log(`WARN: untracked data files (no schema/validate entry): ${[...dataFiles].join(', ')}`);
}

process.exit(failed === 0 ? 0 : 1);
