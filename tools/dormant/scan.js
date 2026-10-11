// Phase 1: sample early blocks and collect every coinbase output address.
// Early-era (2009-2011) coinbase outputs are the richest dormant-address pool;
// p2pk outputs need pubkey->address derivation (lib/address.js). Resumable via
// the disk cache; re-running skips everything already fetched.
//
// Rate-limit posture: blockchain.info serves a whole block (header + txs +
// per-out spent flags + pre-derived P2PK addresses) in ONE request per height
// - 3x fewer calls than the Esplora path. When that host is down the Esplora
// fallback needs 2 calls per height (hash lookup + txs; block time rides on
// tx.status.block_time), never 3.
// Usage: node tools/dormant/scan.js
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const { HostPool } = require('./lib/hosts');
const { bciTxToEsplora } = require('./lib/normalize');
const { voutAddress } = require('./lib/address');

const OUT_DIR = path.join(__dirname, 'out');
const pool = new HostPool({
  cacheDir: path.join(__dirname, '..', '..', '.cache', 'dormant'),
  perSecond: config.perSecond,
  esploraBases: [config.esploraBase, config.esploraFallback],
  bciBase: config.bciBase,
  bcyBase: config.bcyBase,
});

const isCoinbase = (tx) =>
  Array.isArray(tx.vin) && tx.vin.some((v) => v.is_coinbase === true || !v.prevout);

// Primary: blockchain.info /block-height/:h?format=json - the whole block in
// one call. Normalize to the Esplora tx shape so the rest of the pipeline
// (isCoinbase, voutAddress) is source-agnostic.
const blockFromBci = async (height) => {
  const j = await pool.bciGet(`/block-height/${height}?format=json`, `bciblk-${height}`);
  const blocks = (j && j.blocks) || [];
  const blk = blocks.find((b) => b.height === height) || blocks[0];
  if (!blk || !Array.isArray(blk.tx)) throw new Error(`bci: no block data at height ${height}`);
  return { timestamp: blk.time, txs: blk.tx.map(bciTxToEsplora) };
};

// Fallback: Esplora, 2 calls per height. The coinbase tx's status.block_time
// is the block time, so no separate /block/:hash lookup is needed.
const blockFromEsplora = async (height) => {
  const hash = (await pool.esploraGet(`/block-height/${height}`, `bh-${height}`, true)).trim();
  const txs = await pool.esploraGet(`/block/${hash}/txs`, `txs-${height}`);
  if (!Array.isArray(txs) || !txs.length) throw new Error(`esplora: no txs at height ${height}`);
  const timestamp = (txs[0].status && txs[0].status.block_time) || 0;
  return { timestamp, txs };
};

const getBlock = async (height) => {
  try {
    return await blockFromBci(height);
  } catch (errBci) {
    try {
      return await blockFromEsplora(height);
    } catch (errEsp) {
      // Requeue (non-permanent) only when BOTH sources failed transiently.
      const err = new Error(`block ${height}: bci: ${errBci.message}; esplora: ${errEsp.message}`);
      err.permanent = !!(errBci.permanent && errEsp.permanent);
      throw err;
    }
  }
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'candidates-scan.json');
  const byAddress = new Map();
  if (fs.existsSync(outFile)) {
    for (const c of JSON.parse(fs.readFileSync(outFile, 'utf8'))) byAddress.set(c.address, c);
  }
  const heights = [];
  for (let h = config.heightStart; h <= config.heightEnd; h += config.heightStep) heights.push(h);
  console.error(`scan: ${heights.length} blocks (${config.heightStart}..${config.heightEnd} step ${config.heightStep}); ${byAddress.size} candidates cached`);

  let done = 0;
  const save = () => fs.writeFileSync(outFile, JSON.stringify([...byAddress.values()]));
  const queue = heights.slice();
  const retried = {};
  // Heights are independent; a few concurrent workers keep the shared limiter
  // saturated instead of serially awaiting each block's calls.
  const worker = async () => {
    for (;;) {
      const height = queue.shift();
      if (height === undefined) return;
      done++;
      try {
        const { timestamp, txs } = await getBlock(height);
        for (const tx of txs) {
          if (!isCoinbase(tx)) continue;
          tx.vout.forEach((vout, voutIndex) => {
            const address = voutAddress(vout);
            if (!address) return;
            const out = { txid: tx.txid, voutIndex, valueSats: vout.value, blockHeight: height, blockTime: timestamp };
            const rec = byAddress.get(address);
            if (!rec) {
              byAddress.set(address, { address, chain: 'BTC', ...out, outputs: [out] });
              return;
            }
            // Reused miner address: keep every mining output so verify can sum
            // them and check each one's spend status. Old flat records gain an
            // outputs[] on first reuse.
            if (!rec.outputs) {
              rec.outputs = [];
              if (rec.txid != null) rec.outputs.push({ txid: rec.txid, voutIndex: rec.voutIndex, valueSats: rec.valueSats, blockHeight: rec.blockHeight, blockTime: rec.blockTime });
            }
            if (!rec.outputs.some((o) => o.txid === out.txid && o.voutIndex === out.voutIndex)) rec.outputs.push(out);
          });
        }
        if (done % 200 === 0) {
          save();
          console.error(`scan: ${done}/${heights.length} blocks, ${byAddress.size} unique addresses`);
        }
      } catch (err) {
        // A dropped height means its coinbase addresses never enter the pool,
        // so transient errors (429, timeouts) go back to the queue up to twice.
        const attempt = (retried[height] || 0) + 1;
        if (!err.permanent && attempt <= 2) {
          retried[height] = attempt;
          queue.push(height);
          console.error(`scan: height ${height} requeued (${attempt}/2): ${err.message}`);
        } else {
          console.error(`scan: height ${height} failed: ${err.message}`);
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  fs.writeFileSync(outFile, JSON.stringify([...byAddress.values()]));
  console.error(`scan: complete, ${byAddress.size} unique coinbase addresses -> ${outFile}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
