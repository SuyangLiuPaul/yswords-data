import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Parser from 'rss-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
// Output to data/daily_news.json — the canonical home in yswords-data.
// (In the legacy DailyNews repo this used to be src/data/latest-news.json.)
const outputPath = path.join(projectRoot, 'data', 'daily_news.json');
const parser = new Parser();
const minItemsPerSection = Math.max(1, Number(process.env.NEWS_MIN_ITEMS_PER_SECTION || 10));
const maxItemsPerSection = Math.max(minItemsPerSection, Number(process.env.NEWS_MAX_ITEMS_PER_SECTION || 18));

// --- AI Configuration (Gemini via OpenAI-compatible endpoint) ---
//
// Keys come from environment ONLY. Previously this file embedded four
// literal Gemini keys as fallbacks — those leaked to anyone who forked
// the public repo and had to be rotated. Set keys via GitHub Actions
// secret `OPENAI_API_KEY` (preferred — the workflow already wires it),
// or `GEMINI_API_KEYS` (comma-separated for round-robin), or
// `GEMINI_API_KEY` (single key fallback). Without any key the refresh
// still runs but skips AI translation/reflection enrichment.
const GEMINI_KEYS = (
	process.env.GEMINI_API_KEYS ||
	process.env.GEMINI_API_KEY ||
	process.env.OPENAI_API_KEY ||
	''
)
	.split(',')
	.map((k) => k.trim())
	.filter(Boolean);
let currentKeyIndex = 0;
function getNextApiKey() {
	if (GEMINI_KEYS.length === 0) return null;
	const key = GEMINI_KEYS[currentKeyIndex % GEMINI_KEYS.length];
	currentKeyIndex++;
	return key;
}
const AI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
// Default model bumped to gemini-2.5-pro because the daily-news pipeline now
// runs a single-call "deep match" that asks the model to reason from a news
// story to the best-fitting verse in a 96-entry catalog, then write a
// bilingual reflection. The thinking-capable model gives substantially better
// resonance than 2.5-flash, which previously produced shallow keyword-style
// matches the user complained about ("not related and not in deep think").
// Override via env var OPENAI_MODEL if you need to revert / experiment.
// Default to gemini-2.5-flash for the deep-match. We tried 2.5-pro
// earlier for its thinking-mode reasoning, but the free tier's
// 250 RPD quota gets exhausted within a single rough day (~30
// stories × 30 retries from 429s = 900+ requests/day in worst case).
// 2.5-flash gives us 1500 RPD and is still very capable for the
// pick-a-verse-and-write-a-reflection task. Override via env when
// you have a paid pro key.
const AI_MODEL = process.env.OPENAI_MODEL || 'gemini-2.5-flash';
// Cheaper / higher-quota model for mechanical translation passes.
// gemini-2.5-flash has 10 RPM and 1500 RPD on the free tier vs
// 2.5-pro's 5 RPM / 250 RPD, so using flash for body translation
// stops the deep-match pipeline from starving the quota pool.
const AI_TRANSLATE_MODEL =
	process.env.OPENAI_TRANSLATE_MODEL || 'gemini-2.5-flash';
// Lower temperature than before (0.3 -> 0.2): we want stable verse picks
// across runs so a story doesn't bounce between verses on every refresh,
// while leaving room for natural-sounding reflection prose.
const AI_TEMPERATURE = Number(process.env.OPENAI_TEMPERATURE || 0.2);
// Inter-call delay. gemini-2.5-flash free tier allows 10 RPM, so 7s
// between calls leaves headroom for occasional retries without
// spilling over. (gemini-2.5-pro was 5 RPM = 13s; if you flip back
// to pro, also bump this to 13000.) The original 500ms slammed
// 120 RPM and triggered HTTP 429 across the whole batch.
const AI_CALL_DELAY_MS = Number(process.env.AI_CALL_DELAY_MS || 7000);
// Path to the curated verse corpus. Authored by hand in
// `data/news_verse_corpus.json` — 96 verses across 20 topical categories.
// Loaded once per pipeline run and passed to the deep-match call.
const VERSE_CORPUS_PATH = path.join(projectRoot, 'data', 'news_verse_corpus.json');

const sectionMeta = {
	world: {
		title: { en: 'World Desk', zh: '全球焦点' },
		strap: {
			en: 'A fast view of global affairs, conflict, diplomacy, and human need.',
			zh: '快速掌握国际局势、冲突、外交与人类处境。',
		},
		categoryLabel: { en: 'World', zh: '全球' },
	},
	china: {
		title: { en: 'China Desk', zh: '中国观察' },
		strap: {
			en: 'Policy signals, social change, and national developments inside China.',
			zh: '聚焦中国内部政策走向、社会变化与国家动态。',
		},
		categoryLabel: { en: 'China', zh: '中国' },
	},
	australia: {
		title: { en: 'Australia Desk', zh: '澳洲栏目' },
		strap: {
			en: 'Public life, policy, and community stories shaping Australia now.',
			zh: '关注正在影响澳洲公共生活、政策与社区的新闻。',
		},
		categoryLabel: { en: 'Australia', zh: '澳洲' },
	},
};

const sourceCatalog = [
	{
		name: 'The Guardian World',
		url: 'https://www.theguardian.com/world/rss',
		section: 'world',
	},
	{
		name: 'BBC News World',
		url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
		section: 'world',
	},
	{
		name: 'SBS News World',
		url: 'https://www.sbs.com.au/news/topic/world/feed',
		section: 'world',
	},
	{
		name: 'DW World',
		url: 'https://rss.dw.com/rdf/rss-en-world',
		section: 'world',
	},
	{
		name: 'The Guardian China',
		url: 'https://www.theguardian.com/world/china/rss',
		section: 'china',
	},
	{
		name: 'BBC News China Focus',
		url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
		section: 'china',
		matchKeywords: ['china', 'beijing', 'hong kong', 'taiwan', 'xi jinping', 'xinjiang', 'tibet'],
	},
	{
		name: 'SBS News China Focus',
		url: 'https://www.sbs.com.au/news/topic/world/feed',
		section: 'china',
		matchKeywords: ['china', 'beijing', 'hong kong', 'taiwan', 'xi jinping', 'xinjiang', 'tibet'],
	},
	{
		name: 'DW Asia China Focus',
		url: 'https://rss.dw.com/rdf/rss-en-asia',
		section: 'china',
		matchKeywords: ['china', 'beijing', 'hong kong', 'taiwan', 'xi jinping', 'xinjiang', 'tibet'],
	},
	{
		name: 'The Guardian Australia',
		url: 'https://www.theguardian.com/australia-news/rss',
		section: 'australia',
	},
	{
		name: 'SBS News Australia',
		url: 'https://www.sbs.com.au/news/topic/australia/feed',
		section: 'australia',
	},
];

