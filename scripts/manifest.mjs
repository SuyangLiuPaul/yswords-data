#!/usr/bin/env node
//
// Regenerate `data/_manifest.json` — a small index that consumers
// fetch first so they can decide whether their cached copy of each
// dataset is still current. Stops every consumer from refetching
// every dataset on every launch.
//
// IMPORTANT: this output must be fully content-deterministic so the
// PR-time `validate.yml` "manifest is up to date" check is stable.
// We deliberately do NOT include wall-clock timestamps or file mtimes
// (mtimes change on every git checkout; timestamps make every run
// look "stale" even when nothing changed). The `version` field is
// derived from the concatenated sha256s of all datasets — same input
// always yields the same version.
//
// Schema:
//   {
//     "version": "<sha256 of all dataset hashes, 16 hex chars>",
//     "datasets": {
//       "bible_evidence": {
//         "url": "/data/bible_evidence.json",
//         "sha256": "<hex>",
//         "bytes": <n>
//       },
//       ...
//     }
//   }
//

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
const manifestPath = join(dataDir, '_manifest.json');

const SKIP = new Set(['_manifest.json']);
const files = readdirSync(dataDir)
	.filter((f) => f.endsWith('.json'))
	.filter((f) => !SKIP.has(f))
	.sort();

const datasets = {};
for (const f of files) {
	const buf = readFileSync(join(dataDir, f));
	const sha256 = createHash('sha256').update(buf).digest('hex');
	const key = f.replace(/\.json$/, '');
	datasets[key] = {
		url: `/data/${f}`,
		sha256,
		bytes: buf.length,
	};
}

// Deterministic version: hash of the concatenated dataset hashes.
// Identical to last run iff every dataset is byte-identical.
const versionHash = createHash('sha256')
	.update(Object.values(datasets).map((d) => d.sha256).join(''))
	.digest('hex')
	.slice(0, 16);

const manifest = {
	version: versionHash,
	datasets,
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifestPath}`);
console.log(JSON.stringify(manifest, null, 2));
