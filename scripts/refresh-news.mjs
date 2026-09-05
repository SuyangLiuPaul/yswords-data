import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Parser from 'rss-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
// Output to data/daily_news.json — the canonical home in yswords-data.
// (In the legacy DailyNews repo this used to be src/data/latest-news.json.)
const outputPath = path.join(projectRoot, 'data', 'daily_news.json');
const archiveDir = path.join(projectRoot, 'data', 'archive');
const archiveIndexPath = path.join(archiveDir, 'index.json');
const newsImageDir = path.join(projectRoot, 'images', 'news');
// How many past daily editions to keep archived for infinite-scroll
// consumers (news_insights). Bounded so the git repo doesn't grow
// forever — 90 days is generous scrollback without unbounded history.
const ARCHIVE_RETENTION_DAYS = 90;
const parser = new Parser();
const minItemsPerSection = Math.max(1, Number(process.env.NEWS_MIN_ITEMS_PER_SECTION || 10));
// 2026-07-22: raised default max from 18 to 30. The `world` section was
// consistently hitting the old 18 cap (i.e. same-day supply regularly
// exceeded it across the 4 world feeds) while china/australia stayed
// floor-bound at minItemsPerSection — so this surfaces more of what's
// already being fetched rather than padding with lower-quality items;
// determineTargetCount() still bounds by real same-day supply.
const maxItemsPerSection = Math.max(minItemsPerSection, Number(process.env.NEWS_MAX_ITEMS_PER_SECTION || 30));

// --- AI Configuration (Gemini via OpenAI-compatible endpoint) ---
//
// Keys come from environment ONLY. Previously this file embedded four
// literal Gemini keys as fallbacks — those leaked to anyone who forked
// the public repo and had to be rotated. Supply them via any of the
// GitHub Actions secrets `OPENAI_API_KEY`, `GEMINI_API_KEY`, or
// `GEMINI_API_KEYS` (comma-separated). Without any key the refresh
// still runs but skips AI translation/reflection enrichment.
//
// 2026-08-25: these three sources are now ADDITIVE. They used to be a
// `||` chain, so setting GEMINI_API_KEYS silently disabled the key in
// OPENAI_API_KEY instead of adding to it — the opposite of what someone
// reaching for a second key wants, and undiagnosable from CI because
// GitHub secrets are write-only (you cannot read the existing value to
// merge it by hand). Since the free tier's per-key daily cap is the
// binding constraint on deep-match coverage, adding a key must actually
// add capacity. Deduped so the same key set in two vars is not
// round-robined onto itself.
const GEMINI_KEYS = [
	...new Set(
		[
			process.env.GEMINI_API_KEYS,
			process.env.GEMINI_API_KEY,
			process.env.OPENAI_API_KEY,
		]
			.filter(Boolean)
			.flatMap((value) => value.split(','))
			.map((k) => k.trim())
			.filter(Boolean),
	),
];
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
// 2026-08-25: default flipped from gemini-2.5-flash to -flash-lite.
// Measured, not guessed: a run starting 3 minutes after the midnight-PDT
// quota reset — i.e. on a completely untouched daily budget — landed
// exactly 15 successful deep-matches before every later call 429'd, and
// the successes came at ~3/minute. That is not the 1500/day the comment
// below used to claim; gemini-2.5-flash's free tier is ~20 requests/day,
// so no cadence, cache, or retry policy could ever have deep-matched a
// 128-story edition on it. The sister Gemini functions in the yswords
// Netlify site hit this same wall in June and moved to flash-lite then;
// this pipeline never got the same treatment.
//
// flash-lite carries a far larger free daily allowance and is entirely
// capable of the pick-a-verse-and-write-a-reflection task. AI_MODEL stays
// the head of AI_MODEL_CHAIN below, which steps down on 429/5xx so a
// model-specific cap degrades to the next model rather than to the
// keyword fallback.
const AI_MODEL = process.env.OPENAI_MODEL || 'gemini-2.5-flash-lite';

// Ordered step-down chain. A transient failure (429 rate-limit / daily
// cap, or a 5xx "high demand") retries on the NEXT model rather than
// hammering the one that just refused — a per-model daily cap is not
// something backoff can wait out, so retrying the same model is the
// one strategy guaranteed to fail. Override with a comma-separated
// OPENAI_MODEL_CHAIN.
//
// Order is evidence-based: gemini-3-flash-preview sits ahead of
// gemini-2.5-flash because in the 2026-08-25 07:55 run it absorbed the
// step-down traffic successfully while all 192 calls that reached
// flash came back 429. The starved model goes last, where it costs a
// wasted attempt only after the two live ones are spent.
const AI_MODEL_CHAIN = (
	process.env.OPENAI_MODEL_CHAIN ||
	[AI_MODEL, 'gemini-3-flash-preview', 'gemini-2.5-flash'].join(',')
)
	.split(',')
	.map((m) => m.trim())
	.filter(Boolean);