const themes = [
	{
		id: 'peace',
		keywords: ['war', 'missile', 'airstrike', 'attack', 'troops', 'military', 'conflict', 'ceasefire', 'nuclear', 'navy', 'bombing', 'invasion', 'sanctions', 'weapon', 'drone', 'soldier', 'battle', 'frontline', 'ammunition'],
		focusEn: 'peace-making and restraint',
		focusZh: '和平与克制',
		actionEn: 'mercy, truth, and restraint',
		actionZh: '怜悯、真实与节制',
		verse: {
			reference: 'Matthew 5:9',
			textEn: 'Blessed are the peacemakers, for they will be called children of God.',
			textZh: '使人和睦的人有福了，因为他们必称为神的儿子。',
			themeEn: 'Peace',
			themeZh: '和平',
		},
	},
	{
		id: 'justice',
		keywords: ['court', 'rights', 'police', 'law', 'corruption', 'investigation', 'protest', 'abuse', 'trial', 'sentenced', 'guilty', 'convicted', 'human rights', 'discrimination', 'racial', 'arrest', 'crime', 'fraud'],
		focusEn: 'justice, dignity, and accountability',
		focusZh: '公义、尊严与问责',
		actionEn: 'justice tempered by mercy',
		actionZh: '带着怜悯的公义',
		verse: {
			reference: 'Micah 6:8',
			textEn: 'What does Yahweh require of you? To act justly and to love mercy and to walk humbly with your God.',
			textZh: '雅伟向你所要的，无非是行公义，好怜悯，存谦卑的心与你的神同行。',
			themeEn: 'Justice',
			themeZh: '公义',
		},
	},
	{
		id: 'leadership',
		keywords: ['government', 'prime minister', 'president', 'minister', 'cabinet', 'policy', 'election', 'leadership', 'parliament', 'congress', 'senator', 'democracy', 'legislation', 'summit', 'diplomat'],
		focusEn: 'leadership, wisdom, and public responsibility',
		focusZh: '领导、智慧与公共责任',
		actionEn: 'wisdom, integrity, and service',
		actionZh: '智慧、正直与服事',
		verse: {
			reference: 'Proverbs 11:14',
			textEn: 'For lack of guidance a nation falls, but victory is won through many advisers.',
			textZh: '无智谋，民就败落；谋士多，人便安居。',
			themeEn: 'Leadership',
			themeZh: '领导',
		},
	},
	{
		id: 'compassion',
		keywords: ['refugee', 'migration', 'poverty', 'health', 'flood', 'earthquake', 'crisis', 'families', 'disaster', 'humanitarian', 'aid', 'hunger', 'famine', 'displacement', 'volunteer', 'charity'],
		focusEn: 'compassion for vulnerable people',
		focusZh: '对脆弱群体的怜悯',
		actionEn: 'practical compassion and welcome',
		actionZh: '具体的怜悯与接纳',
		verse: {
			reference: 'Galatians 6:2',
			textEn: "Carry each other's burdens, and in this way you will fulfill the law of Christ.",
			textZh: '你们各人的重担要互相担当，如此就完全了基督的律法。',
			themeEn: 'Compassion',
			themeZh: '怜悯',
		},
	},
	{
		id: 'stewardship',
		keywords: ['economy', 'trade', 'energy', 'market', 'budget', 'climate', 'resources', 'housing', 'inflation', 'interest rate', 'employment', 'gdp', 'investment', 'infrastructure', 'tax'],
		focusEn: 'stewardship, provision, and the common good',
		focusZh: '管家责任、供应与公共福祉',
		actionEn: 'stewardship that serves neighbours',
		actionZh: '服事邻舍的好管家心态',
		verse: {
			reference: '1 Peter 4:10',
			textEn: "Each of you should use whatever gift you have received to serve others, as faithful stewards of God's grace.",
			textZh: '各人要照所得的恩赐彼此服事，作神百般恩赐的好管家。',
			themeEn: 'Stewardship',
			themeZh: '管家',
		},
	},
	{
		id: 'truth',
		keywords: ['media', 'report', 'claims', 'analysis', 'evidence', 'data', 'disinformation', 'technology', 'misinformation', 'propaganda', 'censorship', 'surveillance', 'deepfake', 'fact-check', 'algorithm'],
		focusEn: 'truth, discernment, and honest speech',
		focusZh: '真理、分辨与诚实',
		actionEn: 'discernment and truthful speech',
		actionZh: '分辨与诚实表达',
		verse: {
			reference: 'Philippians 4:8',
			textEn: 'Whatever is true, whatever is noble, whatever is right ... think about such things.',
			textZh: '凡是真实的、可敬的、公义的......这些事你们都要思念。',
			themeEn: 'Discernment',
			themeZh: '分辨',
		},
	},
	{
		id: 'hope',
		keywords: ['recovery', 'rebuild', 'hope', 'community', 'future', 'schools', 'innovation', 'support', 'resilience', 'volunteer', 'breakthrough', 'milestone', 'celebrate', 'inspire', 'progress'],
		focusEn: 'hope, endurance, and faithful rebuilding',
		focusZh: '盼望、忍耐与重建',
		actionEn: 'steady hope and perseverance',
		actionZh: '坚定盼望与忍耐',
		verse: {
			reference: 'Romans 12:12',
			textEn: 'Be joyful in hope, patient in affliction, faithful in prayer.',
			textZh: '在指望中要喜乐，在患难中要忍耐，祷告要恒切。',
			themeEn: 'Hope',
			themeZh: '盼望',
		},
	},
	{
		id: 'faithfulness',
		keywords: ['religion', 'persecution', 'faith', 'church', 'prayer', 'worship', 'bible', 'gospel', 'pastor', 'missionary', 'martyr', 'christian', 'believer', 'congregation', 'revival'],
		focusEn: 'faithfulness under pressure and spiritual courage',
		focusZh: '在压力下的忠信与属灵勇气',
		actionEn: 'steadfast faith and prayerful witness',
		actionZh: '坚定的信心与祷告见证',
		verse: {
			reference: 'Hebrews 10:23',
			textEn: 'Let us hold unswervingly to the hope we profess, for he who promised is faithful.',
			textZh: '也要坚守我们所承认的指望，不至摇动，因为那应许我们的是信实的。',
			themeEn: 'Faithfulness',
			themeZh: '信实',
		},
	},
	{
		id: 'wisdom',
		keywords: ['education', 'university', 'student', 'teacher', 'learning', 'science', 'space', 'medical', 'vaccine', 'research', 'discovery', 'academic', 'laboratory', 'scholarship'],
		focusEn: 'wisdom, knowledge, and the pursuit of truth',
		focusZh: '智慧、知识与追求真理',
		actionEn: 'humble learning and wise application',
		actionZh: '谦卑学习与智慧运用',
		verse: {
			reference: 'Proverbs 2:6',
			textEn: 'For Yahweh gives wisdom; from his mouth come knowledge and understanding.',
			textZh: '因为雅伟赐人智慧，知识和聪明都由他口而出。',
			themeEn: 'Wisdom',
			themeZh: '智慧',
		},
	},
	{
		id: 'creation',
		keywords: ['environment', 'climate change', 'pollution', 'carbon', 'renewable', 'ocean', 'forest', 'wildlife', 'drought', 'water', 'emissions', 'species', 'ecosystem', 'biodiversity', 'deforestation'],
		focusEn: 'creation care and environmental responsibility',
		focusZh: '受造之物关怀与环保责任',
		actionEn: 'faithful stewardship of creation',
		actionZh: '对受造之物的忠心管家',
		verse: {
			reference: 'Genesis 2:15',
			textEn: 'Yahweh God took the man and put him in the Garden of Eden to work it and take care of it.',
			textZh: '雅伟神将那人安置在伊甸园，使他修理看守。',
			themeEn: 'Creation Care',
			themeZh: '受造之物',
		},
	},
	{
		id: 'unity',
		keywords: ['reconciliation', 'unity', 'dialogue', 'negotiation', 'treaty', 'cooperation', 'alliance', 'peace deal', 'agreement', 'bipartisan', 'coalition', 'partnership', 'truce', 'mediate'],
		focusEn: 'unity, reconciliation, and bridging divides',
		focusZh: '合一、和好与弥合分歧',
		actionEn: 'peacemaking and bridge-building',
		actionZh: '缔造和平与搭建桥梁',
		verse: {
			reference: 'Ephesians 4:3',
			textEn: 'Make every effort to keep the unity of the Spirit through the bond of peace.',
			textZh: '用和平彼此联络，竭力保守圣灵所赐合而为一的心。',
			themeEn: 'Unity',
			themeZh: '合一',
		},
	},
];

// ---------------------------------------------------------------------------
// Rate-limit helper: resolves after `ms` milliseconds
// ---------------------------------------------------------------------------
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Low-level Gemini chat completion call (with bounded retry)
// ---------------------------------------------------------------------------
//
// Retries on transient failures (HTTP 429 rate-limit, HTTP 5xx server-side,
// network/timeout/abort) with exponential backoff. Does NOT retry on 4xx
// other than 429 — those are usually our prompt being malformed and won't
// fix themselves on retry.
//
// Each retry rotates to the NEXT round-robin key, so a single rate-limited
// key doesn't block progress when GEMINI_API_KEYS holds multiple.
//
// Single retry only. Two retries × 30s backoff per call × 80+ calls
// per cron meant a quota-exhausted run could stall for an hour;
// better to fail fast and let the keyword fallback run. The next
// cron will pick the same stories back up cheaply via cache once
// quota refills.
const RETRY_BACKOFF_MS = [10000];

function isTransientHttpStatus(status) {
	return status === 429 || (status >= 500 && status < 600);
}

