// Multi-host fetch pool for the dormant-wallets pipeline. Each source family
// (Esplora pair, blockchain.info, blockcypher) gets its own polite rate
// limiter; when one host rate-limits or dies the family routes around it
// instead of stalling the whole pipeline. This is source diversity, not
// evasion: every host keeps its own budget and 429s still trigger escalating
// cool-offs via HttpClient's RateLimiter.
'use strict';

const { HttpClient } = require('./http');

const PENALTY_BOX_MS = 15 * 60 * 1000;

class HostPool {
  // spec: { cacheDir, perSecond, log, esploraBases: [url, ...], bciBase,
  //   bcyBase, createClient?(base) -> {get(url, opts)} } - createClient is
  //   injectable so tests can stub hosts without network.
  constructor({ cacheDir, perSecond, log = console.error, esploraBases = [], bciBase, bcyBase, createClient }) {
    this.log = log;
    const make = createClient || ((base) => new HttpClient({ cacheDir, perSecond, maxRetries: 1, log }));
    const host = (base) => ({ name: base, base, http: make(base), fails: 0, deadUntil: 0 });
    this.families = {
      esplora: esploraBases.map(host),
      bci: bciBase ? [host(bciBase)] : [],
      bcy: bcyBase ? [host(bcyBase)] : [],
    };
  }

  async get(family, p, opts = {}) {
    const hosts = this.families[family];
    if (!hosts || !hosts.length) throw new Error('hosts: no source for family ' + family);
    // Prefer hosts that are not in the penalty box; if they are all boxed try
    // them anyway rather than failing outright.
    const healthy = hosts.filter((h) => h.deadUntil <= Date.now());
    let lastErr;
    for (const h of (healthy.length ? healthy : hosts)) {
      try {
        const out = await h.http.get(h.base + p, opts);
        h.fails = 0;
        return out;
      } catch (err) {
        // Resource-level 4xx (unknown address, bad path) is not a host
        // problem - another host would answer the same, so surface it.
        if (err.permanent) throw err;
        lastErr = err;
        // A rate-limited host is alive and inside its budget - the limiter's
        // cool-off is the whole response to that. Boxing it would park the
        // family for 15 min every time a bucket empties, which on a
        // quota-limited host is the normal steady state. Only dead-host
        // signals (5xx, timeouts, network errors) earn the penalty box.
        if (err.rateLimited) continue;
        h.fails++;
        if (h.fails >= 2) {
          h.fails = 0;
          h.deadUntil = Date.now() + PENALTY_BOX_MS;
          this.log(`hosts: ${h.name} unresponsive - routing around it for ${PENALTY_BOX_MS / 60000} min`);
        }
      }
    }
    throw lastErr || new Error('hosts: all ' + family + ' hosts failed for ' + p);
  }

  esploraGet(p, cacheKey, asText = false) {
    return this.get('esplora', p, { cacheKey, asText });
  }

  bciGet(p, cacheKey, asText = false) {
    return this.get('bci', p, { cacheKey, asText });
  }

  bcyGet(p, cacheKey, asText = false) {
    return this.get('bcy', p, { cacheKey, asText });
  }
}

module.exports = { HostPool, PENALTY_BOX_MS };
