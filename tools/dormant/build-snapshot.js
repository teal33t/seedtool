// Phase 4: merge scan + live verification + tags into the shipped snapshot,
// data/dormant-wallets.json. The client loads this file (same-origin) and the
// user adjusts dormant-years / min-balance thresholds in the UI over the full
// pool, so the compile filter is only the dormancy floor + balance > 0.
// Usage: node tools/dormant/build-snapshot.js
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const { mergeTags, isDormant } = require('./lib/tags');
const { fetchPriceUsd } = require('./lib/price');

const OUT_DIR = path.join(__dirname, 'out');
const ROOT = path.join(__dirname, '..', '..');

const load = (file, fallback) => {
  const p = path.join(OUT_DIR, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
};

const main = async () => {
  const now = Date.now();
  const scan = load('candidates-scan.json', []);
  const verified = load('verified.json', {});
  const ofacTags = load('ofac-tags.json', []);
  const pressTags = load('press-tags.json', []);
  const webTags = load('web-lists.json', []);

  const tagsByAddress = new Map();
  const addTag = (t) => {
    const key = t.chain === 'BTC' ? t.address : t.chain + ':' + t.address;
    if (!tagsByAddress.has(key)) tagsByAddress.set(key, []);
    tagsByAddress.get(key).push({
      label: t.label,
      category: t.category,
      sources: t.sources,
    });
  };
  for (const t of [...ofacTags, ...pressTags, ...webTags]) addTag(t);

  const scanByAddress = new Map(scan.map((c) => [c.address, c]));
  const wallets = [];
  for (const [address, v] of Object.entries(verified)) {
    // Only v3 rows ship: v1/v2 dates predate the walk contract (v1 let dust
    // receives reset the clock, v2 could overstate dormancy on undated
    // spends). A partial snapshot is smaller but honest, and rows join as
    // the verify pass redoes them.
    if (v.v !== 3) continue;
    if (v.balanceSats <= 0) continue;
    if (!isDormant(v.lastActiveMs, now, config.minDormantYears)) continue;
    const cand = scanByAddress.get(address);
    const tags = tagsByAddress.get(address) || [];
    if (cand) {
      tags.push({
        label: 'Early miner (2009-2011 era)',
        category: 'early-miner',
        sources: [{
          name: 'Blockstream Esplora (coinbase output of block ' + cand.blockHeight + ')',
          url: 'https://blockstream.info/tx/' + cand.txid,
          retrievedAt: new Date().toISOString(),
        }],
      });
    }
    wallets.push({
      address,
      chain: 'BTC',
      balanceSats: v.balanceSats,
      balanceBtc: v.balanceSats / 1e8,
      firstSeen: v.firstSeenMs ? new Date(v.firstSeenMs).toISOString() : null,
      lastActive: v.lastActiveMs ? new Date(v.lastActiveMs).toISOString() : null,
      dormantYears: v.lastActiveMs ? Math.floor(((now - v.lastActiveMs) / (365.25 * 24 * 3600 * 1000)) * 10) / 10 : null,
      txCount: v.txCount,
      blockHeight: v.blockHeight != null ? v.blockHeight : (cand ? cand.blockHeight : null),
      // Mining-output provenance (scan rows only): the coins live on the
      // coinbase output, which some explorers show under the tx, not the
      // address. null/absent for tagged rows.
      minedSats: v.minedSats != null ? v.minedSats : null,
      txid: v.txid != null ? v.txid : (cand ? cand.txid : null),
      voutIndex: v.voutIndex != null ? v.voutIndex : (cand ? cand.voutIndex : null),
      spent: v.spent != null ? v.spent : null,
      firstSeenExact: v.firstSeenExact !== false,
      // The walk could not date this wallet's spend(s): lastActive is a safe
      // upper bound (the real last move is older), disclosed in the UI so a
      // reader never mistakes the understated dormancy for the exact figure.
      // Legacy normalization: rows verified before the covered-window rule
      // (resolveLastActive) were marked undated whenever a walk never reported
      // end-of-history, even when its window bottom WAS the first funding -
      // where nothing can hide below. A never-spent row whose bound equals its
      // funding floor is exactly that case; clear the marker here (new
      // verifications write it correctly at the source).
      spendUndated: v.spendUndated === true
        && !(v.spentSats === 0 && v.firstSeenMs && v.lastActiveMs === v.firstSeenMs),
      tags: mergeTags(tags),
    });
  }
  wallets.sort((a, b) => b.balanceSats - a.balanceSats);
  const kept = wallets.slice(0, config.maxWallets);

  // USD at snapshot-build time: fetched HERE (the build host), never in the
  // browser - the card's offline-first promise holds and no viewer's IP or
  // browsing reaches a price API. On fetch failure the previous snapshot's
  // captured price is reused with its original capture date (stale but
  // honest); USD degrades to "unavailable" in the UI only if neither exists.
  let price = await fetchPriceUsd({ nowMs: now });
  if (!price) {
    const prevFile = path.join(ROOT, 'data', 'dormant-wallets.json');
    try {
      const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
      if (prev && typeof prev.priceUsd === 'number' && prev.priceUsd > 0) {
        price = {
          priceUsd: prev.priceUsd,
          priceAt: prev.priceAt || null,
          source: (prev.priceSource || 'previous snapshot') + ' (reused)',
        };
      }
    } catch (err) {
      // no previous snapshot to fall back on - price stays null
    }
  }

  const snapshot = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    minDormantYears: config.minDormantYears,
    totalPool: wallets.length,
    count: kept.length,
    priceUsd: price ? price.priceUsd : null,
    priceAt: price ? price.priceAt : null,
    priceSource: price ? price.source : null,
    wallets: kept,
  };
  const outFile = path.join(ROOT, 'data', 'dormant-wallets.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(snapshot));

  const tagged = kept.filter((w) => w.tags.some((t) => t.category !== 'early-miner'));
  const report = {
    generatedAt: snapshot.generatedAt,
    priceUsd: snapshot.priceUsd,
    priceAt: snapshot.priceAt,
    scanCandidates: scan.length,
    verified: Object.keys(verified).length,
    dormantPool: wallets.length,
    kept: kept.length,
    taggedNotEarlyMiner: tagged.length,
    unspentMinedRows: kept.filter((w) => w.minedSats != null && w.spent === false).length,
    undatedSpendRows: kept.filter((w) => w.spendUndated).length,
    ofacTagCount: ofacTags.length,
    pressTagCount: pressTags.length,
    webTagCount: webTags.length,
    minBalanceBtc: kept.length ? kept[kept.length - 1].balanceBtc : 0,
    maxBalanceBtc: kept.length ? kept[0].balanceBtc : 0,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'build-report.json'), JSON.stringify(report, null, 2));
  console.error('build: report', JSON.stringify(report, null, 2));
};

main().catch((err) => {
  console.error('build: failed', err);
  process.exit(1);
});