function isTransientNetworkError(error) {
	if (!error) return false;
	if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
	const msg = String(error.message || '').toLowerCase();
	return (
		msg.includes('fetch failed') ||
		msg.includes('network') ||
		msg.includes('econnreset') ||
		msg.includes('etimedout') ||
		msg.includes('socket')
	);
}

async function callGeminiChat(systemPrompt, userPrompt, jsonSchema = null, timeoutMs = 45000, modelOverride = null) {
	const messages = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	];

	const body = {
		model: modelOverride || AI_MODEL,
		messages,
		temperature: AI_TEMPERATURE,
	};

	if (jsonSchema) {
		body.response_format = {
			type: 'json_schema',
			json_schema: {
				name: jsonSchema.name || 'response',
				strict: true,
				schema: jsonSchema.schema,
			},
		};
	}

	let lastError = null;
	for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
		try {
			const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${getNextApiKey()}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => '');
				const err = new Error(`Gemini API returned HTTP ${response.status}: ${errorText.slice(0, 200)}`);
				err.status = response.status;
				throw err;
			}

			const payload = await response.json();

			const choice = payload.choices?.[0];
			if (!choice) {
				throw new Error('No choices returned from Gemini API');
			}

			const content = choice.message?.content;
			if (!content) {
				throw new Error('Empty content from Gemini API');
			}

			return content;
		} catch (error) {
			lastError = error;
			const transient =
				isTransientHttpStatus(error.status) || isTransientNetworkError(error);
			const haveAnotherAttempt = attempt < RETRY_BACKOFF_MS.length;
			if (!transient || !haveAnotherAttempt) {
				throw error;
			}
			const wait = RETRY_BACKOFF_MS[attempt];
			console.warn(
				`Gemini call transient failure (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1}): ${error.message?.slice(0, 120)}. Retrying in ${wait}ms.`,
			);
			await delay(wait);
		}
	}

	throw lastError || new Error('Gemini call exhausted retries');
}

// ---------------------------------------------------------------------------
// AI-powered theme selection
// ---------------------------------------------------------------------------
async function aiSelectTheme(item, allThemes) {
	const themeList = allThemes.map((t) => `- ${t.id}: ${t.focusEn}`).join('\n');

	const systemPrompt =
		'You are a Christian news editor. Given a news story title and summary, select the SINGLE most relevant biblical theme from the provided list. ' +
		'Return ONLY the theme id as a plain string (no quotes, no explanation, no extra text).';

	const userPrompt = [
		`Title: ${item.title}`,
		`Summary: ${item.summary}`,
		'',
		'Available themes:',
		themeList,
		'',
		'Which single theme id best matches this story?',
	].join('\n');

	try {
		const raw = await callGeminiChat(systemPrompt, userPrompt, {
			name: 'theme_pick',
			schema: {
				type: 'object',
				properties: {
					themeId: { type: 'string' },
				},
				required: ['themeId'],
				additionalProperties: false,
			},
		});

		const parsed = extractJson(raw);
		const pickedId = parsed?.themeId?.trim().toLowerCase();

		if (pickedId) {
			const match = allThemes.find((t) => t.id === pickedId);
			if (match) {
				console.log(`AI theme for "${item.title.slice(0, 50)}": ${match.id}`);
				return match;
			}
		}

		console.warn(`AI returned unrecognised theme "${pickedId}", falling back to keyword matching.`);
		return selectTheme(item);
	} catch (error) {
		console.warn(`AI theme selection failed for "${item.title.slice(0, 50)}": ${error.message}`);
		return selectTheme(item);
	}
}

// ---------------------------------------------------------------------------
// Verse corpus loader + deep-think AI matcher
// ---------------------------------------------------------------------------
//
// `news_verse_corpus.json` holds 96 hand-curated verses across 20 topical
// categories (war_and_peace, justice_and_oppression, compassion_and_the_poor,
// etc.). Each entry has structured fields the AI can reason over:
//
//   id, reference, textEn, textZh-Hans, textZh-Hant, themeEn, themeZh,
//   tags[], applies (one-line "use this verse when...")
//
// The point of the catalog is to give the thinking-capable model a finite,
// editorially vetted choice set so it cannot drift into:
//   - obscure verses no general reader would recognise,
//   - lyrical-but-unrelated proof-texting,
//   - politically charged uses of Scripture.
//
// The matcher does a single deep call per story that picks one verseId AND
// writes the bilingual summary + reflection in one structured response,
// replacing the previous two-call (theme-pick → enrich) pipeline.
// ---------------------------------------------------------------------------

let verseCorpusCache = null;

export async function loadVerseCorpus() {
	if (verseCorpusCache) {
		return verseCorpusCache;
	}

	try {
		const raw = await fs.readFile(VERSE_CORPUS_PATH, 'utf8');
		const parsed = JSON.parse(raw);
		const verses = Array.isArray(parsed?.verses) ? parsed.verses : [];
		if (!verses.length) {
			console.warn(`Verse corpus at ${VERSE_CORPUS_PATH} loaded but contains no verses.`);
		}
		verseCorpusCache = verses;
		return verses;
	} catch (error) {
		console.warn(`Failed to load verse corpus from ${VERSE_CORPUS_PATH}: ${error.message}. Falling back to legacy theme-list verses.`);
		verseCorpusCache = [];
		return [];
	}
}

// Compact the corpus into a plain-text catalog the model can scan in one shot.
// Each line: `verseId | reference | themeEn | tags: a,b,c | applies: ...`
// ~150 chars per verse × 96 verses ≈ 14KB → comfortably under any context limit.
export function formatCorpusForPrompt(verseCorpus) {
	return verseCorpus
		.map((v) => {
			const tags = Array.isArray(v.tags) ? v.tags.join(',') : '';
			const applies = String(v.applies || '').slice(0, 220);
			return `${v.id} | ${v.reference} | ${v.themeEn} | tags: ${tags} | applies: ${applies}`;
		})
		.join('\n');
}

// Convert a corpus verse into the article output's `verse` shape, applying
// the editorial divine-name preference (Yahweh / 雅伟). Output schema:
//   { reference, textEn, textZh, themeEn, themeZh }
export function formatVerseFromCorpus(corpusVerse) {
	if (!corpusVerse) return null;
	const textZh = corpusVerse['textZh-Hans'] || corpusVerse.textZh || '';
	return {
		reference: corpusVerse.reference,
		textEn: applyPreferredDivineName(corpusVerse.textEn || ''),
		textZh: applyPreferredDivineName(textZh),
		themeEn: corpusVerse.themeEn || '',
		themeZh: corpusVerse.themeZh || '',
	};
}

// Convert a legacy `themes[]` entry into the same output shape. Used as the
// last-resort fallback when both deep-match AND keyword-pick-from-corpus fail.
function formatVerseFromLegacyTheme(theme) {
	const verse = theme?.verse || {};
	return {
		reference: verse.reference || '',
		textEn: applyPreferredDivineName(verse.textEn || ''),
		textZh: applyPreferredDivineName(verse.textZh || ''),
		themeEn: verse.themeEn || '',
		themeZh: verse.themeZh || '',
	};
}

// Map the legacy keyword-classifier theme id → a corpus verse id. When the AI
// fails (no key, network error, malformed JSON, missing verseId, etc.) we
// still want a thoughtful verse from the curated corpus rather than dropping
// to the 11-verse legacy hardcode. These ids exist in the corpus.
export const KEYWORD_THEME_FALLBACK_VERSE_ID = {
	peace: 'matt_5_9',
	justice: 'micah_6_8',
	leadership: 'prov_11_14',
	compassion: 'matt_25_40',
	stewardship: 'col_3_23',
	truth: 'phil_4_8',
	hope: 'rom_5_3',
	faithfulness: 'matt_5_10',
	wisdom: 'jas_1_5',
	creation: 'gen_2_15',
	unity: 'gal_3_28',
};