// Cheaper / higher-quota model for mechanical translation passes.
// Also moved off gemini-2.5-flash 2026-08-25: the "1500 RPD" this
// comment used to cite was wrong (see AI_MODEL above — measured at
// ~20/day), and pointing translation at the same starved model meant
// the two paths competed for the same tiny budget. Body translation
// mostly runs through FREE_TRANSLATE_PROVIDERS anyway; this is the
// AI backstop for when those fail.
const AI_TRANSLATE_MODEL =
	process.env.OPENAI_TRANSLATE_MODEL || 'gemini-2.5-flash-lite';
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
	hongkong: {
		title: { en: 'Hong Kong Desk', zh: '香港快讯' },
		strap: {
			en: 'News, policy, and public life in Hong Kong.',
			zh: '聚焦香港时事、政策与社会动态。',
		},
		categoryLabel: { en: 'Hong Kong', zh: '香港' },
	},
	science: {
		title: { en: 'Science & Nature Desk', zh: '自然科学' },
		// The desk pulls from weekly journals (Nature) alongside daily
		// outlets; a higher cap keeps the weekly material from being
		// crowded out by same-day wire stories.
		maxItems: 26,
		strap: {
			en: 'Discoveries in nature, climate, health, and the wider cosmos.',
			zh: '自然、气候、健康与宇宙万象的新发现。',
		},
		categoryLabel: { en: 'Science', zh: '科学' },
	},
	technology: {
		title: { en: 'Technology Desk', zh: '科技前沿' },
		strap: {
			en: 'Technology shaping how we live, work, and think.',
			zh: '正在改变生活、工作与思考方式的科技动态。',
		},
		categoryLabel: { en: 'Tech', zh: '科技' },
	},
	creation: {
		title: { en: 'Creation Desk', zh: '受造世界' },
		strap: {
			en: 'The world Yahweh made — its wonders, and the toll of a warming, wounded earth.',
			zh: '雅伟所造的世界——它的奇妙，以及一个渐暖、渐伤的地球所付的代价。',
		},
		categoryLabel: { en: 'Creation', zh: '受造' },
	},
	documentary: {
		title: { en: 'Documentary Desk', zh: '纪录片精选' },
		strap: {
			en: 'New and notable documentaries — nature, creation, and the stories worth two hours of attention.',
			zh: '值得关注的新纪录片——自然、受造世界，以及值得花两小时细看的故事。',
		},
		categoryLabel: { en: 'Documentary', zh: '纪录片' },
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
		matchKeywords: ['china', 'beijing', 'taiwan', 'xi jinping', 'xinjiang', 'tibet'],
	},
	{
		name: 'SBS News China Focus',
		url: 'https://www.sbs.com.au/news/topic/world/feed',
		section: 'china',
		matchKeywords: ['china', 'beijing', 'taiwan', 'xi jinping', 'xinjiang', 'tibet'],
	},
	{
		name: 'DW Asia China Focus',
		url: 'https://rss.dw.com/rdf/rss-en-asia',
		section: 'china',
		matchKeywords: ['china', 'beijing', 'taiwan', 'xi jinping', 'xinjiang', 'tibet'],
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
	{
		name: 'SCMP Hong Kong',
		url: 'https://www.scmp.com/rss/2/feed',
		section: 'hongkong',
	},
	{
		name: 'Hong Kong Free Press',
		url: 'https://hongkongfp.com/feed/',
		section: 'hongkong',
	},
	{
		name: 'RTHK English News',
		url: 'https://rthk9.rthk.hk/rthk/news/rss/e_expressnews_elocal.xml',
		section: 'hongkong',
	},
	{
		name: 'The Guardian Hong Kong',
		url: 'https://www.theguardian.com/world/hong-kong/rss',
		section: 'hongkong',
	},
	{
		name: 'Nature',
		url: 'https://www.nature.com/nature.rss',
		section: 'science',
	},
	{
		name: 'BBC Science & Environment',
		url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml',
		section: 'science',
	},
	{
		name: 'The Guardian Science',
		url: 'https://www.theguardian.com/science/rss',
		section: 'science',
	},
	{
		name: 'ScienceDaily Top Science',
		url: 'https://www.sciencedaily.com/rss/top/science.xml',
		section: 'science',
	},
	{
		name: 'Phys.org',
		url: 'https://phys.org/rss-feed/',
		section: 'science',
	},
	{
		// Moved here from `science` 2026-08-25 when the `creation` desk was
		// added — environment/wildlife coverage belongs with the other
		// creation-care sources rather than general lab-and-discovery science.
		name: 'The Guardian Environment',
		url: 'https://www.theguardian.com/environment/rss',
		section: 'creation',
	},
	{
		name: 'The Guardian Wildlife',
		url: 'https://www.theguardian.com/environment/wildlife/rss',
		section: 'creation',
	},
	{
		name: 'Mongabay',
		url: 'https://news.mongabay.com/feed/',
		section: 'creation',
	},
	{
		name: 'Yale Environment 360',
		url: 'https://e360.yale.edu/feed.xml',
		section: 'creation',
	},
	{
		// Broad culture feeds, kept narrow with a documentary keyword
		// filter — same technique as the China desk's BBC/SBS/DW filters
		// above. There is no reliably-alive dedicated documentary trade
		// feed left (RealScreen sits behind a bot challenge), so this
		// reuses outlets already trusted elsewhere in the catalog.
		name: 'The Guardian Film',
		url: 'https://www.theguardian.com/film/rss',
		section: 'documentary',
		matchKeywords: ['documentary', 'docuseries'],
	},
	{
		name: 'The Guardian TV & Radio',
		url: 'https://www.theguardian.com/tv-and-radio/rss',
		section: 'documentary',
		matchKeywords: ['documentary', 'docuseries'],
	},
	{
		// Has never been observed contributing an item. Measured
		// 2026-09-05: 0 of the documentary desk's 10 items on the only
		// edition that has the desk, and absent from that desk's
		// published `sourceNotes`. A direct fetch on the same day with
		// this pipeline's own UA returned 28 healthy items (no 403, no
		// challenge page) containing zero `docu*` word forms of any
		// kind — so it is the keyword filter that never fires, not the
		// feed that is broken.
		//
		// Kept anyway, deliberately. The denominator is ONE edition,
		// not eighty: the 79 archived editions predate this desk. And a
		// same-day probe is demonstrably noisy — IndieWire scored 0 on
		// that same probe while supplying 4 of the 10 live items,
		// because its 12-item feed had already churned past all four
		// (each was published 1–8 days earlier and was gone from the
		// feed by the time it was probed). One zero cannot condemn a
		// feed whose stated job is periodic long-tail coverage; at a
		// true match rate of 2%, P(zero across 28 items) is still ~57%.
		// The feed costs one GET per run and no AI quota, since only
		// items that reach a desk are ever deep-matched.
		//
		// To settle it, measure the base rate over ~30 days of Wayback
		// snapshots rather than one day. Removal is the owner's call.
		name: 'BBC Entertainment & Arts',
		url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
		section: 'documentary',
		matchKeywords: ['documentary', 'docuseries'],
	},
	{
		name: 'IndieWire',
		url: 'https://www.indiewire.com/feed/',
		section: 'documentary',
		matchKeywords: ['documentary', 'docuseries'],
	},
	{
		name: 'BBC Technology',
		url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
		section: 'technology',
	},
	{
		name: 'The Guardian Technology',
		url: 'https://www.theguardian.com/technology/rss',
		section: 'technology',
	},
	{
		name: 'Ars Technica',
		url: 'https://feeds.arstechnica.com/arstechnica/index',
		section: 'technology',
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
// One retry per model in AI_MODEL_CHAIN. Each entry is the backoff
// before the NEXT model is tried, so the chain costs at most
// (chain length - 1) waits. Backoff is short because the thing being
// waited out is usually a per-minute limit; a per-DAY cap is waited
// out by changing model, not by sleeping.
const RETRY_BACKOFF_MS = AI_MODEL_CHAIN.slice(1).map(() => 4000);

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

	// An explicit modelOverride pins a single model (the caller asked for
	// that one specifically); otherwise walk the step-down chain.
	const modelLadder = modelOverride ? [modelOverride] : AI_MODEL_CHAIN;

	const body = {
		model: modelLadder[0],
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
			// Step down to the next model before retrying. Retrying the
			// same model is pointless when the refusal is a per-day cap.
			const nextModel = modelLadder[attempt + 1] ?? body.model;
			const steppedDown = nextModel !== body.model;
			console.warn(
				`Gemini call transient failure (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1}) on ${body.model}: ` +
					`${error.message?.slice(0, 120)}. ` +
					`${steppedDown ? `Stepping down to ${nextModel}` : 'Retrying'} in ${wait}ms.`,
			);
			body.model = nextModel;
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
		textEn: applyPreferredDivineName(corpusVerse.textEn || '', 'en'),
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
		textEn: applyPreferredDivineName(verse.textEn || '', 'en'),
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
		'- whyRelated: ONE English sentence naming the specific fact in THIS story and the verse principle it connects to. If you cannot write that sentence without being vague, you picked the wrong verse — choose again before answering.',
		'- The reflection must anchor to at least one concrete detail from the story (a person, place, event, or number). A reflection that could be pasted under any other headline is a failure.',
		'- Reflection: 2-3 sentences each in English and Simplified Chinese.',
		'- Summary: 1 short paragraph each in English and Simplified Chinese, factual, no opinion.',
		'- titleZh: a faithful Simplified-Chinese rendering of the headline.',
		'- Stay sober, hopeful, pastoral — no political slogans, no triumphalism, no fear-mongering.',
		'- Do not invent facts about the story; restrict yourself to what the title and summary say.',
		'- Divine name: in the Chinese (zh) fields use 雅伟 (not 耶和华); in the English (en) fields use "Yahweh" — NEVER the Chinese 雅伟. The runtime applies a final divine-name pass either way.',
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
		// Body excerpt (when we have one) — the single biggest lever for
		// verse relevance. Without it the model matches on a headline.
		...(item.body && item.body.length >= 120
			? [`body excerpt: ${item.body.slice(0, 700)}`]
			: []),
		'',
		...(diversityNote ? ['EDITORIAL CONSTRAINT', diversityNote, ''] : []),
		'VERSE CATALOG (verseId | reference | themeEn | tags | applies)',
		catalogText,
		'',
		'Reason carefully, then return JSON: { verseId, whyRelated, titleZh, summaryEn, summaryZh, reflectionEn, reflectionZh }.',
	];
	// Body translation is handled by a separate free Google Translate
	// call after this — Gemini doesn't need to see the long body for
	// its pick-a-verse-and-reflect job, and skipping it keeps the
	// prompt small (~25% smaller -> faster + uses less daily quota).
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
						whyRelated: { type: 'string' },
						titleZh: { type: 'string' },
						summaryEn: { type: 'string' },
						summaryZh: { type: 'string' },
						reflectionEn: { type: 'string' },
						reflectionZh: { type: 'string' },
					},
					required: [
						'verseId',
						'whyRelated',
						'titleZh',
						'summaryEn',
						'summaryZh',
						'reflectionEn',
						'reflectionZh',
					],
					additionalProperties: false,
				},
			},
			// 90s — Gemini is doing the slim verse-pick + summarise
			// + reflect job now; body translation is handled by a
			// separate free Google Translate call.
			90000,
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
		const summaryEn = trimText(applyPreferredDivineName(cleanText(parsed.summaryEn || ''), 'en'), 320) || null;
		const summaryZh = trimText(applyPreferredDivineName(cleanText(parsed.summaryZh || '')), 160) || null;
		const reflectionEn = trimText(applyPreferredDivineName(cleanText(parsed.reflectionEn || ''), 'en'), 360) || null;
		const reflectionZh = trimText(applyPreferredDivineName(cleanText(parsed.reflectionZh || '')), 180) || null;
		// Body translation is filled by the free Google Translate
		// pass downstream, not by Gemini. Always null here.
		const bodyZh = null;

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

		console.log(
			`Deep-match for "${item.title.slice(0, 60)}": ${verse.id} (${verse.reference})` +
				(parsed.whyRelated ? ` — ${String(parsed.whyRelated).slice(0, 140)}` : ''),
		);

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
				textEn: applyPreferredDivineName(cachedItem.verse.textEn || '', 'en'),
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

	if (existingData?.editionDate && existingData.editionDate !== editionDate) {
		await archiveOutgoingEdition(existingData);
		await pruneOldArchives();
	}

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

	// Sections are built one after another and the AI budget is spent as
	// we go, so whichever desk sorts last is the one that runs on keyword
	// fallback. That was measurable on 2026-08-25: coverage tracked
	// processing position exactly — world/china/australia 100%, then
	// science 2/26, technology 1/18, creation 3/18. A fixed order doesn't
	// ration a scarce budget, it just always starves the same desks.
	//
	// Rotating the start point spreads the shortfall: each desk leads
	// every eighth run and no desk is permanently last. The offset
	// advances once per 4-hour window (matching the cron) rather than
	// being derived from the hour of day, so it walks through all eight
	// positions instead of landing on the same two or three.
	const orderedSectionIds = rotateSectionOrder(Object.keys(sectionMeta), now);
	console.log(`Section order this run: ${orderedSectionIds.join(' > ')}`);

	for (const sectionId of orderedSectionIds) {
		const sectionItems = rawItems
			.filter((item) => item.section === sectionId)
			.sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));

		const uniqueItems = dedupeStories(sectionItems);
		const targetCount = determineTargetCount(uniqueItems, editionDate, {
			maxItems: sectionMeta[sectionId].maxItems,
		});
		const selectedItems = selectBalancedItems(uniqueItems, targetCount);
		const fallbackSection = existingData?.sections?.[sectionId];
		const shouldUseCache = selectedItems.length === 0 && fallbackSection?.items?.length;

		if (!shouldUseCache && selectedItems.length === 0) {
			// A brand-new section (no cache yet) whose feeds all failed this
			// run should not take down the whole refresh — skip it and let
			// the next cron try again. Established sections keep the loud
			// failure via the cache branch above.
			console.error(`Section "${sectionId}" ended up empty and no cached content was available — skipping this run.`);
			continue;
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
			categoryLabel: sectionMeta[sectionId].categoryLabel,
			sourceNotes,
			items: mergedStories,
		};
	}

	// Re-key in canonical (sectionMeta) order. The build loop above runs
	// in rotated order, and without this the JSON's section keys would
	// reshuffle every run — turning each refresh into a whole-file diff
	// and making real content changes impossible to spot in git.
	const canonicalSections = {};
	for (const sectionId of Object.keys(sectionMeta)) {
		if (builtSections[sectionId]) {
			canonicalSections[sectionId] = builtSections[sectionId];
		}
	}
	for (const [sectionId, section] of Object.entries(builtSections)) {
		if (!canonicalSections[sectionId]) canonicalSections[sectionId] = section;
	}

	// 2026-05-11: defensive pre-write pass. Even with sanitizeLink()
	// at scrape time, a downstream transform (deep-match merge with
	// stale cache, body re-fetch, image scrape, …) could
	// theoretically resurrect a bad link from a previous snapshot.
	// Run a final `format: uri`-equivalent check on every story's
	// `link` field; drop any that fail rather than letting one bad
	// item kill the whole hourly refresh via downstream schema
	// validation. Logs the drop so the failure is visible in CI.
	let prewriteDrops = 0;
	for (const sectionId of Object.keys(canonicalSections)) {
		const before = canonicalSections[sectionId].items.length;
		canonicalSections[sectionId].items = canonicalSections[sectionId].items.filter(
			(story) => {
				if (sanitizeLink(story.link) != null) return true;
				console.warn(
					`Pre-write drop: ${sectionId}/${story.id} ` +
					`has unrecoverable link: ${JSON.stringify(story.link)}`,
				);
				return false;
			},
		);
		const dropped = before - canonicalSections[sectionId].items.length;
		prewriteDrops += dropped;
	}
	if (prewriteDrops > 0) {
		console.warn(
			`Pre-write filter dropped ${prewriteDrops} story(ies) with bad links.`,
		);
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
		sections: canonicalSections,
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

// 2026-07-22: daily archive for infinite-scroll consumers. Every run
// overwrites data/daily_news.json in place (the "live" edition) and
// always has done — this never retained history. When the computed
// editionDate rolls past whatever was previously live, snapshot that
// outgoing edition into data/archive/{date}.json before it's lost,
// and keep data/archive/index.json (newest first) so a client can
// discover what's available without a directory listing (static
// hosting can't provide one). Idempotent: re-running on the same day
// after the rollover already happened is a no-op.
async function readArchiveIndex() {
	try {
		const raw = await fs.readFile(archiveIndexPath, 'utf8');
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed?.dates) ? parsed.dates : [];
	} catch {
		return [];
	}
}

