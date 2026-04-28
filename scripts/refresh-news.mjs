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
const AI_MODEL = process.env.OPENAI_MODEL || 'gemini-2.5-flash';
const AI_CALL_DELAY_MS = 500;

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
// Low-level Gemini chat completion call
// ---------------------------------------------------------------------------
async function callGeminiChat(systemPrompt, userPrompt, jsonSchema = null, timeoutMs = 45000) {
	const messages = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	];

	const body = {
		model: AI_MODEL,
		messages,
		temperature: 0.3,
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
		throw new Error(`Gemini API returned HTTP ${response.status}: ${errorText.slice(0, 200)}`);
	}

	const payload = await response.json();

	// Standard chat completions response format
	const choice = payload.choices?.[0];
	if (!choice) {
		throw new Error('No choices returned from Gemini API');
	}

	const content = choice.message?.content;
	if (!content) {
		throw new Error('Empty content from Gemini API');
	}

	return content;
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
// AI-powered image search query suggestion
// ---------------------------------------------------------------------------
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
	const now = new Date();
	const editionDate = getSydneyDateString(now);
	const fetchedGroups = await Promise.all(sourceCatalog.map(fetchFeed));
	const rawItems = fetchedGroups.flat();

	if (rawItems.length === 0 && !existingData) {
		throw new Error('No feed items were fetched and there is no cached data to fall back to.');
	}

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

		const freshStories = shouldUseCache ? [] : await buildStories(selectedItems);
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

	const localizedCount = Object.values(payload.sections)
		.flatMap((section) => section.items)
		.filter((item) => item.translationState === 'localized').length;

	console.log(
		`Daily news refreshed: ${Object.values(payload.sections).reduce((sum, section) => sum + section.items.length, 0)} stories, ${localizedCount} localized with Gemini AI.`,
	);
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
				const enclosureUrl = extractEnclosureImage(item);

				return {
					id: slugify(item.link || item.guid || item.title || `${source.section}-${Math.random()}`),
					section: source.section,
					source: source.name,
					sourceUrl: source.url,
					link: item.link || source.url,
					title,
					summary,
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

function extractEnclosureImage(item) {
	if (item.enclosure?.url && /^https?:\/\//i.test(item.enclosure.url)) {
		return item.enclosure.url;
	}
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

async function buildStory(item, index) {
	// AI-powered theme selection (with keyword fallback)
	const theme = await aiSelectTheme(item, themes);
	await delay(AI_CALL_DELAY_MS);

	const fallback = createFallbackCopy(item, theme);
	const enriched = await maybeEnrichWithAI(item, theme);
	await delay(AI_CALL_DELAY_MS);

	const fallbackTitleZh = enriched?.titleZh ? null : await maybeTranslateTitleToChinese(item.title);

	// Image resolution: enclosure -> OG -> AI image query
	let imageUrl = item.enclosureUrl || null;
	let imageQuery = null;

	if (!imageUrl && item.link) {
		imageUrl = await fetchOgImage(item.link);
	}

	if (!imageUrl) {
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
			zh: enriched?.titleZh || fallbackTitleZh || null,
		},
		summary: {
			en: applyPreferredDivineName(enriched?.summaryEn ?? fallback.summary.en),
			zh: applyPreferredDivineName(enriched?.summaryZh ?? fallback.summary.zh),
		},
		reflection: {
			en: applyPreferredDivineName(enriched?.reflectionEn ?? fallback.reflection.en),
			zh: applyPreferredDivineName(enriched?.reflectionZh ?? fallback.reflection.zh),
		},
		verse: {
			...theme.verse,
			textEn: applyPreferredDivineName(theme.verse.textEn),
			textZh: applyPreferredDivineName(theme.verse.textZh),
		},
		translationState: enriched ? 'localized' : 'fallback',
	};
}

async function buildStories(items) {
	const builtItems = [];

	for (let i = 0; i < items.length; i++) {
		console.log(`Building story ${i + 1}/${items.length}: ${items[i].title.slice(0, 60)}`);
		builtItems.push(await buildStory(items[i], i));
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