// Few-shot examples baked into the prompt. These anchor the model on the
// editorial voice we want — substantive resonance over surface keyword
// overlap, sober/pastoral tone, and reflection prose that connects verse
// to story without preaching. The examples are deliberately varied
// (war/violence, economic hardship, science breakthrough) to cover the
// stylistic range without locking the model into one mode.
export const DEEP_MATCH_FEW_SHOT_EXAMPLES = [
	{
		title: 'Civilian convoy hit during overnight strikes; aid groups call for restraint',
		summary: 'Officials say at least 30 were killed when shells struck a column of vehicles fleeing the city, the latest in weeks of rising civilian casualties.',
		reasoning:
			'The surface topic is a strike on civilians, but the deeper question is the cycle of retaliation that traps both sides — Romans 12:21 names that cycle directly: "do not be overcome by evil, but overcome evil with good." A pure peacemaking verse like matt_5_9 would feel premature when the story is grief, not negotiation. rom_12_21 fits the moral question civilians are forced to live with.',
		verseId: 'rom_12_21',
	},
	{
		title: 'Working families feel squeezed as rate hike pushes mortgage costs to decade high',
		summary: 'Housing analysts warn that further rises will push thousands of households into hardship, with food-bank queues already lengthening in major cities.',
		reasoning:
			'Surface: interest rates. Deeper: the burden of debt on ordinary households — exactly what Proverbs 22:7 captures: "the borrower is slave to the lender." This says more than a generic stewardship verse; it names the power asymmetry the story is really about.',
		verseId: 'prov_22_7',
	},
	{
		title: 'University team announces breakthrough in early cancer detection',
		summary: 'After a decade of laboratory work, researchers report a blood test that flags multiple cancers at stage one with high accuracy.',
		reasoning:
			'Surface: medical breakthrough. Deeper: human longing for healing and the dignity of patient, faithful work. ps_147_3 ("he heals the brokenhearted") evokes the relief the news offers patients; jas_1_5 (wisdom) is too abstract here. Pick the verse that meets the human moment.',
		verseId: 'ps_147_3',
	},
];

function formatFewShotExamples() {
	return DEEP_MATCH_FEW_SHOT_EXAMPLES.map((ex, i) =>
		[
			`Example ${i + 1}:`,
			`title: ${ex.title}`,
			`summary: ${ex.summary}`,
			`reasoning: ${ex.reasoning}`,
			`chosen verseId: ${ex.verseId}`,
		].join('\n'),
	).join('\n\n');
}

// The single-call "deep match". Asks gemini-2.5-pro to:
//   1. infer the story's underlying spiritual / human question,
//   2. pick the best-fitting verseId from the catalog,
//   3. write bilingual summary + reflection that connect verse to story.
// Returns null on any failure so the caller can fall back gracefully.
//
// `recentlyUsedVerseIds` is a soft-diversity hint: if other stories in the
// same section have already chosen these verses, prefer a different verse
// when one fits comparably well. The model can still pick a "used" verse
// if it's truly the best match — we don't want to force an inferior
// choice for the sake of variety.
async function aiDeepMatch(item, verseCorpus, recentlyUsedVerseIds = []) {
	if (!GEMINI_KEYS.length || !verseCorpus.length) {
		return null;
	}

	const catalogText = formatCorpusForPrompt(verseCorpus);
	const fewShotText = formatFewShotExamples();
	const diversityNote =
		recentlyUsedVerseIds.length > 0
			? `Other stories in this same section already chose: ${recentlyUsedVerseIds.join(', ')}. Prefer a different verse when one fits comparably well; the goal is editorial variety so readers don't see the same Scripture three times in a row. Only repeat a "used" verse when it is unambiguously the best match for THIS story.`
			: '';

	const systemPrompt = [
		'You are a thoughtful bilingual Christian editor preparing a daily-news devotional.',
		'You receive ONE news story and a curated catalog of biblical verses.',
		'',
		'Reason carefully step by step before answering:',
		'1. Identify the underlying human or spiritual question the story raises (not just the surface topic — e.g. a war story may really be about cycles of retaliation, refugee suffering, or leadership accountability).',
		'2. Consider which biblical principles speak to that underlying question.',
		'3. Pick the SINGLE verseId from the catalog whose theme most directly applies — substantive resonance, not just keyword overlap.',
		'4. Write a brief bilingual reflection that connects the chosen verse to the story without preaching, partisanship, or invented facts.',
		'',
		'Output rules:',
		'- verseId MUST come exactly from the catalog (case-sensitive).',
		'- Reflection: 2-3 sentences each in English and Simplified Chinese.',
		'- Summary: 1 short paragraph each in English and Simplified Chinese, factual, no opinion.',
		'- titleZh: a faithful Simplified-Chinese rendering of the headline.',
		'- Stay sober, hopeful, pastoral — no political slogans, no triumphalism, no fear-mongering.',
		'- Do not invent facts about the story; restrict yourself to what the title and summary say.',
		'- Use 雅伟 (not 耶和华) when the chosen verse mentions YHWH; the runtime applies a final divine-name pass either way.',
		'',
		'Worked examples of the editorial voice (not part of the answer):',
		fewShotText,
		'',
		'Return ONLY valid JSON matching the schema.',
	].join('\n');

	// Build the prompt with explicit nullable sections so we can skip the
	// EDITORIAL CONSTRAINT block cleanly without nuking the blank-line
	// spacers between sections (using filter(Boolean) would do both).
	const promptLines = [
		'STORY',
		`section: ${item.section}`,
		`source: ${item.source}`,
		`title: ${item.title}`,
		`summary: ${item.summary}`,
		'',
		...(diversityNote ? ['EDITORIAL CONSTRAINT', diversityNote, ''] : []),
		'VERSE CATALOG (verseId | reference | themeEn | tags | applies)',
		catalogText,
		'',
		'Reason carefully, then return JSON: { verseId, titleZh, summaryEn, summaryZh, reflectionEn, reflectionZh }.',
	];
	// Article body (long form) handed to the model so it can produce
	// a faithful Simplified-Chinese translation alongside the verse
	// pick. Capped to keep the prompt reasonable; the AI sees the
	// English exactly and only renders bodyZh.
	const articleBody = (item.body || '').slice(0, 2800);
	if (articleBody && articleBody.length > 60) {
		promptLines.splice(
			6,
			0,
			'',
			'ARTICLE BODY (English — translate faithfully into Simplified Chinese as bodyZh):',
			articleBody,
		);
	}
	const userPrompt = promptLines.join('\n');

	try {
		const raw = await callGeminiChat(
			systemPrompt,
			userPrompt,
			{
				name: 'news_deep_match',
				schema: {
					type: 'object',
					properties: {
						verseId: { type: 'string' },
						titleZh: { type: 'string' },
						summaryEn: { type: 'string' },
						summaryZh: { type: 'string' },
						reflectionEn: { type: 'string' },
						reflectionZh: { type: 'string' },
						// Optional — only filled when the article body
						// was non-trivial. The AI returns the EN body
						// roughly preserved (we discard and use our
						// raw text for accuracy) plus a faithful zh
						// translation. Treat empty string as "no body
						// translation available".
						bodyZh: { type: 'string' },
					},
					required: [
						'verseId',
						'titleZh',
						'summaryEn',
						'summaryZh',
						'reflectionEn',
						'reflectionZh',
					],
					additionalProperties: false,
				},
			},
			// 120s — body translation adds output tokens; thinking-
			// model latency creeps up with the longer prompt.
			120000,
		);

		const parsed = extractJson(raw);
		if (!parsed) {
			console.warn(`Deep-match returned unparseable JSON for "${item.title.slice(0, 60)}".`);
			return null;
		}

		// Trim whitespace defensively — even with strict JSON schema, models
		// occasionally produce ids like " matt_5_9\n" which would never match.
		const requestedId = String(parsed.verseId || '').trim();
		const verse = verseCorpus.find((v) => v.id === requestedId);
		if (!verse) {
			console.warn(`Deep-match returned unknown verseId "${requestedId}" for "${item.title.slice(0, 60)}".`);
			return null;
		}

		const titleZh = cleanText(parsed.titleZh || '') || null;
		const summaryEn = trimText(applyPreferredDivineName(cleanText(parsed.summaryEn || '')), 320) || null;
		const summaryZh = trimText(applyPreferredDivineName(cleanText(parsed.summaryZh || '')), 160) || null;
		const reflectionEn = trimText(applyPreferredDivineName(cleanText(parsed.reflectionEn || '')), 360) || null;
		const reflectionZh = trimText(applyPreferredDivineName(cleanText(parsed.reflectionZh || '')), 180) || null;
		// Body translation — null when no body was supplied OR when the
		// AI declined to translate. trimText caps at the same ~2800-char
		// budget as the EN body so neither side dominates the payload.
		const bodyZhRaw = cleanText(parsed.bodyZh || '');
		const bodyZh = bodyZhRaw && containsCjk(bodyZhRaw)
			? trimText(applyPreferredDivineName(bodyZhRaw), 2800) || null
			: null;

		// Require at least both reflections + verse — partial answers are
		// weaker than a clean keyword fallback.
		if (!reflectionEn || !reflectionZh) {
			console.warn(`Deep-match returned empty reflections for "${item.title.slice(0, 60)}".`);
			return null;
		}

		// Sanity check: zh fields must actually contain Chinese characters.
		// If the model returned English-in-the-zh-slot (rare model regression),
		// we'd otherwise ship English content under the zh locale. We let
		// titleZh slip through here — short headlines like "AI summit" can
		// legitimately be all-Latin in branded contexts — but enforce CJK on
		// the longer reflection/summary text where translation failure is
		// unambiguous.
		if (!containsCjk(reflectionZh) || !containsCjk(summaryZh)) {
			console.warn(`Deep-match returned non-CJK zh fields for "${item.title.slice(0, 60)}"; treating as failure.`);
			return null;
		}

		console.log(`Deep-match for "${item.title.slice(0, 60)}": ${verse.id} (${verse.reference})`);

		return {
			verseId: verse.id,
			verse: formatVerseFromCorpus(verse),
			titleZh,
			summaryEn,
			summaryZh,
			reflectionEn,
			reflectionZh,
			bodyZh,
		};
	} catch (error) {
		console.warn(`Deep-match failed for "${item.title.slice(0, 60)}": ${error.message}`);
		return null;
	}
}