async function writeArchiveIndex(dates) {
	const payload = { updatedAt: new Date().toISOString(), dates };
	await fs.writeFile(
		archiveIndexPath,
		`${JSON.stringify(payload, null, 2)}\n`,
		'utf8',
	);
}

// Pure: merge a newly-archived date into the existing index, deduped
// and sorted newest-first. YYYY-MM-DD strings sort correctly with
// plain string comparison. Exported for unit testing.
export function mergeArchiveDates(newDate, existingDates) {
	return Array.from(new Set([newDate, ...existingDates])).sort(
		(a, b) => (a < b ? 1 : a > b ? -1 : 0),
	);
}

// Pure: split archive dates into {kept, pruned} against a retention
// cutoff (YYYY-MM-DD, exclusive — dates before it are pruned).
// Exported for unit testing.
export function partitionArchiveDates(dates, cutoffDateStr) {
	const kept = [];
	const pruned = [];
	for (const date of dates) {
		(date < cutoffDateStr ? pruned : kept).push(date);
	}
	return { kept, pruned };
}

async function archiveOutgoingEdition(outgoingPayload) {
	const date = outgoingPayload?.editionDate;
	if (!date) return;

	await fs.mkdir(archiveDir, { recursive: true });
	const archivePath = path.join(archiveDir, `${date}.json`);

	let alreadyArchived = false;
	try {
		await fs.access(archivePath);
		alreadyArchived = true;
	} catch {
		// doesn't exist yet — proceed
	}

	if (!alreadyArchived) {
		await fs.writeFile(
			archivePath,
			`${JSON.stringify(outgoingPayload, null, 2)}\n`,
			'utf8',
		);
		console.log(`Archived outgoing edition ${date} -> data/archive/${date}.json`);
	}

	const existingDates = await readArchiveIndex();
	await writeArchiveIndex(mergeArchiveDates(date, existingDates));
}

