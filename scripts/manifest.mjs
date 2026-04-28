#!/usr/bin/env node
//
// Regenerate `data/_manifest.json` — a small index that consumers fetch
// first so they can decide whether their cached copy of each dataset
// is still current. Stops every consumer from refetching every dataset
// on every launch.
//
// Schema:
//   {
//     "version": "<ISO timestamp>",
//     "datasets": {
//       "bible_evidence": {
//         "url": "/data/bible_evidence.json",
//         "sha256": "<hex>",
//         "bytes": <n>,
//         "updatedAt": "<ISO>"
//       },
//       ...
//     }
//   }
//

import { readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
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
	const stat = statSync(join(dataDir, f));
	const key = f.replace(/\.json$/, '');
	datasets[key] = {
		url: `/data/${f}`,
		sha256,
		bytes: stat.size,
		updatedAt: new Date(stat.mtime).toISOString(),
	};
}

const manifest = {
	version: new Date().toISOString(),
	datasets,
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifestPath}`);
console.log(JSON.stringify(manifest, null, 2));
