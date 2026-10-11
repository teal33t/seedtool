// Polite HTTP client for the dormant-wallets pipeline: rate-limited, cached
// to disk (so every phase is resumable), with backoff on 429/5xx. Node >= 18.
'use strict';

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

class RateLimiter {
  constructor(perSecond) {
    this.minInterval = 1000 / Math.max(0.5, perSecond);
    this.nextAt = 0;
    this.penaltyStreak = 0;
  }

  async wait() {
    const now = Date.now();
    if (now < this.nextAt) await sleep(this.nextAt - now + Math.floor(Math.random() * 120));
    this.nextAt = Date.now() + this.minInterval;
  }

  // Global cool-off shared by every worker: when the host rate-limits, one
  // 429 must pause the whole pipeline, not just the request that saw it.
  // The pause escalates while the host keeps refusing (20s -> 40s -> 80s ->
  // 160s -> 320s cap) so retries back off instead of re-triggering the
  // limit; any success resets the streak.
  penalty(ms) {
    const grown = ms * 2 ** Math.min(this.penaltyStreak, 4);
    this.penaltyStreak++;
    this.nextAt = Math.max(this.nextAt, Date.now() + grown);
    return grown;
  }

  success() {
    this.penaltyStreak = 0;
  }
}

class HttpClient {
  constructor({ cacheDir, perSecond = 4, maxRetries = 3, log = console.error }) {
    this.cacheDir = cacheDir;
    this.limiter = new RateLimiter(perSecond);
    this.maxRetries = maxRetries;
    this.log = log;
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  cachePath(key) {
    return path.join(this.cacheDir, key.replace(/[^a-z0-9._-]/gi, '_') + '.json');
  }

  // GET url; cacheKey null disables caching. Returns parsed JSON, or text when
  // asText is set. Throws after retries; callers record failures and move on.
  async get(url, { cacheKey = null, asText = false } = {}) {
    const file = cacheKey ? this.cachePath(cacheKey) : null;
    if (file && fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      return cached.body;
    }
    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      await this.limiter.wait();
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
          headers: { 'user-agent': 'seedtool-dormant-pipeline/1.0 (research snapshot compiler)' },
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error('HTTP ' + res.status + ' for ' + url);
          // 429 means the host is rate-limiting: cool off the shared limiter
          // before any retry instead of hammering through the window. The
          // flag tells HostPool the host is alive-but-budgeted, not dead.
          if (res.status === 429) {
            lastErr.rateLimited = true;
            this.limiter.penalty(20000);
          } else await sleep(1500 * 2 ** attempt);
          continue;
        }
        if (!res.ok) {
          const err = new Error('HTTP ' + res.status + ' for ' + url);
          err.permanent = true;
          throw err;
        }
        const body = asText ? await res.text() : await res.json();
        if (file) fs.writeFileSync(file, JSON.stringify({ url, fetchedAt: new Date().toISOString(), body }));
        this.limiter.success();
        return body;
      } catch (err) {
        if (err.permanent) throw err;
        lastErr = err;
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw lastErr;
  }
}

module.exports = { HttpClient, RateLimiter, sleep };