// Reuse the AI verse + reflection from a previous run when the same story
// (same id) reappears. Keeps verse choices stable across cron windows so a
// returning visitor isn't surprised by their morning headline suddenly
// pairing with a different verse at the evening edition.
//
// CRITICAL: we ONLY reuse cache items that carry the new pipeline's
// `aiVerseId` marker. This forces a one-time re-AI pass on legacy cache
// items produced by the pre-deep-match pipeline (whose verse picks were the
// shallow keyword matches the user complained about). Without this guard
// we'd happily keep serving the bad old verses forever.
export function reuseDeepMatchFromCache(item, cachedItem, verseCorpus) {
	if (!cachedItem || cachedItem.translationState !== 'localized') {
		return null;
	}
	// Pipeline-version marker: legacy items don't have it → force re-AI.
	const verseId = cachedItem.aiVerseId;
	if (!verseId || typeof verseId !== 'string') {
		return null;
	}
	if (!cachedItem.verse?.reference) {
		return null;
	}
	if (cachedItem.link && item.link && cachedItem.link !== item.link) {
		return null;
	}

	// Prefer the corpus-canonical version of the verse so any catalog edits
	// (typo fixes, divine-name rendering tweaks) propagate forward instead
	// of being frozen in cached runs. If the cached verseId no longer exists
	// in the corpus (e.g. we removed it during editorial review), fall back
	// to the cached verse text — better to keep continuity than to crash.
	const corpusVerse = verseCorpus.find((v) => v.id === verseId);
	const verse = corpusVerse
		? formatVerseFromCorpus(corpusVerse)
		: {
				reference: cachedItem.verse.reference,
				textEn: applyPreferredDivineName(cachedItem.verse.textEn || ''),
				textZh: applyPreferredDivineName(cachedItem.verse.textZh || ''),
				themeEn: cachedItem.verse.themeEn || '',
				themeZh: cachedItem.verse.themeZh || '',
			};

	const reflectionEn = cachedItem.reflection?.en;
	const reflectionZh = cachedItem.reflection?.zh;
	if (!reflectionEn || !reflectionZh) {
		return null;
	}

	return {
		verseId,
		verse,
		titleZh: cachedItem.title?.zh || null,
		summaryEn: cachedItem.summary?.en || null,
		summaryZh: cachedItem.summary?.zh || null,
		reflectionEn,
		reflectionZh,
		bodyZh: cachedItem.body?.zh || null,
		fromCache: true,
	};
}

// ---------------------------------------------------------------------------
// AI-powered image search query suggestion
// ---------------------------------------------------------------------------
// Body-only translator. Used when a cache hit gives us a verse + the
// short reflection but lacks body.zh — typically the first run after
// the body field shipped. Doesn't disturb the verse pick (we keep
// the cached one) so users don't see "today's verse" change between
// edition windows.
//
// Uses the same model as deep-match (gemini-2.5-pro by default) so
// the editorial voice matches what aiDeepMatch produces; can be
// pointed at flash via OPENAI_MODEL_FAST if cost becomes a concern.
async function aiTranslateBodyToZh(bodyEn) {
	if (!GEMINI_KEYS.length || !bodyEn || bodyEn.length < 60) {
		return null;
	}
	const systemPrompt = [
		'You are a careful bilingual translator working for a Christian news desk.',
		'Translate the supplied article body from English to Simplified Chinese.',
		'',
		'Rules:',
		'- Stay faithful to facts; do not summarise or invent.',
		'- Preserve paragraph breaks (use blank lines between paragraphs).',
		'- Render YHWH as 雅伟 if it appears (the runtime will normalise either way).',
		'- Output ONLY the translation as a JSON object: { "zh": "..." }.',
	].join('\n');

	const userPrompt = `Translate this article body to Simplified Chinese:\n\n${bodyEn.slice(0, 2800)}`;

	try {
		const raw = await callGeminiChat(
			systemPrompt,
			userPrompt,
			{
				name: 'body_translate',
				schema: {
					type: 'object',
					properties: { zh: { type: 'string' } },
					required: ['zh'],
					additionalProperties: false,
				},
			},
			60000,
			AI_TRANSLATE_MODEL, // gemini-2.5-flash by default — separate quota pool from deep-match
		);
		const parsed = extractJson(raw);
		const zh = cleanText(parsed?.zh || '');
		if (!zh || !containsCjk(zh)) return null;
		return trimText(applyPreferredDivineName(zh), 2800) || null;
	} catch (error) {
		console.warn(`Body translation failed: ${error.message?.slice(0, 100)}`);
		return null;
	}
}

