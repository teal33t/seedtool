// Page-harvest helpers shared by the tag extractors. Provenance-first: an
// address only becomes a tag when its checksum (base58) or strict shape
// (bech32/ETH) passes, and every tag row carries its source + retrieval date.
// Third-party lists are labeled claims with citations - verify.js
// independently establishes balances and dormancy for every address.
'use strict';

const { base58checkVerify } = require('./address');

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

// Tag rows for one fetched page. meta.claimed lists the addresses the source
// ASSERTS (e.g. "these are dormant since 2013"): when present, only claims the
// page actually contains are emitted - a page that also names unrelated
// wallets must not drag them under this label. Without meta.claimed the page
// IS the list, so every extracted address is emitted. source is
// {name, url, retrievedAt}.
const tagsFromText = (text, meta) => {
  const { label, category, source, claimed } = meta;
  const out = [];
  const emitted = new Set();
  if (claimed) {
    for (const address of claimed) {
      if (!text.includes(address)) continue;
      emitted.add(address);
      out.push({
        address,
        chain: /^0x/i.test(address) ? 'ETH' : 'BTC',
        label,
        category: category || 'unknown',
        sources: [source],
      });
    }
    return out;
  }
  for (const [address, chain] of extractAddresses(text)) {
    if (emitted.has(address)) continue;
    emitted.add(address);
    out.push({
      address,
      chain,
      label,
      category: category || 'unknown',
      sources: [source],
    });
  }
  return out;
};

module.exports = { stripTags, extractAddresses, tagsFromText };
