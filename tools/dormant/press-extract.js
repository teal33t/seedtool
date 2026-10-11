// Phase 3b: tag enrichment from public pages.
// Two modes, both provenance-first:
//   1. pressUrls: a config entry CLAIMS addresses; a tag is only emitted when
//      the fetched page text actually contains that address ("be correct").
//      extractExtras also labels other addresses the same page names.
//   2. walletexplorerClusters: harvests the public address list of named
//      wallet clusters (BTC-e, Silk Road, ...). One page = 100 addresses.
// Sources that 404 or yield nothing are logged and skipped.
// Usage: node tools/dormant/press-extract.js
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const { HttpClient } = require('./lib/http');
const { base58checkVerify } = require('./lib/address');

const OUT_DIR = path.join(__dirname, 'out');
const http = new HttpClient({ cacheDir: path.join(__dirname, '..', '..', '.cache', 'dormant'), perSecond: 1 });

const BTC_BECH32_RE = /\bbc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20,87}\b/gi;
const BTC_BASE58_RE = /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g;
const ETH_RE = /\b0x[0-9a-fA-F]{40}\b/g;

const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z#0-9]+;/gi, ' ');

const extractAddresses = (text) => {
  const found = new Map();
  for (const m of text.matchAll(BTC_BECH32_RE)) found.set(m[0], 'BTC');
  for (const m of text.matchAll(BTC_BASE58_RE)) {
    if (base58checkVerify(m[0])) found.set(m[0], 'BTC');
  }
  for (const m of text.matchAll(ETH_RE)) found.set(m[0], 'ETH');
  return found;
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const retrievedAt = new Date().toISOString();
  const out = [];

  for (const src of config.pressUrls || []) {
    console.error(`press: ${src.url}`);
    let text;
    try {
      const html = await http.get(src.url, { cacheKey: 'press-' + Buffer.from(src.url).toString('base64url'), asText: true });
      text = stripTags(html);
    } catch (err) {
      console.error(`press: SKIPPED (${err.message})`);
      continue;
    }
    const found = extractAddresses(text);
    const claimed = src.addresses || [];
    const emitted = new Set();
    for (const address of claimed) {
      if (text.includes(address)) {
        emitted.add(address);
        out.push({
          address,
          chain: /^0x/i.test(address) ? 'ETH' : 'BTC',
          label: src.label,
          category: src.category || 'unknown',
          sources: [{ name: src.sourceName, url: src.url, retrievedAt }],
        });
      } else {
        console.error(`press: claimed address NOT on page, dropped: ${address}`);
      }
    }
    if (src.extractExtras) {
      for (const [address, chain] of found) {
        if (emitted.has(address)) continue;
        emitted.add(address);
        out.push({
          address,
          chain,
          label: src.label,
          category: src.category || 'unknown',
          sources: [{ name: src.sourceName, url: src.url, retrievedAt }],
        });
      }
    }
    console.error(`press: ${emitted.size} tags from this page`);
  }

  for (const cl of config.walletexplorerClusters || []) {
    const url = `https://walletexplorer.com/wallet/${cl.wallet}/addresses`;
    console.error(`walletexplorer: ${cl.wallet}`);
    try {
      const html = await http.get(url, { cacheKey: 'we-' + cl.wallet, asText: true });
      const found = extractAddresses(stripTags(html));
      for (const [address, chain] of found) {
        out.push({
          address,
          chain,
          label: cl.label,
          category: cl.category || 'entity',
          sources: [{ name: `WalletExplorer cluster: ${cl.wallet}`, url, retrievedAt }],
        });
      }
      console.error(`walletexplorer: ${found.size} addresses`);
    } catch (err) {
      console.error(`walletexplorer: SKIPPED ${cl.wallet} (${err.message})`);
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'press-tags.json'), JSON.stringify(out, null, 2));
  console.error(`press: wrote ${out.length} tags -> out/press-tags.json`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