async function aiSuggestImageQuery(item) {
	const systemPrompt =
		'You are a news image researcher. Given a news story title and summary, suggest a concise image search query (5-10 words) that would find a relevant editorial photograph. ' +
		'Return ONLY a JSON object with a single "imageQuery" field.';

	const userPrompt = `Title: ${item.title}\nSummary: ${item.summary}\n\nSuggest an image search query for this story.`;

	try {
		const raw = await callGeminiChat(systemPrompt, userPrompt, {
			name: 'image_query',
			schema: {
				type: 'object',
				properties: {
					imageQuery: { type: 'string' },
				},
				required: ['imageQuery'],
				additionalProperties: false,
			},
		});

		const parsed = extractJson(raw);
		return parsed?.imageQuery?.trim() || null;
	} catch (error) {
		console.warn(`AI image query failed for "${item.title.slice(0, 50)}": ${error.message}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
	const existingData = await readExistingData();
	const verseCorpus = await loadVerseCorpus();
	console.log(`Loaded ${verseCorpus.length} curated verses for AI deep-match.`);

	// Build a flat id → item map across all cached sections so cache lookup
	// is O(1) and survives a story moving between sections (rare but possible
	// for cross-tagged feeds like the BBC China-focus filter).
	const existingById = new Map();
	for (const section of Object.values(existingData?.sections ?? {})) {
		for (const cachedItem of section?.items ?? []) {
			if (cachedItem?.id) {
				existingById.set(cachedItem.id, cachedItem);
			}
		}
	}

	const now = new Date();
	const editionDate = getSydneyDateString(now);
	const fetchedGroups = await Promise.all(sourceCatalog.map(fetchFeed));
	const rawItems = fetchedGroups.flat();

	if (rawItems.length === 0 && !existingData) {
		throw new Error('No feed items were fetched and there is no cached data to fall back to.');
	}

	// sectionId → ordered list of aiVerseIds chosen so far. Mutated by
	// buildStories as each story commits its pick, then read by the next
	// aiDeepMatch call as a soft-diversity hint.
	const sectionUsedVerseIds = new Map();
	const buildCtx = { verseCorpus, existingById, sectionUsedVerseIds };
	const builtSections = {};

	for (const sectionId of Object.keys(sectionMeta)) {
		const sectionItems = rawItems
			.filter((item) => item.section === sectionId)
			.sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));

		const uniqueItems = dedupeStories(sectionItems);
		const targetCount = determineTargetCount(uniqueItems, editionDate);
		const selectedItems = selectBalancedItems(uniqueItems, targetCount);
		const fallbackSection = existingData?.sections?.[sectionId];
		const shouldUseCache = selectedItems.length === 0 && fallbackSection?.items?.length;

		if (!shouldUseCache && selectedItems.length === 0) {
			throw new Error(`Section "${sectionId}" ended up empty and no cached content was available.`);
		}

		const freshStories = shouldUseCache ? [] : await buildStories(selectedItems, buildCtx);
		const mergedStories = shouldUseCache
			? fallbackSection.items
			: topUpWithCachedStories(freshStories, fallbackSection?.items ?? [], minItemsPerSection);
		const sourceNotes = Array.from(new Set(mergedStories.map((item) => item.source)));

		builtSections[sectionId] = {
			id: sectionId,
			title: sectionMeta[sectionId].title,
			strap: sectionMeta[sectionId].strap,
			sourceNotes,
			items: mergedStories,
		};
	}

	const payload = {
		generatedAt: now.toISOString(),
		editionDate,
		sources: sourceCatalog.map((source) => ({
			name: source.name,
			url: source.url,
			category: source.section,
			categoryLabel: sectionMeta[source.section].categoryLabel,
		})),
		sections: builtSections,
	};

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

	logRunSummary(payload);
}

// Structured run summary. Printed at the end of every refresh so the
// GitHub Actions log gives a glanceable snapshot of:
//   - story count per section,
//   - how many got the deep-match path vs keyword fallback,
//   - which verses are over-represented (signals weak corpus coverage),
//   - which categories of source dominated.
// Anyone debugging a "why is the news shallow today?" complaint can scan
// this summary without parsing daily_news.json by hand.
function logRunSummary(payload) {
	const allItems = Object.values(payload.sections).flatMap((s) => s.items);
	const total = allItems.length;
	const localized = allItems.filter((it) => it.translationState === 'localized').length;
	const fallback = total - localized;
	const verseCounts = new Map();
	for (const it of allItems) {
		const id = it.aiVerseId || `[fallback]${it.verse?.reference || 'unknown'}`;
		verseCounts.set(id, (verseCounts.get(id) || 0) + 1);
	}
	const overUsed = [...verseCounts.entries()]
		.filter(([, n]) => n >= 3)
		.sort((a, b) => b[1] - a[1])
		.map(([id, n]) => `${id}:${n}`);

	console.log('');
	console.log('━━━ Refresh summary ━━━');
	console.log(`Edition date: ${payload.editionDate}`);
	console.log(`Total stories: ${total}`);
	console.log(`  Deep-match / cache (translationState=localized): ${localized}`);
	console.log(`  Keyword fallback                                 : ${fallback}`);
	for (const [sid, section] of Object.entries(payload.sections)) {
		const sLocalized = section.items.filter((it) => it.translationState === 'localized').length;
		console.log(`  ${sid.padEnd(10)}: ${section.items.length} stories (${sLocalized} localized)`);
	}
	console.log(`Unique verses in this edition: ${verseCounts.size}`);
	if (overUsed.length) {
		console.log(`Verses used 3+ times (consider expanding corpus / improving prompt): ${overUsed.join(' ')}`);
	} else {
		console.log('No verse used 3+ times — diversity is healthy.');
	}
	console.log('━━━━━━━━━━━━━━━━━━━━━━━');
}

async function readExistingData() {
	try {
		const raw = await fs.readFile(outputPath, 'utf8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function fetchFeed(source) {
	try {
		const response = await fetch(source.url, {
			headers: {
				'User-Agent': 'DailyMannaDispatchBot/1.0',
				Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
			},
			signal: AbortSignal.timeout(30000),
		});

		if (!response.ok) {
			throw new Error(`Unexpected HTTP ${response.status}`);
		}

		const xml = await response.text();
		const feed = await parser.parseString(xml);

		return (feed.items ?? [])
			.map((item) => {
				const title = cleanText(item.title || 'Untitled story');
				const summary = deriveSummary(item);
				const body = deriveBody(item);
				const enclosureUrl = extractEnclosureImage(item);

				return {
					id: slugify(item.link || item.guid || item.title || `${source.section}-${Math.random()}`),
					section: source.section,
					source: source.name,
					sourceUrl: source.url,
					link: item.link || source.url,
					title,
					summary,
					body,
					enclosureUrl,
					publishedAt: normalizeDate(item.isoDate || item.pubDate),
				};
			})
			.filter((item) => matchesSourceFilter(source, item));
	} catch (error) {
		console.warn(`Feed failed for ${source.name}: ${error.message}`);
		return [];
	}
}

// Image source priority — RSS feeds can carry artwork in any of
// these slots, so try them in turn. Final fallback is `null`, which
// the OG-meta scraper picks up downstream in buildStory().
function extractEnclosureImage(item) {
	// 1. Standard RSS <enclosure>.
	if (item.enclosure?.url && /^https?:\/\//i.test(item.enclosure.url)) {
		return item.enclosure.url;
	}
	// 2. Media RSS <media:content url="..." medium="image">.
	const mediaContent = item['media:content'];
	const mc = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
	const mcUrl = mc?.$?.url || mc?.url;
	if (mcUrl && /^https?:\/\//i.test(mcUrl)) return mcUrl;
	// 3. Media RSS <media:thumbnail url="...">.
	const mediaThumb = item['media:thumbnail'];
	const mt = Array.isArray(mediaThumb) ? mediaThumb[0] : mediaThumb;
	const mtUrl = mt?.$?.url || mt?.url;
	if (mtUrl && /^https?:\/\//i.test(mtUrl)) return mtUrl;
	// 4. First <img src="…"> embedded in content:encoded HTML —
	// catches the Guardian, BBC blogs, and most commercial feeds
	// that don't fill in the enclosure tag.
	const html =
		item['content:encoded'] || item.content || item.description || '';
	const imgMatch = String(html).match(
		/<img[^>]+src=["']([^"']+)["']/i,
	);
	if (imgMatch && /^https?:\/\//i.test(imgMatch[1])) return imgMatch[1];
	return null;
}

function deriveSummary(item) {
	const raw =
		item.contentSnippet ||
		item.summary ||
		item.content ||
		item['content:encodedSnippet'] ||
		item['content:encoded'] ||
		item.description ||
		'';

	return trimText(cleanText(raw), 280) || 'Open the source article for the full report.';
}

// Long-form article body for the detail-page view. Only returns text
// when content:encoded (the standard slot for the full article HTML)
// is meaningfully longer than the summary — otherwise we'd just be
// duplicating the 280-char lede on the detail page, which user
// feedback flagged as "one news not full". Many feeds (BBC, SBS,
// DW headline ticker) genuinely lack the full body in their RSS;
// the detail page now hides the body block in that case and the
// "Read original at…" button is the entry point for the full text.
function deriveBody(item) {
	const encoded = cleanText(item['content:encoded'] || item.content || '');
	if (!encoded) return '';
	const summary = cleanText(deriveSummary(item) || '');
	// Require the full body to be at least 50% longer than the summary
	// AND beyond 320 chars; otherwise it's essentially the same text
	// the lede already shows.
	if (encoded.length < 320) return '';
	if (encoded.length < summary.length * 1.5) return '';
	return trimText(encoded, 2800);
}

export function dedupeStories(items) {
	const seenLinks = new Set();
	const seenTitles = new Set();
	const unique = [];

	for (const item of items) {
		const linkKey = normalizeLink(item.link);
		const titleKey = normalizeTitle(item.title);

		if (seenLinks.has(linkKey) || (titleKey.length >= 24 && seenTitles.has(titleKey))) {
			continue;
		}

		seenLinks.add(linkKey);
		if (titleKey) {
			seenTitles.add(titleKey);
		}
		unique.push(item);
	}

	return unique;
}

export function determineTargetCount(items, editionDate, options = {}) {
	const minItems = Math.max(1, options.minItems ?? minItemsPerSection);
	const maxItems = Math.max(minItems, options.maxItems ?? maxItemsPerSection);
	const sameDayCount = items.filter(
		(item) => getSydneyDateString(new Date(item.publishedAt)) === editionDate,
	).length;

	return Math.min(maxItems, Math.max(minItems, sameDayCount));
}

export function selectBalancedItems(items, targetCount) {
	const queues = new Map();
	const sourceOrder = [];

	for (const item of items) {
		if (!queues.has(item.source)) {
			queues.set(item.source, []);
			sourceOrder.push(item.source);
		}

		queues.get(item.source).push(item);
	}

	const selected = [];

	while (selected.length < targetCount) {
		let addedThisRound = false;

		for (const source of sourceOrder) {
			const queue = queues.get(source);
			if (!queue?.length) {
				continue;
			}

			selected.push(queue.shift());
			addedThisRound = true;

			if (selected.length >= targetCount) {
				break;
			}
		}

		if (!addedThisRound) {
			break;
		}
	}

	return selected.sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
}

function topUpWithCachedStories(freshStories, cachedStories, minimumCount) {
	if (freshStories.length >= minimumCount) {
		return freshStories;
	}

	const seen = new Set(freshStories.map((story) => story.id || story.link));
	const toppedUp = [...freshStories];

	for (const story of cachedStories) {
		const key = story.id || story.link;
		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		toppedUp.push(story);

		if (toppedUp.length >= minimumCount) {
			break;
		}
	}

	return toppedUp;
}

function matchesSourceFilter(source, item) {
	if (!source.matchKeywords?.length) {
		return true;
	}

	const haystack = `${item.title} ${item.summary}`.toLowerCase();
	return source.matchKeywords.some((keyword) => haystack.includes(keyword));
}

async function fetchOgImage(url) {
	try {
		const response = await fetch(url, {
			headers: {
				'User-Agent': 'DailyMannaDispatchBot/1.0',
				Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			},
			signal: AbortSignal.timeout(15000),
		});

		if (!response.ok) {
			return null;
		}

		const html = await response.text();
		const match = html.match(/<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i)
			|| html.match(/<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image["']/i);

		return match ? match[1] : null;
	} catch {
		return null;
	}
}

async function buildStory(item, index, ctx = {}) {
	const {
		verseCorpus = [],
		existingById = null,
		sectionUsedVerseIds = null,
	} = ctx;

	// 1. Cache hit? Reuse the AI's previous verse + reflection so a story
	//    keeps the same Scripture across the day's four publishing windows.
	let deep = null;
	const cachedItem = existingById?.get(item.id) || null;
	if (cachedItem) {
		deep = reuseDeepMatchFromCache(item, cachedItem, verseCorpus);
		if (deep) {
			console.log(`Reusing cached deep-match for "${item.title.slice(0, 60)}": ${deep.verse.reference}`);
		}
	}

	// 2. No cache → run the deep-think AI call. Pass the verses already
	//    used by previous stories in this same section as a soft-diversity
	//    hint so a section doesn't end up with five "Romans 12:21" entries.
	if (!deep) {
		const used = sectionUsedVerseIds?.get(item.section) || [];
		deep = await aiDeepMatch(item, verseCorpus, used);
		await delay(AI_CALL_DELAY_MS);
	}

	// 2b. Body-translation top-up: cache hits made before body.zh
	//     existed return without it; rather than re-roll the verse
	//     pick we just translate the body in a separate small call.
	//
	//     OFF BY DEFAULT — set NEWS_TRANSLATE_BODY=1 to enable.
	//     Body translation roughly doubles AI calls per story
	//     (deep-match + translate), and the daily Gemini free-tier
	//     quotas (250 RPD pro, 1500 RPD flash) get exhausted within
	//     a single busy day even with throttling. The detail page
	//     falls back to summary.zh when bodyZh is empty, so users
	//     still get bilingual headlines + lede + reflection. We
	//     can flip this on once a paid key is in place.
	if (
		process.env.NEWS_TRANSLATE_BODY === '1' &&
		deep &&
		!deep.bodyZh &&
		item.body &&
		item.body.length >= 60
	) {
		const translated = await aiTranslateBodyToZh(item.body);
		if (translated) {
			deep = { ...deep, bodyZh: translated };
		}
		await delay(AI_CALL_DELAY_MS);
	}

	// 3. Last-resort fallback: keyword-classify into the legacy theme list
	//    and pick the corpus verse mapped to that theme. If the corpus is
	//    missing for some reason, fall through to the legacy theme verse.
	const keywordTheme = selectTheme(item);
	const verseForFallback = (() => {
		const fallbackId = KEYWORD_THEME_FALLBACK_VERSE_ID[keywordTheme.id];
		const corpusVerse = fallbackId ? verseCorpus.find((v) => v.id === fallbackId) : null;
		return corpusVerse ? formatVerseFromCorpus(corpusVerse) : formatVerseFromLegacyTheme(keywordTheme);
	})();

	const verse = deep?.verse || verseForFallback;
	const fallbackCopy = createFallbackCopy(item, keywordTheme);

	// Translate the headline to zh only when the AI didn't already provide one.
	const fallbackTitleZh = deep?.titleZh ? null : await maybeTranslateTitleToChinese(item.title);

	// Image resolution: enclosure → OG meta → (optional) AI search-query.
	//
	// The AI search-query suggestion was originally meant to power a future
	// image picker, but no consumer ever read the resulting `imageQuery`
	// field — it was just stored in daily_news.json and ignored. At ~half
	// the stories lacking an OG image, that's ~15 wasted AI calls per cron
	// × 4 runs/day = 60+/day. Now opt-in via NEWS_GENERATE_IMAGE_QUERY=1
	// so the cost stays off by default. The function is kept defined for
	// when the image-picker feature ships.
	let imageUrl = item.enclosureUrl || null;
	let imageQuery = null;

	if (!imageUrl && item.link) {
		imageUrl = await fetchOgImage(item.link);
	}

	if (!imageUrl && process.env.NEWS_GENERATE_IMAGE_QUERY === '1') {
		imageQuery = await aiSuggestImageQuery(item);
		await delay(AI_CALL_DELAY_MS);
	}

	return {
		id: item.id,
		section: item.section,
		source: item.source,
		sourceUrl: item.sourceUrl,
		link: item.link,
		image: imageUrl,
		imageQuery: imageQuery || undefined,
		publishedAt: item.publishedAt,
		title: {
			en: item.title,
			zh: deep?.titleZh || fallbackTitleZh || null,
		},
		summary: {
			en: applyPreferredDivineName(deep?.summaryEn ?? fallbackCopy.summary.en),
			zh: applyPreferredDivineName(deep?.summaryZh ?? fallbackCopy.summary.zh),
		},
		// Long-form article body for the in-app detail-page reader.
		// `en` is the cleaned RSS content:encoded text (~2800 chars
		// max). `zh` is null when no body was available OR the AI
		// declined to translate; the Flutter side then falls back to
		// summary.zh so the zh reader still gets meaningful content.
		body: {
			en: item.body || null,
			zh: deep?.bodyZh ?? null,
		},
		reflection: {
			en: applyPreferredDivineName(deep?.reflectionEn ?? fallbackCopy.reflection.en),
			zh: applyPreferredDivineName(deep?.reflectionZh ?? fallbackCopy.reflection.zh),
		},
		verse,
		// Stable cache key. Lets the next run reuse this exact verse pick
		// without having to re-derive it from the verse.reference string.
		aiVerseId: deep?.verseId || undefined,
		translationState: deep ? 'localized' : 'fallback',
	};
}

async function buildStories(items, ctx = {}) {
	const builtItems = [];
	const sectionUsedVerseIds = ctx.sectionUsedVerseIds;

	for (let i = 0; i < items.length; i++) {
		console.log(`Building story ${i + 1}/${items.length}: ${items[i].title.slice(0, 60)}`);
		const built = await buildStory(items[i], i, ctx);
		builtItems.push(built);

		// Record the chosen verse so subsequent stories in this same section
		// see it in their soft-diversity hint. Only record AI / cache-resolved
		// picks (those have aiVerseId); pure keyword fallbacks aren't worth
		// avoiding because they're already a degraded path.
		if (built.aiVerseId && sectionUsedVerseIds) {
			const used = sectionUsedVerseIds.get(built.section) || [];
			used.push(built.aiVerseId);
			sectionUsedVerseIds.set(built.section, used);
		}
	}

	return builtItems;
}

export function selectTheme(item) {
	const titleLower = (item.title || '').toLowerCase();
	const summaryLower = (item.summary || '').toLowerCase();
	let bestTheme = themes[themes.length - 1];
	let bestScore = -1;

	for (const theme of themes) {
		let score = 0;

		for (const keyword of theme.keywords) {
			if (titleLower.includes(keyword)) {
				score += 3;
			}
			if (summaryLower.includes(keyword)) {
				score += 1;
			}
		}

		if (score > bestScore) {
			bestTheme = theme;
			bestScore = score;
		}
	}

	return bestTheme;
}

export function createFallbackCopy(item, theme) {
	const sectionLabel = sectionMeta[item.section].categoryLabel;
	return {
		summary: {
			en: applyPreferredDivineName(item.summary),
			zh: applyPreferredDivineName(
				`这是一则来自${sectionLabel.zh}栏目的新闻，重点涉及${theme.focusZh}。如需完整细节，请阅读英文原始报道。`,
			),
		},
		reflection: {
			en: applyPreferredDivineName(
				`This story draws attention to ${theme.focusEn}. ${theme.verse.reference} reminds us to meet sharp headlines with ${theme.actionEn}, asking how faithful people can respond with wisdom instead of noise.`,
			),
			zh: applyPreferredDivineName(
				`这则新闻让人想到${theme.focusZh}。${theme.verse.reference}提醒我们，在快速变化的新闻里，仍要以${theme.actionZh}来回应，并学习用祷告与分辨代替情绪化判断。`,
			),
		},
	};
}

async function maybeEnrichWithAI(item, theme) {
	if (!GEMINI_KEYS.length) {
		return null;
	}

	try {
		const systemPrompt =
			'You are a bilingual Christian news editor. Stay factual, concise, and avoid partisan rhetoric or invented details. ' +
			'Return valid JSON matching the requested schema.';

		const userPrompt = [
			'Write a compact bilingual enrichment for this news item.',
			'Return JSON with fields: titleZh, summaryEn, summaryZh, reflectionEn, reflectionZh.',
			'Constraints:',
			'- Keep summaryEn and summaryZh to 1 short paragraph each.',
			'- Keep reflectionEn and reflectionZh to 1 short paragraph each.',
			'- Reflection should connect the story to the provided Bible theme without sounding preachy.',
			'- Do not add facts not present in the article input.',
			'Article:',
			JSON.stringify(
				{
					section: item.section,
					source: item.source,
					title: item.title,
					summary: item.summary,
					publishedAt: item.publishedAt,
					bibleTheme: theme.focusEn,
					bibleVerse: `${theme.verse.reference} -- ${theme.verse.textEn}`,
				},
				null,
				2,
			),
		].join('\n');

		const raw = await callGeminiChat(systemPrompt, userPrompt, {
			name: 'news_enrichment',
			schema: {
				type: 'object',
				properties: {
					titleZh: { type: 'string' },
					summaryEn: { type: 'string' },
					summaryZh: { type: 'string' },
					reflectionEn: { type: 'string' },
					reflectionZh: { type: 'string' },
				},
				required: ['titleZh', 'summaryEn', 'summaryZh', 'reflectionEn', 'reflectionZh'],
				additionalProperties: false,
			},
		});

		const parsed = extractJson(raw);

		if (!parsed) {
			return null;
		}

		const enriched = {
			titleZh: cleanText(parsed.titleZh || '') || null,
			summaryEn: trimText(applyPreferredDivineName(cleanText(parsed.summaryEn || '')), 280) || null,
			summaryZh: trimText(applyPreferredDivineName(cleanText(parsed.summaryZh || '')), 140) || null,
			reflectionEn: trimText(applyPreferredDivineName(cleanText(parsed.reflectionEn || '')), 280) || null,
			reflectionZh: trimText(applyPreferredDivineName(cleanText(parsed.reflectionZh || '')), 140) || null,
		};

		return Object.values(enriched).some(Boolean) ? enriched : null;
	} catch (error) {
		console.warn(`AI enrichment skipped for "${item.title}": ${error.message}`);
		return null;
	}
}

async function maybeTranslateTitleToChinese(value) {
	if (!value || containsCjk(value)) {
		return cleanText(value || '') || null;
	}

	try {
		const url = new URL('https://translate.googleapis.com/translate_a/single');
		url.searchParams.set('client', 'gtx');
		url.searchParams.set('sl', 'en');
		url.searchParams.set('tl', 'zh-CN');
		url.searchParams.set('dt', 't');
		url.searchParams.set('q', value);

		const response = await fetch(url, {
			headers: {
				'User-Agent': 'DailyMannaDispatchBot/1.0',
				Accept: 'application/json, text/plain, */*',
			},
			signal: AbortSignal.timeout(30000),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const payload = await response.json();
		const translated = extractTranslatedText(payload);
		return translated ? cleanText(translated) : null;
	} catch (error) {
		console.warn(`Title translation skipped for "${value}": ${error.message}`);
		return null;
	}
}

export function extractTranslatedText(payload) {
	if (!Array.isArray(payload?.[0])) {
		return null;
	}

	const parts = payload[0]
		.map((segment) => (Array.isArray(segment) ? segment[0] : null))
		.filter(Boolean);

	return parts.length ? parts.join('') : null;
}

export function extractResponseJson(payload) {
	// Kept for backwards compatibility with tests / callers
	if (payload?.output_parsed && typeof payload.output_parsed === 'object') {
		return payload.output_parsed;
	}

	if (typeof payload?.output_text === 'string') {
		return extractJson(payload.output_text);
	}

	for (const item of payload?.output ?? []) {
		for (const contentItem of item?.content ?? []) {
			if (contentItem?.parsed && typeof contentItem.parsed === 'object') {
				return contentItem.parsed;
			}

			if (typeof contentItem?.text === 'string') {
				const parsed = extractJson(contentItem.text);
				if (parsed) {
					return parsed;
				}
			}
		}
	}

	return null;
}

export function extractJson(value) {
	if (typeof value !== 'string') {
		return null;
	}

	const cleaned = value.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');

	if (start === -1 || end === -1) {
		return null;
	}

	try {
		return JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return null;
	}
}

export function cleanText(value) {
	return String(value || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&#x27;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

export function trimText(value, limit) {
	if (!value || value.length <= limit) {
		return value;
	}

	const trimmed = value.slice(0, limit);
	const lastSpace = trimmed.lastIndexOf(' ');
	return `${trimmed.slice(0, lastSpace > 0 ? lastSpace : limit).trim()}...`;
}

export function applyPreferredDivineName(value) {
	return String(value || '')
		.replace(/\bthe LORD\b/g, 'Yahweh')
		.replace(/\bThe LORD\b/g, 'Yahweh')
		.replace(/\bthe Lord\b/g, 'Yahweh')
		.replace(/\bThe Lord\b/g, 'Yahweh')
		.replace(/耶和华/g, '雅伟');
}

function containsCjk(value) {
	return /[\u3400-\u9fff]/.test(String(value || ''));
}

function normalizeTitle(value) {
	return cleanText(value)
		.toLowerCase()
		.replace(/\b(live|update|updates)\b/g, ' ')
		.replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeLink(value) {
	try {
		const url = new URL(value);
		return `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
	} catch {
		return String(value || '').trim().toLowerCase();
	}
}

function normalizeDate(value) {
	const date = value ? new Date(value) : new Date();
	return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

function slugify(value) {
	return String(value)
		.toLowerCase()
		.replace(/https?:\/\//g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 72);
}

function getSydneyDateString(date) {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'Australia/Sydney',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return formatter.format(date);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
