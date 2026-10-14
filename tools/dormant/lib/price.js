// BTC/USD captured at snapshot-build time. The price travels INSIDE the
// shipped snapshot so the browser never fetches a live rate: browsing the
// dormant card stays same-origin/offline-first and nothing a viewer does
// leaks to a price API. Sources are tried in order until one answers.
'use strict';

const SOURCES = [
  {
    name: 'mempool.space',
    url: 'https://mempool.space/api/v1/prices',
    parse: (j) => (j && typeof j.USD === 'number' ? j.USD : null),
  },
  {
    name: 'Coinbase',
    url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    parse: (j) => (j && j.data && j.data.amount ? Number(j.data.amount) : null),
  },
  {
    name: 'blockchain.info',
    url: 'https://blockchain.info/ticker',
    parse: (j) => (j && j.USD && j.USD.last ? Number(j.USD.last) : null),
  },
];

// Never throws: a price is a convenience, not a build dependency. Returns
// { priceUsd, priceAt, source } or null when every source failed.
const fetchPriceUsd = async (opts = {}) => {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || 10000;
  const nowMs = opts.nowMs || Date.now();
  if (typeof fetchImpl !== 'function') return null;
  for (const src of SOURCES) {
    try {
      const res = await fetchImpl(src.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res || !res.ok) continue;
      const priceUsd = src.parse(await res.json());
      if (Number.isFinite(priceUsd) && priceUsd > 0) {
        return { priceUsd, priceAt: new Date(nowMs).toISOString(), source: src.name };
      }
    } catch (err) {
      // network/parse failure - fall through to the next source
    }
  }
  return null;
};

module.exports = { fetchPriceUsd, SOURCES };