async function pruneOldArchives() {
	const dates = await readArchiveIndex();
	if (dates.length === 0) return;

	const cutoff = new Date();
	cutoff.setUTCDate(cutoff.getUTCDate() - ARCHIVE_RETENTION_DAYS);
	const cutoffStr = getSydneyDateString(cutoff);

	const { kept, pruned } = partitionArchiveDates(dates, cutoffStr);
	for (const date of pruned) {
		try {
			await fs.unlink(path.join(archiveDir, `${date}.json`));
		} catch {
			// already gone — fine
		}
	}

	if (pruned.length > 0) {
		await writeArchiveIndex(kept);
		console.log(`Pruned ${pruned.length} archive(s) older than ${ARCHIVE_RETENTION_DAYS} days.`);
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

		// 2026-05-11: sanitise the article link FIRST so a single
		// malformed `<link>` from the source can't poison the
		// downstream schema validation. Stories with no salvageable
		// link are dropped — falling back to the feed URL would mis-
		// lead readers (the feed URL isn't an article URL). Most
		// feeds are clean; this defends against the long tail.
		const cleanItems = [];
		let droppedBadLinks = 0;
		for (const item of feed.items ?? []) {
			const link = sanitizeLink(item.link, source.url);
			if (!link) {
				droppedBadLinks++;
				continue;
			}
			const title = cleanText(item.title || 'Untitled story');
			const summary = deriveSummary(item);
			const body = deriveBody(item);
			const enclosureUrl = extractEnclosureImage(item);

			cleanItems.push({
				id: slugify(link || item.guid || item.title || `${source.section}-${Math.random()}`),
				section: source.section,
				source: source.name,
				sourceUrl: source.url,
				link,
				title,
				summary,
				body,
				enclosureUrl,
				publishedAt: normalizeDate(item.isoDate || item.pubDate),
			});
		}
		if (droppedBadLinks > 0) {
			console.warn(
				`Feed ${source.name}: dropped ${droppedBadLinks} item(s) with unparseable links.`,
			);
		}
		return cleanItems.filter((item) => matchesSourceFilter(source, item));
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

/// Rotate the section build order so no desk is permanently last.
///
/// The AI budget is consumed as sections are built, so with a fixed
/// order the trailing desks always fall back to keyword matching. The
/// offset advances once per 4-hour window — matching the cron cadence —
/// so consecutive runs lead with different desks and every desk reaches
/// the front over eight runs.
///
/// Deliberately derived from absolute time rather than hour-of-day: with
/// a 4-hourly cron, `hour % 8` only ever yields two distinct offsets, so
/// six of the eight desks would never lead.
export function rotateSectionOrder(sectionIds, now = new Date()) {
	if (!Array.isArray(sectionIds) || sectionIds.length === 0) return [];
	const windowsSinceEpoch = Math.floor(now.getTime() / (4 * 60 * 60 * 1000));
	const len = sectionIds.length;
	const offset = ((windowsSinceEpoch % len) + len) % len;
	return [...sectionIds.slice(offset), ...sectionIds.slice(0, offset)];
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

/// Fetch the article HTML and extract the readable body. Used as a
/// fallback for RSS feeds that don't carry <content:encoded> (BBC,
/// DW, SBS headline tickers).
///
/// Heuristic, in order:
///   1. Look for <article>...</article> — most modern news sites
///      wrap their body in one. Use its inner HTML.
///   2. Else look for <main>...</main>.
///   3. Else fall back to the whole HTML with structural nav/aside
///      stripped.
/// Then extract <p> tags from that container, filter out paragraphs
/// shorter than 80 chars (caption / nav-link / CTA), and concatenate
/// up to 2800 chars total. Returns null when nothing usable extracted.
async function fetchArticleBody(url) {
	if (!url) return null;
	try {
		const response = await fetch(url, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (compatible; DailyMannaDispatchBot/1.0; +https://yswords.netlify.app)',
				Accept:
					'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				'Accept-Language': 'en-US,en;q=0.9',
			},
			signal: AbortSignal.timeout(20000),
		});
		if (!response.ok) return null;
		const html = await response.text();

		// Drop genuinely-noisy elements that pollute even the article
		// container on most news sites.
		const stripped = html
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
			.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
			.replace(/<form[\s\S]*?<\/form>/gi, ' ')
			.replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
			.replace(/<figcaption[\s\S]*?<\/figcaption>/gi, ' ');

		// Narrow to the article container.
		let scope = '';
		const article = stripped.match(/<article[\s\S]*?<\/article>/i);
		if (article) {
			scope = article[0];
		} else {
			const main = stripped.match(/<main[\s\S]*?<\/main>/i);
			if (main) {
				scope = main[0];
			} else {
				// No article/main tag — strip nav/header/footer/aside
				// from the whole page and use the rest.
				scope = stripped
					.replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
					.replace(/<header[\s\S]*?<\/header>/gi, ' ')
					.replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
					.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
			}
		}

		const paragraphRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
		const paragraphs = [];
		let m;
		while ((m = paragraphRe.exec(scope)) !== null) {
			const para = cleanText(m[1] || '');
			// Real article paragraphs are almost always 80+ chars.
			// Below that we get captions, social-share buttons,
			// "Sign up to our newsletter" CTAs, "Read also:" stubs.
			if (para.length < 80) continue;
			// Reject paragraphs that look like nav menu joins
			// (lots of capitalised words, no sentence punctuation).
			const punctRatio =
				(para.match(/[.!?。！？]/g) || []).length / Math.max(para.length / 80, 1);
			if (punctRatio < 0.4 && para.length < 200) continue;
			paragraphs.push(para);
		}
		if (paragraphs.length === 0) return null;
		const joined = paragraphs.join('\n\n');
		return trimText(joined, 2800) || null;
	} catch (error) {
		return null;
	}
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
		// Tolerant extractor: find every <meta ...> tag whose attributes
		// reference og:image (or twitter:image as a fallback), then pull
		// the `content` attribute regardless of its position relative to
		// `property`/`name`. The naive "property X, then content Y"
		// regex misses any feed that interleaves extra attributes — DW
		// emits `<meta data-rh="true" content="…" property="og:image"/>`,
		// which broke both legacy patterns and left every DW article
		// imageless.
		const metaTagRe = /<meta\b[^>]*>/gi;
		const tags = html.match(metaTagRe) || [];
		const pickContent = (tag) => {
			const m = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i);
			return m ? m[1] : null;
		};
		const matchesTarget = (tag, target) => {
			const m = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i);
			return m && m[1].toLowerCase() === target;
		};
		// 1st choice: og:image. 2nd: twitter:image (twitter:image:src).
		for (const target of ['og:image', 'twitter:image', 'twitter:image:src']) {
			for (const tag of tags) {
				if (matchesTarget(tag, target)) {
					const content = pickContent(tag);
					if (content && /^https?:\/\//i.test(content)) {
						return content;
					}
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}

// Some source CDNs send `Access-Control-Allow-Origin: null` on their
// images — an explicit deny, not just a missing header — which blocks
// Flutter Web's CanvasKit renderer from decoding them (it needs a real
// CORS grant to fetch the bytes, unlike a plain <img> tag). Confirmed for
// assets.sbs.com.au (2026-07-22): ~1/3 of all article images are SBS,
// so this silently broke a third of the feed's photos. Fix mirrors the
// bytes into our own CDN (same pattern already used for Bible Evidence
// images in /images/evidence/*, which carries a wide-open CORS header).
const CORS_RESTRICTED_SOURCE_PATTERN = /SBS/i;

async function mirrorImageForCors(item, imageUrl) {
	try {
		const response = await fetch(imageUrl, {
			headers: { 'User-Agent': 'DailyMannaDispatchBot/1.0' },
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) return null;
		const buffer = Buffer.from(await response.arrayBuffer());
		const extMatch = imageUrl.match(/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i);
		const ext = (extMatch?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
		const filename = `${item.id}.${ext}`;
		await fs.mkdir(newsImageDir, { recursive: true });
		await fs.writeFile(path.join(newsImageDir, filename), buffer);
		return `https://yswords-data.netlify.app/images/news/${filename}`;
	} catch (error) {
		console.warn(`Image mirror failed for "${item.title.slice(0, 50)}": ${error.message}`);
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

	// 2. Body backfill from article HTML.  Many feeds (BBC, DW, SBS
	//     headline tickers) ship a short summary in their RSS but no
	//     <content:encoded> long form. For those we hit the article
	//     URL and extract paragraphs via fetchArticleBody. Only runs
	//     when the RSS body is absent — Guardian feeds already carry
	//     the long form so we don't waste a request on them.
	//
	//     2026-08-23: moved ABOVE the deep-match call. Previously the
	//     verse pick ran first and only ever saw the title + a one-line
	//     RSS summary, which produced loosely-related verse choices.
	//     Fetching the body first lets aiDeepMatch quote an excerpt of
	//     the actual article to the model.
	if (
		(!item.body || item.body.length < 60) &&
		item.link &&
		process.env.NEWS_FETCH_ARTICLE_BODY !== 'off'
	) {
		const fetched = await fetchArticleBody(item.link);
		if (fetched && fetched.length >= 200) {
			item.body = fetched;
			console.log(
				`Fetched body for "${item.title.slice(0, 60)}" (${fetched.length} chars)`,
			);
		}
	}

	// 2a. No cache → run the deep-think AI call. Pass the verses already
	//    used by previous stories in this same section as a soft-diversity
	//    hint so a section doesn't end up with five "Romans 12:21" entries.
	if (!deep) {
		const used = sectionUsedVerseIds?.get(item.section) || [];
		deep = await aiDeepMatch(item, verseCorpus, used);
		await delay(AI_CALL_DELAY_MS);
	}

	// 2b. Body translation via the free Google Translate web endpoint
	//     (no API key, no quota). DECOUPLED from `deep`: even when
	//     Gemini's quota is exhausted and the deep-match falls
	//     through to the keyword classifier (deep === null), we
	//     still want body translation to fire — it's free.
	//
	//     Override:
	//       NEWS_TRANSLATE_BODY=ai  → use Gemini (paid key required)
	//       NEWS_TRANSLATE_BODY=off → skip translation entirely
	//       (default)               → use the free Google endpoint
	let bodyZhResolved = deep?.bodyZh || null;
	if (!bodyZhResolved && item.body && item.body.length >= 60) {
		const mode = (process.env.NEWS_TRANSLATE_BODY || 'free').toLowerCase();
		if (mode !== 'off') {
			let translated = null;
			if (mode === 'ai') {
				translated = await aiTranslateBodyToZh(item.body);
				await delay(AI_CALL_DELAY_MS);
			} else {
				// Free Google Translate path. No quota; small polite
				// delay between calls so we don't hammer.
				translated = await freeTranslateToZh(item.body, 'body');
				await delay(300);
			}
			if (translated) {
				bodyZhResolved =
					applyPreferredDivineName(translated).slice(0, 2800);
			}
		}
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

	if (imageUrl && CORS_RESTRICTED_SOURCE_PATTERN.test(item.source || '')) {
		const mirrored = await mirrorImageForCors(item, imageUrl);
		if (mirrored) imageUrl = mirrored;
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
			en: applyPreferredDivineName(deep?.summaryEn ?? fallbackCopy.summary.en, 'en'),
			zh: applyPreferredDivineName(deep?.summaryZh ?? fallbackCopy.summary.zh),
		},
		// Long-form article body for the in-app detail-page reader.
		// `en` is either the cleaned RSS content:encoded text or the
		// HTML-fetched fallback (~2800 chars max). `zh` comes from
		// the free Google Translate pass — independent of Gemini
		// quota so the bilingual body holds even on a quota-exhausted
		// day.
		body: {
			en: item.body || null,
			zh: bodyZhResolved,
		},
		reflection: {
			en: applyPreferredDivineName(deep?.reflectionEn ?? fallbackCopy.reflection.en, 'en'),
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
			summaryEn: trimText(applyPreferredDivineName(cleanText(parsed.summaryEn || ''), 'en'), 280) || null,
			summaryZh: trimText(applyPreferredDivineName(cleanText(parsed.summaryZh || '')), 140) || null,
			reflectionEn: trimText(applyPreferredDivineName(cleanText(parsed.reflectionEn || ''), 'en'), 280) || null,
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
	return freeTranslateToZh(value, 'title');
}

/// Free Google Translate via the public web endpoint
/// `translate.googleapis.com/translate_a/single`. No API key, no
/// quota — same path the title translator already uses, just
/// extracted so the body translator (long form) can share it.
///
/// Length: the endpoint accepts ~5000 chars per request. Body texts
/// are capped at 2800 chars upstream so a single call covers them.
/// On failure (rate-limited, network, malformed response) we return
/// null and the caller falls back gracefully.
// Free-translation providers, tried in order. No API key, no quota.
//
// 2026-08-24: `translate.googleapis.com` with client=gtx started
// answering 429 to everything — from GitHub Actions AND from a plain
// residential IP — which silently cost ~90% of stories their Chinese
// body (only 3 of 72 had body.zh). The Chrome-extension endpoint on
// clients5 still serves the same translations, handles the full
// 2800-char body in one call, and tolerates back-to-back requests;
// MyMemory is a slower, differently-hosted last resort so a single
// provider outage can't blank the Chinese again.
const FREE_TRANSLATE_PROVIDERS = [
	{
		name: 'clients5',
		async translate(text) {
			const url = new URL('https://clients5.google.com/translate_a/t');
			url.searchParams.set('client', 'dict-chrome-ex');
			url.searchParams.set('sl', 'en');
			url.searchParams.set('tl', 'zh-CN');
			url.searchParams.set('q', text);
			const response = await fetch(url, {
				headers: {
					'User-Agent':
						'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
					Accept: 'application/json, text/plain, */*',
				},
				signal: AbortSignal.timeout(45000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return extractClients5Text(await response.json());
		},
	},
	{
		name: 'googleapis-gtx',
		async translate(text) {
			const url = new URL('https://translate.googleapis.com/translate_a/single');
			url.searchParams.set('client', 'gtx');
			url.searchParams.set('sl', 'en');
			url.searchParams.set('tl', 'zh-CN');
			url.searchParams.set('dt', 't');
			url.searchParams.set('q', text);
			const response = await fetch(url, {
				headers: {
					'User-Agent': 'DailyMannaDispatchBot/1.0',
					Accept: 'application/json, text/plain, */*',
				},
				signal: AbortSignal.timeout(45000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return extractTranslatedText(await response.json());
		},
	},
	{
		name: 'mymemory',
		// Caps at 500 chars per call for anonymous use, so long bodies
		// go through in chunks split on sentence boundaries.
		maxChunk: 480,
		async translate(text) {
			const url = new URL('https://api.mymemory.translated.net/get');
			url.searchParams.set('q', text);
			url.searchParams.set('langpair', 'en|zh-CN');
			const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			const out = payload?.responseData?.translatedText;
			return typeof out === 'string' && out.trim() ? out : null;
		},
	},
];

export function extractClients5Text(payload) {
	// dict-chrome-ex answers either ["text"] or [["seg"],["seg"]].
	if (typeof payload === 'string') return payload;
	if (!Array.isArray(payload)) return null;
	const parts = payload
		.map((entry) => (Array.isArray(entry) ? entry[0] : entry))
		.filter((entry) => typeof entry === 'string');
	return parts.length ? parts.join('') : null;
}

export function chunkForTranslation(text, limit) {
	if (text.length <= limit) return [text];
	const chunks = [];
	let current = '';
	// Split on sentence ends first so a chunk boundary doesn't land
	// mid-clause and produce two half-translated fragments.
	for (const piece of text.split(/(?<=[.!?])\s+/)) {
		if ((current + ' ' + piece).trim().length > limit) {
			if (current) chunks.push(current.trim());
			current = piece.length > limit ? piece.slice(0, limit) : piece;
		} else {
			current = current ? `${current} ${piece}` : piece;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}

async function freeTranslateToZh(text, label = 'text') {
	if (!text) return null;
	const trimmed = String(text).trim();
	if (!trimmed) return null;
	if (containsCjk(trimmed)) return cleanText(trimmed) || null;

	const source = trimmed.slice(0, 4900);
	const failures = [];

	for (const provider of FREE_TRANSLATE_PROVIDERS) {
		// One retry per provider: these endpoints fail transiently far
		// more often than they fail for good.
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const chunks = provider.maxChunk
					? chunkForTranslation(source, provider.maxChunk)
					: [source];
				const out = [];
				for (const chunk of chunks) {
					const piece = await provider.translate(chunk);
					if (!piece) throw new Error('empty response');
					out.push(piece);
					if (chunks.length > 1) await delay(400);
				}
				const joined = cleanText(out.join('')) || null;
				if (!joined) throw new Error('empty after clean');
				if (provider !== FREE_TRANSLATE_PROVIDERS[0]) {
					console.log(`Free translate for ${label} via fallback provider ${provider.name}.`);
				}
				return joined;
			} catch (error) {
				failures.push(`${provider.name}${attempt ? '(retry)' : ''}: ${error.message}`);
				if (attempt === 0) await delay(1200);
			}
		}
	}

	console.warn(`Free translate failed for ${label} — ${failures.join('; ')}`);
	return null;
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

export function applyPreferredDivineName(value, lang = 'zh') {
	const s = String(value || '');
	if (lang === 'en') {
		// English copy must read "Yahweh". Collapse the LORD/Lord forms AND
		// strip any Chinese divine name the model leaked into English text:
		// the verse prompt asks for 雅伟, which sometimes bleeds into the
		// English reflection / verse, leaving 雅伟 in the en fields.
		return s
			.replace(/\bthe LORD\b/g, 'Yahweh')
			.replace(/\bThe LORD\b/g, 'Yahweh')
			.replace(/\bthe Lord\b/g, 'Yahweh')
			.replace(/\bThe Lord\b/g, 'Yahweh')
			.replace(/耶和華|耶和华/g, 'Yahweh')
			.replace(/雅偉|雅伟|雅威/g, 'Yahweh');
	}
	// Chinese copy: prefer the 雅伟版 rendering of the divine name.
	return s
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

/**
 * 2026-05-11: defensive URL sanitiser. RSS feeds occasionally
 * publish stories whose `<link>` tag is malformed (whitespace,
 * relative path, missing scheme, custom scheme like `feed:`,
 * etc.). The downstream JSON Schema validation requires
 * `format: uri` which ajv-formats clamps to RFC 3986 absolute
 * http(s) URIs — anything else fails validation and the entire
 * hourly refresh aborts (one bad story poisons the file). This
 * helper:
 *
 *   1. Trims whitespace and rejects empty input.
 *   2. Tries `new URL(raw)`; if that fails AND a `baseUrl` is
 *      given, retries `new URL(raw, baseUrl)` so relative paths
 *      resolve against the feed origin (e.g. `/news/foo` →
 *      `https://feed-host.com/news/foo`).
 *   3. Requires an `http:` or `https:` scheme on the result —
 *      `mailto:`, `feed:`, `javascript:` etc. are dropped because
 *      they're not useful as article links anyway.
 *   4. Returns the canonical `url.href` (which is RFC-3986-clean,
 *      with proper percent-encoding) on success, or `null` on
 *      failure.
 *
 * Callers should DROP items whose `sanitizeLink(...)` returns
 * `null` rather than substitute the feed URL — the feed URL
 * isn't the article URL, so a fallback would mislead readers.
 *
 * Exported for unit testing.
 */
export function sanitizeLink(value, baseUrl = null) {
	if (value == null) return null;
	const raw = String(value).trim();
	if (!raw) return null;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		if (baseUrl) {
			try {
				parsed = new URL(raw, baseUrl);
			} catch {
				return null;
			}
		} else {
			return null;
		}
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return null;
	}
	// `new URL(...).href` produces a normalised, percent-encoded
	// absolute URL that satisfies ajv-formats' `format: uri`.
	return parsed.href;
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
