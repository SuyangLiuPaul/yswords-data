import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'node:fs/promises';
import path from 'node:path';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(await fs.readFile('schemas/daily_news.schema.json', 'utf8'));
const validate = ajv.compile(schema);

const dir = 'data/archive';
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json');
let failCount = 0;
for (const f of files) {
  const data = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
  const valid = validate(data);
  if (!valid) {
    failCount++;
    console.log(`FAIL ${f}:`, JSON.stringify(validate.errors).slice(0, 300));
  }
}
console.log(`\nChecked ${files.length} archive files, ${failCount} failures.`);
