#!/usr/bin/env node
/*
 * Coin Scanner v6 — daily list of NEW undervalued, exchange-listed small caps,
 * plus a Tracking list of every coin it has ever picked (kept forever).
 * Separate project from the copy trader. Uses only free data sources.
 *
 * Run:   node scanner.js            (full daily run, posts to GitHub)
 *        node scanner.js --quick    (small test run, saves nothing to history)
 *        node scanner.js --no-push  (don't post to GitHub, just write files locally)
 *        node scanner.js --dashboard-only  (just upload dashboard.html as the web page)
 *
 * v6.1: "newly listed" / "no longer on" come from an exchange ledger (every exchange ever seen per coin),
 * so old listings that slip back into CoinGecko's top-100 pair list no longer count as new.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const STATE_PATH = path.join(ROOT, 'data', 'state.json');
const PICKS_PATH = path.join(ROOT, 'data', 'picks.json');
const OUT_DIR = path.join(ROOT, 'output');
const CG_BASE = 'https://api.coingecko.com/api/v3';

const DEFAULT_SETTINGS = {
  maxMarketPages: 80,          // 250 coins per page
  minVolumeUsd: 20000,         // below this you can't really get in and out
  maxVolumeToMcap: 2.5,        // daily trading bigger than this x market cap looks faked
  minMcapToFdv: 0.25,          // under 25% of tokens released = big unlock overhang, toss
  shortlistSize: 120,          // coins that get the deep check each day
  finalListSize: 20,           // coins on the daily list (used only when sizeBands is empty)
  // Size bands: the best coins in each band make the list, so bigger coins aren't crowded out
  // by the small-cap bonus. Coins above the last band's max are skipped. Set sizeBands to [] to turn off.
  sizeBands: [
    { name: 'Micro', max: 10e6 },
    { name: 'Small', max: 50e6 },
    { name: 'Mid', max: 250e6 },
    { name: 'Large', max: 1e9 },
  ],
  perBandShortlist: 30,        // deep checks per band
  perBandFinal: 8,             // coins per band on the daily list
  // Signs of life (GitHub pushes + Telegram posts + website)
  aliveCodeDays: 30,
  aliveSocialDays: 14,
  zombieCodeDays: 90,
  zombieSocialDays: 60,
  deadDays: 180,
  aliveBonus: 4,
  zombiePenalty: 12,
  maxCategoryFetchesPerRun: 25,
  categoryCacheDays: 7,
  secondsBetweenCalls: 2.5,    // stays well under the free rate limit
  telegramStaleDays: 30,
  monthlyCallBudget: 10000,
  // Sectors: matched against CoinGecko's category names (whole words, not case-sensitive)
  excludeSectors: ['Meme', 'Pump.fun Ecosystem'],
  preferSectors: [],
  preferSectorBoost: 8,
  // Your limits (null or 0 = off)
  maxMarketCap: null,
  minMarketCap: null,
  minCommunity: 0,
  // Potential multiple: target price = all-time high x this factor
  athTargetMultiplier: 2.5,
  extremeMultiple: 100,
  sectorListRefreshDays: 3,
  maxSectorPages: 20,
  // ---- v6: Tracking (every coin ever picked is kept and watched for changes) ----
  trackRechecksPerDay: 15,     // deep re-checks of changed tracked coins per day (costs ~1-2 CoinGecko calls each)
  trackRotatePerDay: 5,        // plus this many routine re-checks of the tracked coins checked longest ago (catches quiet new listings)
  trackRotateMinDays: 14,      // a routine re-check only happens if the last deep check is at least this old
  trackRecheckCooldownDays: 3, // don't deep re-check the same coin more often than this
  trackVolumeJump: 3,          // trading at this many x its normal level = "changed"
  trackPriceMove24h: 25,       // price move of this % in a day = "changed"
  trackPriceMove7d: 50,        // price move of this % in a week = "changed"
  trackRankClimbPct: 15,       // climbed this % in the size ranking over ~5 days = "changed"
  comebackScoreJump: 15,       // score this much higher than when first picked = back on the New list
  maxComebacksPerBand: 4,      // at most this many "back on the radar" coins per band; the rest of the band is fresh coins
  trackNotesKept: 12,          // change notes kept per tracked coin
  // ---- Exchange listings (v6.1): "new" means never seen on that exchange before, not "missing yesterday" ----
  listingMinChecks: 2,         // need at least this many earlier deep checks of a coin before calling anything a new listing
  listingMinHistoryDays: 5,    // ...spread over at least this many days
  listingWaveDays: 14,         // when CoinGecko starts covering an exchange, it appears as "new" on many coins at once:
  listingWaveCoins: 3,         // an exchange that shows up as new on this many coins within listingWaveDays is ignored
  delistMisses: 2,             // an exchange has to be missing this many full checks in a row before "no longer on"
};

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayStr = () => (process.env.SCAN_DATE || new Date().toISOString().slice(0, 10)); // SCAN_DATE is for testing only
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function median(arr) {
  const a = arr.filter((x) => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function fmtUsd(n) {
  if (n == null || !isFinite(n)) return 'n/a';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${Number(n.toPrecision(3))}`;
}
const fmtPct = (n) => (n == null || !isFinite(n) ? 'n/a' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
const fmtNum = (n) => (n == null ? 'n/a' : Number(n).toLocaleString('en-US'));
const fmtX = (x) => (x == null || !isFinite(x) ? 'n/a' : x >= 100 ? `${Math.round(x).toLocaleString('en-US')}x` : `${x.toFixed(1)}x`);
const round = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const sig = (n) => (n == null || !isFinite(n) ? null : Number(Number(n).toPrecision(6)));

// Rafael's rule of thumb: a coin can plausibly reach about 2.5x its old all-time high.
function potentialOf(c, s) {
  const ath = c.ath, price = c.current_price;
  if (!(ath > 0) || !(price > 0)) return null;
  const factor = s.athTargetMultiplier || 2.5;
  const x = (ath * factor) / price;
  return {
    ath, athDate: c.ath_date ? String(c.ath_date).slice(0, 10) : null, factor,
    targetPrice: ath * factor, x, targetMcap: c.market_cap > 0 ? c.market_cap * x : null,
    // Market cap at the ATH price with today's circulating supply (CoinGecko's free plan has no market-cap history
    // that far back). If many tokens were released since the peak, the real ATH market cap was lower.
    athMcap: c.market_cap > 0 ? c.market_cap * (ath / price) : null,
    athX: ath / price, // plain "back to ATH" multiple
    extreme: x > (s.extremeMultiple || 100),
  };
}

// ---------- signs of life ----------
function parseGithub(url) {
  const m = String(url || '').match(/github\.com\/([^/?#\s]+)(?:\/([^/?#\s]+))?/i);
  if (!m) return null;
  let owner = m[1], repo = m[2] ? m[2].replace(/\.git$/i, '') : null;
  if (/^orgs$/i.test(owner) && repo) { owner = repo; repo = null; }
  if (/^(orgs|topics|sponsors|features|marketplace)$/i.test(owner)) return null;
  return { owner, repo };
}

async function githubLastPush(urls, cfg, ctx) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'coin-scanner' };
  if (cfg.githubToken && !cfg.githubToken.includes('PASTE')) headers.authorization = `Bearer ${cfg.githubToken}`;
  let best = null;
  for (const u of (urls || []).filter(Boolean).slice(0, 3)) {
    const g = parseGithub(u);
    if (!g) continue;
    const key = `${g.owner}/${g.repo || ''}`.toLowerCase();
    let hit = ctx.ghCache.get(key);
    if (hit === undefined) {
      hit = null;
      try {
        if (g.repo) {
          const r = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}`, { headers });
          if (r.ok) { const j = await r.json(); if (j.pushed_at) hit = { at: j.pushed_at.slice(0, 10), url: j.html_url }; }
        } else {
          const r = await fetch(`https://api.github.com/users/${g.owner}/repos?sort=pushed&per_page=1`, { headers });
          if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j[0] && j[0].pushed_at) hit = { at: j[0].pushed_at.slice(0, 10), url: j[0].html_url }; }
        }
      } catch { hit = null; }
      ctx.ghCache.set(key, hit);
    }
    if (hit && (!best || hit.at > best.at)) best = hit;
  }
  return best;
}

function lifeStatus(sig2, s) {
  const known = [sig2.codeDays, sig2.tgDays].filter((d) => d != null);
  const lastSignDays = known.length ? Math.min(...known) : null;
  let status;
  if (!known.length) status = 'unknown';
  else if ((sig2.codeDays != null && sig2.codeDays <= s.aliveCodeDays) || (sig2.tgDays != null && sig2.tgDays <= s.aliveSocialDays)) status = 'alive';
  else if (sig2.site === 'dead' && known.every((d) => d >= s.deadDays)) status = 'dead';
  else if ((sig2.codeDays == null || sig2.codeDays >= s.zombieCodeDays) && (sig2.tgDays == null || sig2.tgDays >= s.zombieSocialDays)) status = 'zombie';
  else status = 'quiet';
  return { status, lastSignDays };
}

function bandOf(mcap, bands) {
  if (!Array.isArray(bands) || !bands.length || !(mcap > 0)) return null;
  const b = bands.find((x) => mcap < x.max);
  return b ? b.name : null;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('Missing config.json. Copy config.example.json to config.json and fill in your keys.');
    process.exit(1);
  }
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg) { console.error('config.json is not valid JSON. Check for a missing comma or quote.'); process.exit(1); }
  if (!cfg.coingeckoApiKey || cfg.coingeckoApiKey.includes('PASTE')) {
    console.error('Put your CoinGecko Demo key in config.json (coingeckoApiKey).'); process.exit(1);
  }
  cfg.settings = { ...DEFAULT_SETTINGS, ...(cfg.settings || {}) };
  return cfg;
}

// ---------- CoinGecko ----------
let cgCalls = 0;
let lastCgCall = 0;
async function cg(pathAndQuery, cfg) {
  const url = CG_BASE + pathAndQuery;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = lastCgCall + cfg.settings.secondsBetweenCalls * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCgCall = Date.now();
    cgCalls++;
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json', 'x-cg-demo-api-key': cfg.coingeckoApiKey } });
    } catch (e) {
      log(`Network error (${pathAndQuery}): ${e.message}`);
      await sleep(10000 * attempt);
      continue;
    }
    if (res.status === 429) { log('CoinGecko says slow down — waiting 65 seconds'); await sleep(65000); continue; }
    if (res.status === 401 || res.status === 403) throw new Error('CoinGecko rejected the API key. Check coingeckoApiKey in config.json.');
    if (res.status === 404) return null;
    if (!res.ok) { log(`CoinGecko error ${res.status} (${pathAndQuery})`); await sleep(5000 * attempt); continue; }
    return res.json();
  }
  throw new Error(`CoinGecko request kept failing: ${pathAndQuery}`);
}

// ---------- plain web fetch (websites, Telegram) ----------
async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (coin-scanner)' } });
    const text = await res.text();
    return { status: res.status, text };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(t);
  }
}

async function checkWebsite(url) {
  if (!url || !/^https?:\/\//i.test(url)) return 'missing';
  const { status } = await fetchText(url);
  if (status === 0 || status === 404 || status === 410) return 'dead';
  return 'ok';
}

function cleanTelegramId(raw) {
  if (!raw) return null;
  let id = String(raw).trim().replace(/^https?:\/\/(t|telegram)\.me\//i, '').replace(/^@/, '');
  id = id.split(/[/?#]/)[0];
  if (!id || id.startsWith('+') || id.toLowerCase() === 'joinchat') return null;
  return id;
}

async function checkTelegram(id) {
  if (!id) return { members: null, lastPost: null };
  const [page, preview] = await Promise.all([
    fetchText(`https://t.me/${id}`),
    fetchText(`https://t.me/s/${id}`),
  ]);
  let members = null;
  const extra = page.text.match(/tgme_page_extra">([^<]+)</);
  if (extra) {
    const m = extra[1].match(/([\d\s,.]+)\s*(members|subscribers)/i);
    if (m) members = parseInt(m[1].replace(/[^\d]/g, ''), 10) || null;
  }
  const times = [...preview.text.matchAll(/datetime="([^"]+)"/g)].map((x) => x[1]);
  const lastPost = times.length ? times[times.length - 1].slice(0, 10) : null;
  return { members, lastPost };
}

// ---------- filters & scoring ----------
const STABLE_SYMBOLS = new Set(['usdt', 'usdc', 'dai', 'fdusd', 'tusd', 'usde', 'pyusd', 'usdd', 'busd', 'frax', 'lusd',
  'gusd', 'usdp', 'eurc', 'eurt', 'eurs', 'xaut', 'paxg', 'usds', 'susds', 'usd0', 'rlusd', 'usd1', 'crvusd', 'gho', 'usdb']);

function excludeReason(c, s) {
  const name = (c.name || '').toLowerCase();
  const sym = (c.symbol || '').toLowerCase();
  const p7 = c.price_change_percentage_7d_in_currency;
  if (!(c.market_cap > 0)) return 'no market cap data';
  if (s.maxMarketCap > 0 && c.market_cap > s.maxMarketCap) return 'market cap above your limit';
  if (s.minMarketCap > 0 && c.market_cap < s.minMarketCap) return 'market cap below your minimum';
  if (Array.isArray(s.sizeBands) && s.sizeBands.length && !bandOf(c.market_cap, s.sizeBands)) return `bigger than ${fmtUsd(s.sizeBands[s.sizeBands.length - 1].max)} (above your size bands)`;
  if (STABLE_SYMBOLS.has(sym)) return 'stablecoin or gold token';
  if (/\b(wrapped|bridged|staked|restaked|liquid staking)\b/.test(name)) return 'wrapped or staked copy of another coin';
  if (c.current_price > 0.97 && c.current_price < 1.03 && p7 != null && Math.abs(p7) < 1.5) return 'stablecoin or gold token';
  if (!(c.total_volume >= s.minVolumeUsd)) return 'too little trading to sell out of';
  if (c.total_volume / c.market_cap > s.maxVolumeToMcap) return 'suspicious, fake-looking trading volume';
  if (c.fully_diluted_valuation > 0 && c.market_cap / c.fully_diluted_valuation < s.minMcapToFdv) return 'most tokens not released yet (big unlocks coming)';
  return null;
}

// ---------- sectors ----------
const EXCLUDED_SECTOR = 'memecoin or other sector you excluded';
const ALREADY_TRACKED = 'already picked before (watched in Tracking instead)';
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sectorHit(categoryNames, terms) {
  const tests = (terms || []).filter(Boolean).map((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(String(t).toLowerCase().trim())}($|[^a-z0-9])`));
  if (!tests.length) return null;
  for (const name of categoryNames || []) {
    const n = String(name || '').toLowerCase();
    if (tests.some((re) => re.test(n))) return name;
  }
  return null;
}

async function buildExcludedIds(cfg, ctx, categories) {
  const s = cfg.settings;
  const wanted = (s.excludeSectors || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const targets = categories.filter((c) => wanted.includes(String(c.name || '').toLowerCase().trim()));
  const ids = new Set();
  for (const cat of targets) {
    let cache = ctx.state.sectorCache[cat.id];
    if (!cache || daysBetween(cache.d, ctx.date) >= s.sectorListRefreshDays) {
      const got = [];
      let complete = true;
      for (let p = 1; p <= s.maxSectorPages; p++) {
        let page;
        try {
          page = await cg(`/coins/markets?vs_currency=usd&category=${encodeURIComponent(cat.id)}&order=market_cap_desc&per_page=250&page=${p}`, cfg);
        } catch (e) { log(`Couldn't finish the "${cat.name}" list: ${e.message}`); complete = false; break; }
        if (!page || !page.length) break;
        got.push(...page.filter((x) => x.market_cap > 0).map((x) => x.id));
        if (page.length < 250 || !page.some((x) => x.market_cap > 0)) break;
      }
      if (got.length && (complete || !cache)) {
        cache = { d: ctx.date, ids: got };
        ctx.state.sectorCache[cat.id] = cache;
      }
    }
    if (cache) cache.ids.forEach((id) => ids.add(id));
  }
  if (targets.length) log(`Excluding ${fmtNum(ids.size)} coins tagged ${targets.map((t) => `"${t.name}"`).join(', ')}`);
  return ids;
}

function volumeJump(c, ctx) {
  const hist = (ctx.state.market[c.id] || []).filter((h) => h[0] !== ctx.date);
  const prevVols = hist.slice(-7).map((h) => h[1]);
  if (prevVols.length < 3) return null;
  const med = median(prevVols);
  return med > 0 ? c.total_volume / med : null;
}

function rankClimb(c, ctx) {
  const hist = (ctx.state.market[c.id] || []).filter((h) => h[0] !== ctx.date);
  const old = hist.find((h) => daysBetween(h[0], ctx.date) >= 5);
  if (!old || !old[2] || !c.market_cap_rank) return null;
  return { from: old[2], to: c.market_cap_rank, days: daysBetween(old[0], ctx.date), climb: old[2] - c.market_cap_rank };
}

function stage1(c, ctx) {
  const why = [];
  const flags = [];
  let score = 0;
  const mcap = c.market_cap;
  const vol = c.total_volume;
  const vm = vol / mcap;
  const p24 = c.price_change_percentage_24h_in_currency;
  const p7 = c.price_change_percentage_7d_in_currency;
  const p30 = c.price_change_percentage_30d_in_currency;

  if (mcap < 5e6) { score += 15; why.push(`tiny market cap (${fmtUsd(mcap)}) — lots of room to grow`); }
  else if (mcap < 25e6) { score += 12; why.push(`small market cap (${fmtUsd(mcap)})`); }
  else if (mcap < 100e6) score += 8;
  else if (mcap < 500e6) score += 3;
  else if (mcap > 2e9) score -= 10;

  if (vm >= 0.05 && vm <= 1) { score += Math.min(12, Math.round(vm * 40)); why.push(`healthy trading for its size (${(vm * 100).toFixed(0)}% of its value traded in a day)`); }
  else if (vm < 0.01) { score -= 6; flags.push('very little trading for its size'); }

  const jump = volumeJump(c, ctx);
  if (jump != null && jump >= 2) {
    score += Math.min(15, Math.round(jump * 3));
    why.push(`trading is ${jump.toFixed(1)}x its normal level`);
  }

  if (p24 > 0 && p7 > 0) { score += 8; why.push(`price up on the day (${fmtPct(p24)}) and the week (${fmtPct(p7)})`); }
  if (p30 > 150) { score -= 12; flags.push(`already up ${fmtPct(p30)} this month — may be late`); }
  else if (p7 > 80) { score -= 6; flags.push(`already up ${fmtPct(p7)} this week — may be late`); }
  if (p30 < -50 && p7 < -15) { score -= 8; flags.push('still falling hard'); }

  const ath = c.ath_change_percentage;
  const pot = potentialOf(c, ctx.settings || {});
  if (ath != null && ath < -80 && vm >= 0.03 && !(pot && pot.extreme)) { score += 6; why.push(`${Math.round(-ath)}% below its all-time high, but still actively traded`); }

  const rc = rankClimb(c, ctx);
  if (rc && rc.climb >= Math.max(20, rc.from * 0.1)) { score += 8; why.push(`climbed from #${rc.from} to #${rc.to} in size ranking over ${rc.days} days`); }

  if (ctx.trending.has(c.id)) { score += 10; why.push('on CoinGecko\'s trending searches'); }

  if (c.fully_diluted_valuation > 0 && mcap / c.fully_diluted_valuation < 0.5) {
    score -= 4;
    flags.push(`only ${Math.round((mcap / c.fully_diluted_valuation) * 100)}% of tokens released so far — future unlocks could weigh on price`);
  }
  // v6: no bonus for recently seen coins any more. Fresh coins win the New list; past picks live in Tracking.
  return { score, why, flags };
}

const DEX_NAME = /swap|dex|uniswap|raydium|orca|meteora|curve|balancer|aerodrome|velodrome|pancake|sushi|trader joe|camelot|jupiter|pump\.fun|osmosis|thena|quickswap|ston\.fi|dedust/i;
const looksLikeAddress = (s) => typeof s === 'string' && s.length >= 26;

function centralizedExchanges(tickers) {
  const names = new Map();
  for (const t of tickers || []) {
    if (!t || !t.market || t.is_stale || t.is_anomaly) continue;
    if (looksLikeAddress(t.base) || looksLikeAddress(t.target)) continue;
    if (DEX_NAME.test(t.market.name || '')) continue;
    const n = exName(t.market.name);
    if (!n) continue;
    const prev = names.get(n);
    if (!prev || t.trust_score === 'green') names.set(n, t.trust_score || 'unknown');
  }
  return names;
}

// ---------- exchange ledger (v6.1) ----------
// CoinGecko's coin page returns at most 100 trading pairs (busiest first) and marks quiet pairs "stale" one day
// and not the next. Comparing two snapshots made exchanges that slipped back into the top 100 look like brand-new
// listings, and CoinGecko adding a new exchange to its data made it look "newly listed" on dozens of coins at once.
// The ledger remembers every exchange ever seen for each coin, so "new" now means never seen there before.
const TICKER_PAGE = 100;
function exName(n) { return String(n || '').trim(); }

// Every centralized exchange the coin trades on, quiet ("stale") pairs included — used for the ledger only.
function seenExchanges(tickers) {
  const out = new Set();
  for (const t of tickers || []) {
    if (!t || !t.market || t.is_anomaly) continue;
    if (looksLikeAddress(t.base) || looksLikeAddress(t.target)) continue;
    if (DEX_NAME.test(t.market.name || '')) continue;
    const n = exName(t.market.name);
    if (n) out.add(n);
  }
  return out;
}

// First run only: builds the ledgers from the snapshots already saved in state.json.
function seedLedgers(state) {
  if (state.exLedger) return 0;
  state.exLedger = {};
  state.exWave = state.exWave || {};
  const days = {};
  const add = (id, d, names) => {
    if (!d || !Array.isArray(names)) return;
    const L = (state.exLedger[id] ??= { since: d, n: 0, last: d, seen: {} });
    days[id] ??= new Set();
    if (!days[id].has(d)) { days[id].add(d); L.n++; }
    if (d < L.since) L.since = d;
    if (d > L.last) L.last = d;
    for (const raw of names) {
      const n = exName(raw);
      if (!n) continue;
      const e = L.seen[n];
      if (!e) L.seen[n] = { f: d, l: d, m: 0 };
      else { if (d < e.f) e.f = d; if (d > e.l) e.l = d; }
    }
  };
  for (const [id, v] of Object.entries(state.coins || {})) for (const k of v.checks || []) add(id, k.d, k.ex);
  for (const [id, t] of Object.entries(state.tracked || {})) if (t.deep) add(id, t.deep.d, t.deep.ex);
  // Exchanges that appeared on coins already being watched (not on a coin's first check) count toward a "wave"
  for (const [id, L] of Object.entries(state.exLedger)) {
    for (const [n, e] of Object.entries(L.seen)) if (e.f > L.since) (state.exWave[n] ??= []).push([e.f, id]);
  }
  return Object.keys(state.exLedger).length;
}

// Records today's exchanges for a coin and says which listings are genuinely new or gone.
// A same-day re-run starts again from this morning's ledger, so test runs give the same answer.
function ledgerCheck(state, id, names, truncated, date, s, stats) {
  let L = state.exLedger[id];
  if (L && L.before && L.before.d === date) {
    const b = L.before;
    L = b.l ? JSON.parse(JSON.stringify(b.l)) : { since: date, n: 0, last: null, seen: {} };
    L.before = b;
    state.exLedger[id] = L;
  } else {
    const copy = L ? JSON.parse(JSON.stringify({ ...L, before: undefined })) : null;
    if (!L) L = state.exLedger[id] = { since: date, n: 0, last: null, seen: {} };
    L.before = { d: date, l: copy };
  }
  const enough = L.n >= s.listingMinChecks && daysBetween(L.since, date) >= s.listingMinHistoryDays;
  const out = { newEx: [], goneEx: [] };
  const note = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  for (const n of names) {
    const e = L.seen[n];
    if (e) { e.l = date; e.m = 0; delete e.g; continue; }
    L.seen[n] = { f: date, l: date, m: 0 };
    if (!enough) { note('not enough history yet'); continue; }
    if (truncated) { note('pair list cut off at 100'); continue; }
    const w = (state.exWave[n] ??= []);
    if (!w.some((x) => x[1] === id && x[0] === date)) w.push([date, id]);
    out.newEx.push(n); // still checked against the wave at the end of the run (see applyListings)
  }
  // Only a full pair list can prove an exchange is gone, and it has to be missing a few checks in a row
  if (!truncated) {
    for (const [n, e] of Object.entries(L.seen)) {
      if (names.has(n)) continue;
      e.m = (e.m || 0) + 1;
      if (e.m >= s.delistMisses && !e.g && daysBetween(e.l, date) <= 60) { e.g = date; out.goneEx.push(n); }
    }
  }
  L.n++;
  L.last = date;
  return out;
}

// Exchanges that turned up as "new" on several coins within a couple of weeks: CoinGecko added the exchange
// to its data; the coins didn't really get listed. Old entries are pruned.
function waveExchanges(state, date, s) {
  const out = new Set();
  for (const [n, list] of Object.entries(state.exWave || {})) {
    const keep = list.filter((x) => daysBetween(x[0], date) < s.listingWaveDays && x[0] <= date);
    if (keep.length) state.exWave[n] = keep; else delete state.exWave[n];
    if (new Set(keep.map((x) => x[1])).size >= s.listingWaveCoins) out.add(n);
  }
  return out;
}

// Applied once per deep check, after every coin of the run has been checked, so a wave is caught on its first day.
function applyListings(r, wave, stats) {
  if (!r || !r.listing || r.listingApplied) return;
  r.listingApplied = true;
  const dropped = r.listing.newEx.filter((n) => wave.has(n));
  if (dropped.length && stats) stats['exchange just added to CoinGecko'] = (stats['exchange just added to CoinGecko'] || 0) + dropped.length;
  r.listing.newEx = r.listing.newEx.filter((n) => !wave.has(n));
  if (r.listing.newEx.length) { r.score += 12; r.why.push(`newly listed on ${r.listing.newEx.join(', ')}`); }
}

const GENERIC_CATEGORY = /ecosystem|portfolio|holdings|alpha|launchpad|made in|listed|fdv|proof of|smart contract platform|layer 1|layer 2|tokenized/i;

async function peerCheck(c, detail, cfg, ctx) {
  const cats = (detail.categories || []).filter((n) => n && !GENERIC_CATEGORY.test(n));
  const options = cats.map((n) => ctx.categoryByName.get(n)).filter((x) => x && x.market_cap > 0);
  if (!options.length) return null;
  options.sort((a, b) => a.market_cap - b.market_cap);
  const cat = options[0];
  let cache = ctx.state.categoryCache[cat.id];
  const stale = !cache || daysBetween(cache.d, ctx.date) >= cfg.settings.categoryCacheDays;
  if (stale && ctx.categoryFetches < cfg.settings.maxCategoryFetchesPerRun) {
    ctx.categoryFetches++;
    const page = await cg(`/coins/markets?vs_currency=usd&category=${encodeURIComponent(cat.id)}&order=market_cap_desc&per_page=250&page=1`, cfg);
    if (page) {
      cache = { d: ctx.date, m: page.map((x) => [x.id, x.market_cap]).filter((x) => x[1] > 0) };
      ctx.state.categoryCache[cat.id] = cache;
    }
  }
  if (!cache) return null;
  const peers = cache.m.filter((x) => x[0] !== c.id).map((x) => x[1]);
  if (peers.length < 8) return null;
  return { name: cat.name, median: median(peers), count: peers.length };
}

function growth(now, before) {
  if (now == null || before == null || before < 50) return null;
  return (now - before) / before;
}

async function stage2(cand, cfg, ctx) {
  const c = cand.coin;
  const detail = await cg(`/coins/${encodeURIComponent(c.id)}?localization=false&tickers=true&market_data=false&community_data=true&developer_data=true&sparkline=false`, cfg);
  if (!detail) return { tossed: 'could not load details' };

  if (sectorHit(detail.categories, cfg.settings.excludeSectors)) return { tossed: EXCLUDED_SECTOR };

  const why = [...cand.why];
  const flags = [...cand.flags];
  let score = cand.score;

  const preferred = sectorHit(detail.categories, cfg.settings.preferSectors);
  if (preferred) { score += cfg.settings.preferSectorBoost; why.push(`in a sector you're watching (${preferred})`); }

  const ex = centralizedExchanges(detail.tickers);
  if (ex.size === 0) return { tossed: 'no centralized exchange listing' };
  const exNames = [...ex.keys()];
  score += Math.min(6, ex.size);
  const truncated = (detail.tickers || []).length >= TICKER_PAGE;
  const listing = ledgerCheck(ctx.state, c.id, seenExchanges(detail.tickers), truncated, ctx.date, cfg.settings, ctx.listingStats);
  // the +12 and the "newly listed" line are added later by applyListings, once the whole run is in

  const links = detail.links || {};
  const homepage = (links.homepage || []).find((u) => u && u.trim());
  const xHandle = links.twitter_screen_name || null;
  const tgId = cleanTelegramId(links.telegram_channel_identifier);
  const [site, tg] = await Promise.all([checkWebsite(homepage), checkTelegram(tgId)]);
  if (site !== 'ok' && !xHandle) return { tossed: 'no working website or X account' };
  if (site === 'dead') flags.push('website is down');

  const commits = detail.developer_data ? detail.developer_data.commit_count_4_weeks : null;
  const hasRepo = ((links.repos_url || {}).github || []).some(Boolean);
  if (commits > 0) { score += 6; why.push(`developers still active (${commits} code updates in the last 4 weeks)`); }
  else if (hasRepo && commits === 0) { score -= 3; flags.push('no code updates in the last 4 weeks'); }

  const push = await githubLastPush((links.repos_url || {}).github, cfg, ctx);
  let codeDays = push ? daysBetween(push.at, ctx.date) : null;
  if (commits > 0 && (codeDays == null || codeDays > 28)) codeDays = Math.min(codeDays ?? 28, 28);
  const tgDays = tg.lastPost ? daysBetween(tg.lastPost, ctx.date) : null;
  const lf = lifeStatus({ codeDays, tgDays, site }, cfg.settings);
  const life = { status: lf.status, lastSignDays: lf.lastSignDays, lastCode: push ? push.at : null, codeDays, repo: push ? push.url : null, lastPost: tg.lastPost || null, tgDays, site };
  const ago = (d) => (d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`);
  if (lf.status === 'dead') return { tossed: 'looks dead (website down, no code or posts in months)', life };
  if (lf.status === 'alive') { score += cfg.settings.aliveBonus; why.push(`alive: ${[codeDays != null && codeDays <= cfg.settings.aliveCodeDays ? `code pushed ${ago(codeDays)}` : null, tgDays != null && tgDays <= cfg.settings.aliveSocialDays ? `Telegram post ${ago(tgDays)}` : null].filter(Boolean).join(', ')}`); }
  if (lf.status === 'zombie') { score -= cfg.settings.zombiePenalty; flags.push(`zombie: still trades, but last sign of life was ${ago(lf.lastSignDays)}`); }
  if (lf.status === 'quiet') flags.push(`quiet: last sign of life ${ago(lf.lastSignDays)}`);

  const community = detail.community_data || {};
  const snap = {
    d: ctx.date,
    tg: tg.members ?? community.telegram_channel_user_count ?? null,
    rd: community.reddit_subscribers || null,
    tw: community.twitter_followers || null,
    ex: exNames,
    v: c.total_volume,
  };

  if (cfg.settings.minCommunity > 0) {
    const sizes = [snap.tg, snap.tw].filter((n) => typeof n === 'number' && n > 0);
    if (sizes.length && Math.max(...sizes) < cfg.settings.minCommunity) return { tossed: 'community too small (under your minimum)' };
    if (!sizes.length) flags.push("couldn't check community size (no Telegram or X follower count)");
  }

  const checks = ctx.state.coins[c.id]?.checks || [];
  const before = checks.find((k) => daysBetween(k.d, ctx.date) >= 5) || null;
  if (before) {
    const days = daysBetween(before.d, ctx.date);
    const tgG = growth(snap.tg, before.tg);
    const rdG = growth(snap.rd, before.rd);
    const twG = growth(snap.tw, before.tw);
    const volG = before.v > 0 ? snap.v / before.v : null;
    if (tgG >= 0.15) { score += Math.min(15, Math.round(tgG * 30)); why.push(`Telegram grew ${Math.round(tgG * 100)}% (${fmtNum(before.tg)} → ${fmtNum(snap.tg)}) in ${days} days`); }
    if (rdG >= 0.15) { score += Math.min(8, Math.round(rdG * 20)); why.push(`Reddit grew ${Math.round(rdG * 100)}% in ${days} days`); }
    if (twG >= 0.15) { score += Math.min(10, Math.round(twG * 25)); why.push(`X followers grew ${Math.round(twG * 100)}% in ${days} days`); }
    const socialG = Math.max(tgG ?? -1, twG ?? -1);
    if (socialG >= 0.3 && volG != null && volG < 1.2) { score -= 8; flags.push('followers jumped but trading didn\'t — could be bought followers'); }
    else if (socialG >= 0.1 && volG >= 1.5) { score += 8; why.push('social growth and real trading rising together'); }
  }

  let peer = null;
  try {
    peer = await peerCheck(c, detail, cfg, ctx);
    if (peer && peer.median > 0 && c.market_cap < peer.median * 0.25) {
      score += 10;
      why.push(`valued at ${fmtUsd(c.market_cap)} vs a typical ${fmtUsd(peer.median)} for "${peer.name}" coins`);
    }
  } catch (e) { log(`Peer check skipped for ${c.id}: ${e.message}`); }

  const potential = potentialOf(c, cfg.settings);
  if (potential && potential.extreme) flags.push(`${potential.factor}x its old high is ${fmtX(potential.x)} away — coins this far below their peak rarely get back`);

  return {
    score, why, flags, snap, listing,
    info: {
      exchanges: exNames, homepage, xHandle, tgId, tgMembers: snap.tg, website: site,
      categories: detail.categories || [], commits,
      potential,
      life,
      peer: peer && peer.median > 0 && c.market_cap > 0 ? { name: peer.name, median: peer.median, count: peer.count, x: peer.median / c.market_cap } : null,
    },
  };
}

// ---------- tracking (v6) ----------
// Every coin ever picked lives in state.tracked forever. Each day it is checked for free against the
// market sweep; coins that changed get a limited number of deep re-checks; a big change brings a coin
// back onto the New list ("back on the radar").

function seedTracked(state, picks) {
  const sorted = picks.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  let added = 0;
  for (const p of sorted) {
    let t = state.tracked[p.id];
    if (!t) {
      const chk = (state.coins[p.id]?.checks || []).slice(-1)[0];
      t = state.tracked[p.id] = {
        name: p.name, symbol: p.symbol,
        first: { d: p.d, price: p.price, mcap: p.mcap, score: p.score, band: p.band || null },
        picks: 0, lastPick: p.d,
        deep: { d: p.d, score: p.score, ex: chk ? chk.ex : null, life: p.life || null },
        links: {}, notes: [], marks: {},
      };
      added++;
    }
    t.picks++;
    if (p.d > t.lastPick) t.lastPick = p.d;
    if (p.agent) { t.rating = p.agent; t.ratingDate = p.d; }
  }
  return added;
}

function addNote(t, date, text, keep) {
  t.notes = (t.notes || []).filter((n) => !(n[0] === date && n[1] === text));
  t.notes.push([date, text]);
  if (t.notes.length > keep) t.notes = t.notes.slice(-keep);
  t.changed = date;
}

// Only note the same kind of signal once every few days, so a coin that stays hot doesn't spam its history.
function fresh(t, kind, date, days = 3) {
  t.marks = t.marks || {};
  const last = t.marks[kind];
  if (last && daysBetween(last, date) < days) return false;
  t.marks[kind] = date;
  return true;
}

// Free check against today's market sweep. Returns the list of changes and how big they are.
function trackMarketCheck(id, t, coin, ctx, s) {
  const changes = [];
  let weight = 0;
  const date = ctx.date;
  if (!coin) {
    if (t.status !== 'gone') { changes.push('no longer shows up in CoinGecko\'s market data (delisted, renamed or no trading)'); weight += 5; }
    t.status = 'gone';
    return { changes, weight };
  }
  if (t.status === 'gone') { changes.push('back in CoinGecko\'s market data'); weight += 3; }

  const reason = excludeReason(coin, s);
  if (reason && t.status !== 'failing') { changes.push(`now fails a safety filter: ${reason}`); weight += 4; }
  if (!reason && t.status === 'failing') { changes.push('passes the safety filters again'); weight += 3; }
  t.status = reason ? 'failing' : 'ok';
  t.failReason = reason || null;

  const jump = volumeJump(coin, ctx);
  if (jump != null && jump >= s.trackVolumeJump && fresh(t, 'vol', date)) { changes.push(`trading jumped to ${jump.toFixed(1)}x its normal level`); weight += Math.min(6, jump); t.volJump = jump; }
  const p24 = coin.price_change_percentage_24h_in_currency;
  if (p24 != null && Math.abs(p24) >= s.trackPriceMove24h && fresh(t, 'p24', date)) { changes.push(`price ${p24 > 0 ? 'up' : 'down'} ${Math.abs(p24).toFixed(0)}% in a day`); weight += Math.abs(p24) / 20; }
  const p7 = coin.price_change_percentage_7d_in_currency;
  if (p7 != null && Math.abs(p7) >= s.trackPriceMove7d && fresh(t, 'p7', date, 7)) { changes.push(`price ${p7 > 0 ? 'up' : 'down'} ${Math.abs(p7).toFixed(0)}% this week`); weight += Math.abs(p7) / 40; }
  const rc = rankClimb(coin, ctx);
  if (rc && rc.climb > 0 && rc.climb / rc.from * 100 >= s.trackRankClimbPct && fresh(t, 'rank', date, 7)) { changes.push(`climbed from #${rc.from} to #${rc.to} in size ranking over ${rc.days} days`); weight += 2; }
  if (ctx.trending.has(id) && fresh(t, 'trend', date)) { changes.push('on CoinGecko\'s trending searches'); weight += 3; }
  const band = bandOf(coin.market_cap, s.sizeBands);
  // Coins near a band edge flip back and forth, so a band move is noted at most every 2 weeks and doesn't trigger a re-check
  if (t.band && band && band !== t.band && fresh(t, 'band', date, 14)) changes.push(`moved from ${t.band} to ${band} cap`);
  if (band) t.band = band;
  return { changes, weight };
}

// Compares a deep re-check with the last one on file.
function deepDiff(t, r) {
  const out = { changes: [], newEx: [], goneEx: [] };
  // v6.1: new/gone exchanges come from the ledger (see ledgerCheck), not from comparing two snapshots
  if (r.listing) {
    out.newEx = r.listing.newEx;
    out.goneEx = r.listing.goneEx;
    if (out.newEx.length) out.changes.push(`newly listed on ${out.newEx.slice(0, 5).join(', ')}${out.newEx.length > 5 ? ` and ${out.newEx.length - 5} more` : ''}`);
    if (out.goneEx.length) out.changes.push(`no longer on ${out.goneEx.slice(0, 5).join(', ')}${out.goneEx.length > 5 ? ` and ${out.goneEx.length - 5} more` : ''}`);
  }
  const prevLife = t.deep && t.deep.life;
  const life = r.info.life && r.info.life.status;
  if (prevLife && life && prevLife !== life) out.changes.push(`signs of life: ${prevLife} → ${life}`);
  const firstScore = t.first && t.first.score;
  if (firstScore != null && Math.abs(r.score - firstScore) >= 10) out.changes.push(`score ${r.score} now vs ${firstScore} when first picked`);
  return out;
}

function trackedItems(state, ctx, coinById, rechecked, comebacks, todayIds) {
  const items = [];
  for (const [id, t] of Object.entries(state.tracked)) {
    const c = coinById.get(id);
    const price = c ? c.current_price : null;
    items.push({
      id, name: t.name, symbol: t.symbol, band: t.band || (t.first && t.first.band) || null,
      firstDate: t.first.d, firstPrice: sig(t.first.price), firstScore: t.first.score,
      picks: t.picks, lastPick: t.lastPick,
      price: sig(price), marketCap: c ? Math.round(c.market_cap || 0) : null,
      ath: c && c.ath > 0 ? sig(c.ath) : null, athDate: c && c.ath_date ? String(c.ath_date).slice(0, 10) : null,
      athMcap: c && c.ath > 0 && c.current_price > 0 && c.market_cap > 0 ? Math.round(c.market_cap * (c.ath / c.current_price)) : null, volume24h: c ? Math.round(c.total_volume || 0) : null,
      day: c ? round(c.price_change_percentage_24h_in_currency, 1) : null,
      week: c ? round(c.price_change_percentage_7d_in_currency, 1) : null,
      changePct: price != null && t.first.price > 0 ? round((price / t.first.price - 1) * 100, 1) : null,
      score: t.deep ? t.deep.score : null, scoreDate: t.deep ? t.deep.d : null,
      exchanges: t.deep && Array.isArray(t.deep.ex) ? t.deep.ex.length : null,
      life: t.deep ? t.deep.life : null,
      rating: t.rating || null, ratingDate: t.ratingDate || null,
      topPick: t.top ? t.top.d : null, topRank: t.top ? t.top.rank : null,
      status: t.status || 'ok', failReason: t.failReason || null,
      changed: t.changed || null, changedToday: t.changed === ctx.date,
      rechecked: rechecked.has(id), back: comebacks.get(id) || null, onListToday: todayIds.has(id),
      notes: (t.notes || []).slice().reverse(),
      homepage: t.links.homepage || null, xHandle: t.links.xHandle || null, tgId: t.links.tgId || null,
    });
  }
  items.sort((a, b) => (b.changedToday - a.changedToday) || ((b.changed || '') > (a.changed || '') ? 1 : (b.changed || '') < (a.changed || '') ? -1 : 0) || (a.firstDate < b.firstDate ? 1 : -1));
  // Keep the file small (it grows by ~48 coins a day): drop empty fields.
  for (const x of items) for (const k of Object.keys(x)) if (x[k] == null || x[k] === false || (Array.isArray(x[k]) && !x[k].length)) delete x[k];
  return items;
}

// ---------- output ----------
function renderList(date, rows, stats, tracking) {
  const L = [];
  L.push(`# Coin Scanner — ${date}`);
  L.push('');
  L.push(`Scanned ${fmtNum(stats.scanned)} coins · ${fmtNum(stats.passed)} passed the safety filters · ${stats.deep} checked in depth · tracking ${fmtNum(stats.tracked.total)} past picks (${stats.tracked.changedToday} changed today) · CoinGecko calls this run: ${stats.calls} (this month: ${fmtNum(stats.monthCalls)} of ${fmtNum(stats.budget)})`);
  L.push('');
  L.push('_A research list, not buy advice. Every coin here can still go to zero._');
  if (stats.warning) { L.push(''); L.push(`**Heads-up:** ${stats.warning}`); }
  L.push('');
  L.push(`## New today (${rows.length})`);
  L.push('');
  rows.forEach((r, i) => {
    const c = r.coin;
    L.push(`### ${i + 1}. ${c.name} (${(c.symbol || '').toUpperCase()}) — score ${r.score}${r.info.band ? ` · ${r.info.band} cap` : ''}${r.back ? ' · BACK ON THE RADAR' : ''}`);
    if (r.back) L.push(`Back because: ${r.back}`);
    L.push(`Price ${fmtUsd(c.current_price)} · Market cap ${fmtUsd(c.market_cap)} · 24h trading ${fmtUsd(c.total_volume)} · Week ${fmtPct(c.price_change_percentage_7d_in_currency)}`);
    L.push(`Exchanges (${r.info.exchanges.length}): ${r.info.exchanges.slice(0, 8).join(', ')}${r.info.exchanges.length > 8 ? ', …' : ''}`);
    const lfi = r.info.life;
    if (lfi) L.push(`Life: ${lfi.status}${lfi.lastCode ? ` · last code push ${lfi.lastCode}` : ''}${lfi.lastPost ? ` · last Telegram post ${lfi.lastPost}` : ''}${lfi.site === 'dead' ? ' · website down' : ''}`);
    const pt = r.info.potential;
    if (pt) L.push(`Back to ATH: price ${fmtUsd(c.current_price)} vs ATH ${fmtUsd(pt.ath)}${pt.athDate ? ` (${pt.athDate})` : ''} = ${fmtX(pt.athX)} to get back to the ATH (${Math.round((1 - 1 / pt.athX) * 100)}% below it)`);
    if (pt) L.push(`ATH market cap: about ${fmtUsd(pt.athMcap)} at today's supply (now ${fmtUsd(c.market_cap)})`);
    if (pt) L.push(`Potential: ${pt.factor}x its all-time high (${fmtUsd(pt.ath)}${pt.athDate ? ` on ${pt.athDate}` : ''}) = ${fmtUsd(pt.targetPrice)}, about ${fmtX(pt.x)} from here · it would need a ${fmtUsd(pt.targetMcap)} market cap${r.info.peer ? ` · ${fmtX(r.info.peer.x)} to reach a typical "${r.info.peer.name}" coin` : ''}`);
    L.push('');
    L.push('**Why it\'s here**');
    r.why.forEach((w) => L.push(`- ${w}`));
    if (r.flags.length) { L.push(''); L.push('**Watch out**'); r.flags.forEach((f) => L.push(`- ${f}`)); }
    const links = [`[CoinGecko](https://www.coingecko.com/en/coins/${c.id})`];
    if (r.info.homepage) links.push(`[Website](${r.info.homepage})`);
    if (r.info.xHandle) links.push(`[X](https://x.com/${r.info.xHandle})`);
    if (r.info.tgId) links.push(`[Telegram](https://t.me/${r.info.tgId})${r.info.tgMembers ? ` (${fmtNum(r.info.tgMembers)} members)` : ''}`);
    L.push('');
    L.push(links.join(' · '));
    L.push('');
  });
  const changed = tracking.filter((x) => x.changedToday);
  L.push(`## Tracking — what changed today (${changed.length} of ${tracking.length} past picks)`);
  L.push('');
  if (!changed.length) L.push('Nothing notable changed today.');
  for (const x of changed.slice(0, 60)) {
    const today = (x.notes || []).filter((n) => n[0] === date).map((n) => n[1]);
    L.push(`- **${x.name} (${(x.symbol || '').toUpperCase()})** · first picked ${x.firstDate} at ${fmtUsd(x.firstPrice)} · now ${fmtUsd(x.price)} (${fmtPct(x.changePct)})${x.rating ? ` · last rating: ${x.rating}` : ''}${x.rechecked ? ' · re-checked in depth' : ''}: ${today.join('; ')}`);
  }
  if (changed.length > 60) L.push(`- …and ${changed.length - 60} more (see tracked.json or the dashboard)`);
  L.push('');
  L.push('## Thrown out today');
  Object.entries(stats.tossed).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => L.push(`- ${k}: ${fmtNum(v)}`));
  L.push('');
  return L.join('\n');
}

function buildWatchlist(picks, priceMap, mcapMap, list, date, s) {
  const byId = new Map();
  for (const p of picks.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))) {
    let w = byId.get(p.id);
    if (!w) { w = { id: p.id, name: p.name, symbol: p.symbol, times: 0, firstDate: null, firstPrice: null, lastDate: null, lastRating: null, lastRatingDate: null, daysListed: 0 }; byId.set(p.id, w); }
    w.daysListed++;
    if (p.agent) { w.lastRating = p.agent; w.lastRatingDate = p.d; }
    if (p.agent === 'worth a look') {
      w.times++;
      if (!w.firstDate) { w.firstDate = p.d; w.firstPrice = p.price; }
      w.lastDate = p.d;
    }
  }
  const today = new Set(list.map((r) => r.coin.id));
  const items = [...byId.values()].filter((w) => w.times > 0).map((w) => {
    const price = priceMap.get(w.id) ?? null;
    const mcap = mcapMap.get(w.id) ?? null;
    return { ...w, price, marketCap: mcap, band: bandOf(mcap, s.sizeBands), changePct: price != null && w.firstPrice > 0 ? ((price - w.firstPrice) / w.firstPrice) * 100 : null, onListToday: today.has(w.id) };
  });
  items.sort((a, b) => b.times - a.times || (a.lastDate < b.lastDate ? 1 : -1));
  return { date, count: items.length, items };
}

function updateScorecard(picks, priceMap, globalMcap, date) {
  for (const p of picks) {
    p.results = p.results || {};
    for (const h of [7, 30]) {
      if (p.results[h] || daysBetween(p.d, date) < h) continue;
      const now = priceMap.get(p.id);
      if (!(now > 0) || !(p.price > 0)) continue;
      p.results[h] = {
        ret: (now / p.price - 1) * 100,
        mkt: p.globalMcap && globalMcap ? (globalMcap / p.globalMcap - 1) * 100 : null,
        on: date,
      };
    }
  }
}

function renderScorecard(picks, date) {
  const L = [`# Scorecard — updated ${date}`, '', 'How the scanner\'s picks did after 7 and 30 days, compared with the whole crypto market over the same stretch.', ''];
  const groups = [['All scanner picks', () => true],
    ['Agent\'s top picks', (p) => !!p.top],
    ['Agent said "worth a look"', (p) => p.agent === 'worth a look'],
    ['Agent said "caution"', (p) => p.agent === 'caution'],
    ['Agent said "skip"', (p) => p.agent === 'skip']];
  for (const [label, test] of groups) {
    const set = picks.filter(test);
    if (!set.length) continue;
    L.push(`## ${label}`);
    for (const h of [7, 30]) {
      const done = set.filter((p) => p.results && p.results[h]);
      if (!done.length) { L.push(`- After ${h} days: not enough time has passed yet`); continue; }
      const avg = done.reduce((s, p) => s + p.results[h].ret, 0) / done.length;
      const mk = done.filter((p) => p.results[h].mkt != null);
      const avgM = mk.length ? mk.reduce((s, p) => s + p.results[h].mkt, 0) / mk.length : null;
      const beat = mk.filter((p) => p.results[h].ret > p.results[h].mkt).length;
      L.push(`- After ${h} days (${done.length} picks): average ${fmtPct(avg)} vs market ${fmtPct(avgM)} · beat the market ${mk.length ? Math.round((beat / mk.length) * 100) : 0}% of the time`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ---------- GitHub ----------
function ghHeaders(cfg) {
  return { authorization: `Bearer ${cfg.githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'coin-scanner', 'x-github-api-version': '2022-11-28' };
}
async function ghPut(cfg, repoPath, content, message) {
  const url = `https://api.github.com/repos/${cfg.githubRepo}/contents/${repoPath}`;
  let sha;
  const get = await fetch(url, { headers: ghHeaders(cfg) });
  if (get.ok) sha = (await get.json()).sha;
  const body = { message, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  const put = await fetch(url, { method: 'PUT', headers: { ...ghHeaders(cfg), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`GitHub refused ${repoPath} (${put.status}): ${(await put.text()).slice(0, 200)}`);
}
async function ghGetJson(cfg, repoPath) {
  const res = await fetch(`https://api.github.com/repos/${cfg.githubRepo}/contents/${repoPath}`, { headers: ghHeaders(cfg) });
  if (!res.ok) return null;
  const j = await res.json();
  try {
    // Files over 1 MB come back without inline content; fetch the raw download instead.
    if (!j.content && j.download_url) { const r = await fetch(j.download_url); return r.ok ? r.json() : null; }
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  } catch { return null; }
}

// Reads the research agent's rating files: fills ratings into past picks (scorecard) and keeps each
// tracked coin's latest rating (the agent also re-rates tracked coins that changed).
async function pullAgentRatings(cfg, picks, state, date) {
  const dates = new Set(picks.filter((p) => !p.agent && daysBetween(p.d, date) <= 35).map((p) => p.d));
  for (let i = 1; i <= 3; i++) dates.add(new Date(new Date(date) - i * 86400000).toISOString().slice(0, 10));
  for (const d of [...dates].sort()) {
    const file = await ghGetJson(cfg, `agent-ratings/${d}.json`);
    if (!file || !file.ratings) continue;
    const tops = new Map((Array.isArray(file.topPicks) ? file.topPicks : []).filter((x) => x && x.id).map((x) => [x.id, x.rank || null]));
    for (const p of picks) {
      if (p.d !== d) continue;
      const r = file.ratings[p.id];
      if (r) p.agent = String(r).toLowerCase();
      if (tops.has(p.id)) p.top = tops.get(p.id) || true;
    }
    for (const [id, rank] of tops) {
      const t = state.tracked[id];
      if (t && (!t.top || t.top.d <= d)) t.top = { d, rank };
    }
    for (const [id, r] of Object.entries(file.ratings)) {
      const t = state.tracked[id];
      if (t && (!t.ratingDate || t.ratingDate <= d)) {
        const nr = String(r).toLowerCase();
        if (t.rating && t.rating !== nr && t.ratingDate < d) addNote(t, d, `agent rating changed: ${t.rating} → ${nr}`, cfg.settings.trackNotesKept);
        t.rating = nr; t.ratingDate = d;
      }
    }
  }
}

async function pushDashboard(cfg, message) {
  const file = path.join(ROOT, 'dashboard.html');
  if (!fs.existsSync(file)) { log('dashboard.html not found — skipping the web page'); return; }
  await ghPut(cfg, 'index.html', fs.readFileSync(file, 'utf8'), message);
  await ghPut(cfg, '.nojekyll', '', message);
}

// ---------- main ----------
async function main() {
  if (process.argv.includes('--dashboard-only')) {
    const cfg = readJson(CONFIG_PATH, null);
    if (!cfg || !cfg.githubToken || cfg.githubToken.includes('PASTE') || !cfg.githubRepo) {
      console.error('GitHub token and repo need to be set in config.json first.'); process.exit(1);
    }
    await pushDashboard(cfg, 'update dashboard page');
    log(`Dashboard page posted to ${cfg.githubRepo}`);
    return;
  }
  const cfg = loadConfig();
  const quick = process.argv.includes('--quick');
  const push = !process.argv.includes('--no-push') && cfg.githubToken && cfg.githubRepo && !cfg.githubToken.includes('PASTE');
  const s = cfg.settings;
  if (quick) Object.assign(s, { maxMarketPages: 2, shortlistSize: 8, finalListSize: 8, perBandShortlist: 2, perBandFinal: 2, maxCategoryFetchesPerRun: 2, maxSectorPages: 2, trackRechecksPerDay: 2 });
  const useBands = Array.isArray(s.sizeBands) && s.sizeBands.length > 0;

  const date = todayStr();
  const month = date.slice(0, 7);
  const state = readJson(STATE_PATH, {});
  state.market ??= {}; state.coins ??= {}; state.categoryCache ??= {}; state.global ??= {}; state.calls ??= {}; state.sectorCache ??= {}; state.tracked ??= {};
  const picks = readJson(PICKS_PATH, []);

  // A same-day re-run replaces that day's picks and starts tracking from this morning's state again,
  // so test runs never pile up or lose changes.
  if (!quick) {
    for (let i = picks.length - 1; i >= 0; i--) if (picks[i].d === date) picks.splice(i, 1);
    if (state.trackedBefore && state.trackedBefore.d === date) state.tracked = JSON.parse(JSON.stringify(state.trackedBefore.t));
    else state.trackedBefore = { d: date, t: JSON.parse(JSON.stringify(state.tracked)) };
  }
  const seeded = seedTracked(state, picks.filter((p) => !state.tracked[p.id]));
  if (seeded) log(`Tracking: added ${seeded} past picks from the picks log`);
  const ledgers = seedLedgers(state);
  if (ledgers) log(`Exchange ledger: built from saved checks for ${ledgers} coins`);
  for (const L of Object.values(state.exLedger)) if (L.before && L.before.d !== date) delete L.before;

  log(quick ? 'Quick test run starting' : 'Daily scan starting');

  const global = await cg('/global', cfg);
  const globalMcap = global?.data?.total_market_cap?.usd || null;
  if (globalMcap) state.global[date] = globalMcap;

  const trendingRaw = await cg('/search/trending', cfg);
  const trending = new Set((trendingRaw?.coins || []).map((x) => x.item && x.item.id).filter(Boolean));

  const categories = (await cg('/coins/categories', cfg)) || [];
  const categoryByName = new Map(categories.map((c) => [c.name, { id: c.id, name: c.name, market_cap: c.market_cap }]));
  const excludedIds = await buildExcludedIds(cfg, { state, date }, categories);

  // 1) Sweep the whole market
  const all = [];
  for (let p = 1; p <= s.maxMarketPages; p++) {
    let page;
    try {
      page = await cg(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&price_change_percentage=24h,7d,30d`, cfg);
    } catch (e) { log(`Market sweep stopped at page ${p}: ${e.message}`); break; }
    if (!page || !page.length) break;
    all.push(...page);
    if (page.length < 250 || !page.some((c) => c.market_cap > 0)) break;
  }
  log(`Swept ${all.length} coins`);
  if (!all.length) throw new Error('Got no market data from CoinGecko — nothing to scan.');

  const priceMap = new Map(all.map((c) => [c.id, c.current_price]));
  const mcapMap = new Map(all.map((c) => [c.id, c.market_cap]));
  const coinById = new Map(all.map((c) => [c.id, c]));
  const swept = all.length >= 250 * Math.min(s.maxMarketPages, 10) || quick; // don't mark coins "gone" after a cut-short sweep

  // 2) Filter + first-pass score (past picks are kept out of the New list)
  const ctx = { date, state, trending, categoryByName, categoryFetches: 0, settings: s, ghCache: new Map(), listingStats: {} };
  const tossed = {};
  const candidates = [];
  let skippedTracked = 0;
  for (const c of all) {
    const reason = excludedIds.has(c.id) ? EXCLUDED_SECTOR : excludeReason(c, s);
    if (reason) { tossed[reason] = (tossed[reason] || 0) + 1; continue; }
    if (state.tracked[c.id]) { skippedTracked++; continue; }
    candidates.push({ coin: c, ...stage1(c, ctx) });
  }
  if (skippedTracked) tossed[ALREADY_TRACKED] = skippedTracked;
  candidates.sort((a, b) => b.score - a.score);
  let shortlist;
  if (useBands) {
    shortlist = [];
    for (const b of s.sizeBands) shortlist.push(...candidates.filter((x) => bandOf(x.coin.market_cap, s.sizeBands) === b.name).slice(0, s.perBandShortlist));
    shortlist.sort((a, b) => b.score - a.score);
  } else {
    shortlist = candidates.slice(0, s.shortlistSize);
  }
  log(`${candidates.length} new coins passed filters (${skippedTracked} past picks left to Tracking); checking top ${shortlist.length} in depth`);

  // 3) Deep check on the shortlist
  const finals = [];
  for (const cand of shortlist) {
    try {
      const r = await stage2(cand, cfg, ctx);
      if (r.tossed) { tossed[r.tossed] = (tossed[r.tossed] || 0) + 1; continue; }
      finals.push({ coin: cand.coin, ...r });
      if (!quick) {
        const entry = (state.coins[cand.coin.id] ??= { checks: [] });
        entry.checks = entry.checks.filter((k) => k.d !== date).concat(r.snap).slice(-12);
      }
    } catch (e) {
      log(`Deep check failed for ${cand.coin.id}: ${e.message}`);
      if (/API key/.test(e.message)) throw e;
    }
  }

  // 4) Tracking: free market check for every past pick, deep re-check for the ones that changed most
  const changedToday = [];
  for (const [id, t] of Object.entries(state.tracked)) {
    const coin = coinById.get(id) || null;
    if (!coin && !swept) continue;
    const { changes, weight } = trackMarketCheck(id, t, coin, ctx, s);
    if (!changes.length) continue;
    for (const ch of changes) addNote(t, date, ch, s.trackNotesKept);
    if (coin && weight > 0 && !excludedIds.has(id)) changedToday.push({ id, t, coin, weight });
  }
  changedToday.sort((a, b) => b.weight - a.weight);
  const due = changedToday.filter((x) => !x.t.deep || !x.t.deep.d || daysBetween(x.t.deep.d, date) >= s.trackRecheckCooldownDays).slice(0, s.trackRechecksPerDay);
  // Routine rotation: a few quiet tracked coins whose last deep check is oldest (new listings don't always move the price)
  const dueIds = new Set(due.map((x) => x.id));
  const rotation = Object.entries(state.tracked)
    .filter(([id, t]) => !dueIds.has(id) && coinById.has(id) && !excludedIds.has(id) && t.status !== 'gone' && (!t.deep || !t.deep.d || daysBetween(t.deep.d, date) >= s.trackRotateMinDays))
    .sort((a, b) => ((a[1].deep && a[1].deep.d) || '') < ((b[1].deep && b[1].deep.d) || '') ? -1 : 1)
    .slice(0, s.trackRotatePerDay)
    .map(([id, t]) => ({ id, t, coin: coinById.get(id), weight: 0, routine: true }));
  due.push(...rotation);
  const rechecked = new Set();
  const comebacks = new Map();
  const pending = [];
  for (const x of due) {
    try {
      const cand = { coin: x.coin, ...stage1(x.coin, ctx) };
      const r = await stage2(cand, cfg, ctx);
      rechecked.add(x.id);
      if (r.tossed) {
        addNote(x.t, date, `deep re-check: ${r.tossed}`, s.trackNotesKept);
        x.t.deep = { ...(x.t.deep || {}), d: date, life: r.life ? r.life.status : (x.t.deep && x.t.deep.life) || null, tossed: r.tossed };
        continue;
      }
      pending.push({ x, r });
    } catch (e) {
      log(`Re-check failed for ${x.id}: ${e.message}`);
      if (/API key/.test(e.message)) throw e;
    }
  }
  // Every deep check of the run is in: drop "listings" that are really CoinGecko adding an exchange
  const wave = waveExchanges(state, date, s);
  for (const r of finals) applyListings(r, wave, ctx.listingStats);
  for (const { r } of pending) applyListings(r, wave, ctx.listingStats);
  if (wave.size) log(`Exchanges CoinGecko recently added (ignored as listings): ${[...wave].join(', ')}`);
  for (const { x, r } of pending) {
    try {
      const diff = deepDiff(x.t, r);
      for (const ch of diff.changes) addNote(x.t, date, ch, s.trackNotesKept);
      const scoreJump = x.t.first.score != null ? r.score - x.t.first.score : 0;
      const reasons = [];
      if (diff.newEx.length) reasons.push(`new exchange listing (${diff.newEx.slice(0, 3).join(', ')})`);
      if (x.t.volJump >= s.trackVolumeJump && x.t.marks.vol === date) reasons.push(`trading spike (${x.t.volJump.toFixed(1)}x normal)`);
      if (scoreJump >= s.comebackScoreJump) reasons.push(`score up ${scoreJump} since first picked (${x.t.first.score} → ${r.score})`);
      x.t.deep = { d: date, score: r.score, ex: r.info.exchanges, life: r.info.life ? r.info.life.status : null };
      x.t.links = { homepage: r.info.homepage || null, xHandle: r.info.xHandle || null, tgId: r.info.tgId || null };
      if (!quick) {
        const entry = (state.coins[x.id] ??= { checks: [] });
        entry.checks = entry.checks.filter((k) => k.d !== date).concat(r.snap).slice(-12);
      }
      // Only coins that still pass every safety filter can come back (a spike with fake-looking volume can't)
      if (reasons.length && x.t.status === 'ok' && bandOf(x.coin.market_cap, s.sizeBands)) {
        const back = reasons.join('; ');
        comebacks.set(x.id, back);
        finals.push({ coin: x.coin, ...r, back, why: [`back on the radar: ${back}`, ...r.why] });
      }
    } catch (e) {
      log(`Re-check failed for ${x.id}: ${e.message}`);
      if (/API key/.test(e.message)) throw e;
    }
  }
  log(`Tracking ${Object.keys(state.tracked).length} past picks: ${changedToday.length} changed, ${rechecked.size} re-checked in depth, ${comebacks.size} back on the radar`);
  const ls = Object.entries(ctx.listingStats);
  if (ls.length) log(`Exchanges first seen today but not counted as new listings: ${ls.map(([k, v]) => `${v} (${k})`).join(', ')}`);

  // 5) Build today's New list: comebacks first (capped per band), then the best fresh coins
  finals.sort((a, b) => b.score - a.score);
  let list;
  if (useBands) {
    list = [];
    for (const b of s.sizeBands) {
      const inBand = finals.filter((r) => bandOf(r.coin.market_cap, s.sizeBands) === b.name);
      const backs = inBand.filter((r) => r.back).slice(0, s.maxComebacksPerBand);
      const freshOnes = inBand.filter((r) => !r.back).slice(0, Math.max(0, s.perBandFinal - backs.length));
      list.push(...backs, ...freshOnes);
    }
    list.sort((a, b) => b.score - a.score);
  } else {
    list = finals.slice(0, s.finalListSize);
  }
  for (const r of list) r.info.band = bandOf(r.coin.market_cap, s.sizeBands);
  for (const [id] of comebacks) if (!list.some((r) => r.coin.id === id)) comebacks.delete(id);

  // 6) Save history (full runs only)
  if (!quick) {
    for (const c of all) {
      if (!(c.market_cap > 0)) continue;
      const h = (state.market[c.id] || []).filter((x) => x[0] !== date);
      h.push([date, c.total_volume || 0, c.market_cap_rank || null]);
      state.market[c.id] = h.slice(-10);
    }
    for (const [id, h] of Object.entries(state.market)) if (daysBetween(h[h.length - 1][0], date) > 20 && !state.tracked[id]) delete state.market[id];
    for (const [id, v] of Object.entries(state.coins)) if ((!v.checks.length || daysBetween(v.checks[v.checks.length - 1].d, date) > 45) && !state.tracked[id]) delete state.coins[id];
    for (const id of Object.keys(state.exLedger)) if (!state.coins[id] && !state.tracked[id]) delete state.exLedger[id];
    for (const r of list) {
      picks.push({ d: date, id: r.coin.id, name: r.coin.name, symbol: r.coin.symbol, price: r.coin.current_price, mcap: r.coin.market_cap, score: r.score, athX: r.info.potential ? Math.round(r.info.potential.x * 10) / 10 : null, band: r.info.band || null, life: r.info.life ? r.info.life.status : null, back: r.back || null, globalMcap });
      let t = state.tracked[r.coin.id];
      if (!t) {
        t = state.tracked[r.coin.id] = {
          name: r.coin.name, symbol: r.coin.symbol,
          first: { d: date, price: r.coin.current_price, mcap: r.coin.market_cap, score: r.score, band: r.info.band || null },
          picks: 0, lastPick: date, notes: [], marks: {}, status: 'ok',
        };
      } else {
        addNote(t, date, `back on the New list: ${r.back}`, s.trackNotesKept);
      }
      t.picks++; t.lastPick = date; t.band = r.info.band || t.band;
      t.deep = { d: date, score: r.score, ex: r.info.exchanges, life: r.info.life ? r.info.life.status : null };
      t.links = { homepage: r.info.homepage || null, xHandle: r.info.xHandle || null, tgId: r.info.tgId || null };
    }
  }

  state.calls[month] = (state.calls[month] || 0) + cgCalls;
  const monthCalls = state.calls[month];
  const dayOfMonth = Number(date.slice(8, 10));
  const projected = Math.round((monthCalls / dayOfMonth) * 30);
  const warning = projected > s.monthlyCallBudget * 0.9 ? `on pace for about ${fmtNum(projected)} CoinGecko calls this month — close to the free limit. Lower perBandShortlist (or trackRechecksPerDay) in config.json.` : null;

  if (push) { try { await pullAgentRatings(cfg, picks, state, date); } catch (e) { log(`Couldn't read agent ratings: ${e.message}`); } }
  if (!quick) updateScorecard(picks, priceMap, globalMcap, date);
  const watchlist = JSON.stringify(buildWatchlist(picks, priceMap, mcapMap, list, date, s), null, 1);

  const todayIds = new Set(list.map((r) => r.coin.id));
  const tracking = trackedItems(state, ctx, coinById, rechecked, comebacks, todayIds);
  const trackedStats = { total: tracking.length, changedToday: tracking.filter((x) => x.changedToday).length, rechecked: rechecked.size, back: comebacks.size };

  const bands = useBands ? s.sizeBands.map((b) => ({ name: b.name, max: b.max, listed: list.filter((r) => r.info.band === b.name).length })) : null;
  const stats = { scanned: all.length, passed: candidates.length + skippedTracked, fresh: candidates.length, deep: shortlist.length + rechecked.size, calls: cgCalls, monthCalls, budget: s.monthlyCallBudget, tossed, warning, bands, tracked: trackedStats };
  const md = renderList(date, list, stats, tracking);
  const json = JSON.stringify({ date, stats, coins: list.map((r) => ({ id: r.coin.id, name: r.coin.name, symbol: r.coin.symbol, score: r.score, price: r.coin.current_price, marketCap: r.coin.market_cap, volume24h: r.coin.total_volume, week: r.coin.price_change_percentage_7d_in_currency ?? null, why: r.why, flags: r.flags, back: r.back || null, ...r.info })) }, null, 2);
  const trackedJson = JSON.stringify({ date, stats: trackedStats, items: tracking });
  const card = renderScorecard(picks, date);

  writeFile(path.join(OUT_DIR, 'latest.md'), md);
  writeFile(path.join(OUT_DIR, 'latest.json'), json);
  writeFile(path.join(OUT_DIR, 'tracked.json'), trackedJson);
  writeFile(path.join(OUT_DIR, 'scorecard.md'), card);
  writeFile(path.join(OUT_DIR, 'watchlist.json'), watchlist);
  if (!quick) {
    writeFile(STATE_PATH, JSON.stringify(state));
    writeFile(PICKS_PATH, JSON.stringify(picks, null, 1));
  }
  log(`Wrote ${list.length} coins to output/latest.md (${comebacks.size} back on the radar), tracking ${tracking.length} (${cgCalls} CoinGecko calls this run)`);

  if (push) {
    const tag = quick ? 'test run' : 'daily scan';
    await ghPut(cfg, 'latest.md', md, `${tag} ${date}`);
    await ghPut(cfg, 'latest.json', json, `${tag} ${date}`);
    if (!quick) { try { await ghPut(cfg, 'tracked.json', trackedJson, `tracking ${date}`); } catch (e) { log(`Tracking file not posted: ${e.message}`); } }
    try { await ghPut(cfg, 'watchlist.json', watchlist, `watchlist ${date}`); } catch (e) { log(`Watchlist not posted: ${e.message}`); }
    try { await pushDashboard(cfg, `${tag} ${date}`); } catch (e) { log(`Dashboard page not updated: ${e.message}`); }
    if (!quick) {
      await ghPut(cfg, `history/${date}.md`, md, `daily scan ${date}`);
      await ghPut(cfg, 'scorecard.md', card, `scorecard ${date}`);
      await ghPut(cfg, 'history/picks.json', JSON.stringify(picks, null, 1), `picks log ${date}`);
    }
    log(`Posted to GitHub: ${cfg.githubRepo}`);
  } else {
    log('Not posting to GitHub (no-push mode or GitHub not set up in config.json)');
  }
}

if (require.main === module) main().catch((e) => { log(`Scan failed: ${e.message}`); process.exit(1); });
module.exports = { ledgerCheck, seedLedgers, waveExchanges, applyListings, seenExchanges, centralizedExchanges, deepDiff, DEFAULT_SETTINGS };
