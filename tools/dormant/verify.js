// Phase 2: verify every candidate against live chain data and keep the dormant
// ones. Dormancy is "coins last moved": lastActive is the last time the wallet
// SPENT coins (receiving - including dust campaigns - never resets the clock),
// and a never-spent wallet is dormant since its first funding.
//
// Source strategy (rate-limit posture): address stats come in batches of
// ~100 (blockcypher primary, blockchain.info multiaddr secondary, Esplora
// single as last resort), unspent-status evidence comes from batched
// blockchain.info /unspent calls, and history walks page blockcypher txrefs
// (~584 refs/call, spend refs dated inline). The old Esplora 25-tx deep-walk
// fallback is gone: it turned one deep address into 120+ calls and 429
// storms. Per-address/per-out calls survive only for spent outputs (which
// need spend dates) and as fallbacks - roughly a 10-100x cut in requests per
// candidate vs one-call-per-question Esplora usage.
//
// Bare-P2PK indexing differs per source and the balance formula must follow:
//   - Esplora address stats do NOT cover bare-P2PK outputs (the P2PK gap), so
//     mined coins are tracked through /tx/:txid/outspend/:n and added to the
//     address balance. Only outpoints whose script is bare-P2PK (pkType 'p2pk'
//     or missing on legacy rows) are invisible to the index; P2PKH coinbase
//     outputs are already in the address stats and must not be added twice.
//   - blockcypher / blockchain.info DO key bare-P2PK outputs to their derived
//     P2PKH address (verified on block 23's canary), so their balances are
//     taken as-is. Both assumptions are tripwired at startup below.
// Usage: node tools/dormant/verify.js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config.json');
const { HostPool } = require('./lib/hosts');
const { isBtcAddress } = require('./lib/address');
const {
  bciTxToEsplora,
  statsFromBcy,
  statsFromBci,
  statsFromEsplora,
  balanceWithMined,
  unspentEvidence,
  outpointKey,
  bcyRefsToWalk,
  newWalkState,
  foldWalkRefs,
  resolveLastActive,
} = require('./lib/normalize');
const { isDormant } = require('./lib/tags');

const OUT_DIR = path.join(__dirname, 'out');
const pool = new HostPool({
  cacheDir: path.join(__dirname, '..', '..', '.cache', 'dormant'),
  perSecond: config.perSecond,
  esploraBases: [config.esploraBase, config.esploraFallback],
  bciBase: config.bciBase,
  bcyBase: config.bcyBase,
});

const hashKey = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
// The disk cache is eternal, so keys carry a week stamp: a restart within the
// week resumes on cached responses, but a later run (the quarterly refresh,
// any redo) refetches instead of re-serving month-old balances as fresh.
const CACHE_WEEK = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
const ck = (k) => `w${CACHE_WEEK}-${k}`;
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const txTimeMs = (tx) =>
  tx.status && tx.status.confirmed === false
    ? Date.now()
    : (tx.status && tx.status.block_time ? tx.status.block_time * 1000 : 0);

const spendsFrom = (tx, address) =>
  Array.isArray(tx.vin) && tx.vin.some((v) => v.prevout && v.prevout.scriptpubkey_address === address);

// Prefetch maps filled in batches before the workers start; verifyOne reads
// them first and only falls back to per-address calls on a miss.
const statsByAddr = new Map();
const unspentEv = new Map(); // outpointKey -> true (unspent) | false (spent) | undefined (unknown)

const trackedOuts = (cand) => {
  if (!cand.fromScan) return [];
  const outs = cand.outputs && cand.outputs.length
    ? cand.outputs
    : [{ txid: cand.txid, voutIndex: cand.voutIndex, valueSats: cand.valueSats, blockHeight: cand.blockHeight, blockTime: cand.blockTime, pkType: cand.pkType }];
  return outs.filter((o) => o && o.txid != null && o.voutIndex != null && o.valueSats != null);
};

// Esplora is the only source whose address index hides bare-P2PK; pkType is
// absent on legacy scan rows (early coinbases are overwhelmingly P2PK) so
// those count as hidden too - matching the formula every existing record was
// built with.
const hiddenFromIndex = (o) => !o.pkType || o.pkType === 'p2pk';

// Batched address stats: blockcypher /addrs/A;B/.../balance (max 100), then
// blockchain.info multiaddr (max 120). On failure the group bisects so one
// bad address costs log2(n) extra calls instead of sinking the other 99 to
// per-address fallbacks; singles that still fail are left for the per-address
// Esplora path in statsFor.
const fillStatsGroup = async (group) => {
  const key = group.join(';');
  try {
    const rows = await pool.bcyGet(`/addrs/${key}/balance`, ck(`statsbcy-${hashKey(key)}`));
    if (Array.isArray(rows)) for (const r of rows) if (r && r.address) statsByAddr.set(r.address, statsFromBcy(r));
    return true;
  } catch (err) {
    if (err.permanent) console.error(`verify: stats batch rejected on blockcypher (${err.message})`);
  }
  try {
    const j = await pool.bciGet(`/multiaddr?active=${group.join('|')}`, ck(`statsbci-${hashKey(key)}`));
    if (j && Array.isArray(j.addresses)) for (const r of j.addresses) if (r && r.address) statsByAddr.set(r.address, statsFromBci(r));
    // multiaddr rows carry no unconfirmed counter, but the same call's txs[]
    // window shows mempool txs - mark the addresses they touch so their rows
    // get a history walk instead of being trusted as quiescent.
    for (const tx of (j && j.txs) || []) {
      if (tx.block_index != null) continue;
      const touched = new Set();
      for (const i of tx.inputs || []) if (i.prev_out && i.prev_out.addr) touched.add(i.prev_out.addr);
      for (const o of tx.out || []) if (o.addr) touched.add(o.addr);
      for (const a of touched) {
        const s = statsByAddr.get(a);
        if (s) s.unconfirmedHint = true;
      }
    }
    return true;
  } catch (err) {
    if (err.permanent) {
      // Poison-pill addresses (HTTP 400) are worth bisecting - one bad
      // address costs log2(n) calls instead of sinking its 99 neighbors.
      if (group.length === 1) {
        console.error(`verify: stats unavailable for ${group[0]} (${err.message}) - per-address fallback`);
        return false;
      }
      const mid = Math.ceil(group.length / 2);
      console.error(`verify: stats batch of ${group.length} rejected (${err.message}) - bisecting`);
      await fillStatsGroup(group.slice(0, mid));
      await fillStatsGroup(group.slice(mid));
      return false;
    }
    // Transient (429/5xx): bisecting would multiply traffic into the very
    // storm causing the failure - leave the rows to the per-address fallback.
    console.error(`verify: stats batch of ${group.length} unavailable (${err.message}) - per-address fallback`);
    return false;
  }
};

const fillStats = async (addresses) => {
  const missing = [...new Set(addresses)].filter((a) => !statsByAddr.has(a));
  for (const group of chunk(missing, config.statsBatch || 100)) {
    await fillStatsGroup(group);
  }
};

// Batched unspent-status evidence for tracked mining outputs: blockchain.info
// /unspent?active=A|B|... returns the UTXO set of up to unspentBatch addresses
// per call (250-UTXO truncation cap - see normalize.unspentEvidence). Presence
// proves an outpoint unspent; absence proves spent only on complete pages. The
// remaining unknowns resolve per-out via Esplora outspend below.
const fillUnspent = async (cands) => {
  const byAddr = new Map();
  for (const c of cands) {
    for (const o of trackedOuts(c)) byAddr.set(c.address, (byAddr.get(c.address) || []).concat(outpointKey(o.txid, o.voutIndex)));
  }
  for (const group of chunk([...byAddr.keys()], config.unspentBatch || 15)) {
    const keys = group.flatMap((a) => byAddr.get(a));
    const active = group.join('|');
    let ev;
    try {
      ev = unspentEvidence(await pool.bciGet(`/unspent?active=${active}`, ck(`unspent-${hashKey(active)}`)), keys);
    } catch (err) {
      console.error(`verify: unspent batch unavailable for ${group.length} addrs (${err.message})`);
      continue;
    }
    for (const [k, v] of ev) unspentEv.set(k, v);
    // Truncated batch pages prove nothing by absence - retry those addresses
    // one at a time so small addresses still get complete pages.
    if ([...ev.values()].some((v) => v === undefined)) {
      for (const a of group) {
        const aKeys = byAddr.get(a).filter((k) => unspentEv.get(k) === undefined);
        if (!aKeys.length) continue;
        try {
          const single = unspentEvidence(await pool.bciGet(`/unspent?active=${a}`, ck(`unspent-${a}`)), aKeys);
          for (const [k, v] of single) if (v !== undefined) unspentEv.set(k, v);
        } catch (err) {
          /* leave unknown; the outspend fallback resolves them */
        }
      }
    }
  }
};

// Walk budget in CALLS (not txs): blockcypher returns ~584 refs per call, so
// 30 calls cover ~17.5k refs - several times the old 3000-tx coverage at a
// fraction of the calls. The Esplora /txs fallback (25 txs/page, up to 120
// calls per address) is gone - it was the 429-storm engine.
const MAX_WALK_CALLS = 30;
const REFS_PAGE = 500; // txrefs per call; the API caps the return near 584
// Walk-vs-search cutoff for rows that only need a first-seen date: up to this
// many txs a walk pages 1-4 times (cheap on the quota-limited host) and beats
// the 21-probe height search; deeper rows keep the tail/search fallbacks.
const FIRST_SEEN_WALK_TXS = 2000;

// Newest-first walk over an address's history. Primary source is blockcypher
// /addrs/A txrefs (normalize.bcyRefsToWalk): spend refs carry ISO
// confirmation dates, so dating a spend costs zero extra /tx calls. The walk
// stops at the first spend ref - txrefs are sorted newest-first, so that ref
// IS the newest spend. A walk with no spends runs to the tail (hasMore=false)
// and completes the window. The before-cursor is exclusive (before=H returns
// heights < H) so continuation uses minHeight+1 and ref keys dedupe the
// re-included boundary height; a page of pure duplicates means the cursor is
// stuck and the walk stops instead of looping. Fallback: blockchain.info
// multiaddr pages (100 txs/call) folded into the same state. Both sources
// key bare-P2PK, so a completed walk that finds no spend disproves quiet
// doubts from blind stats.
const history = async (address) => {
  const state = newWalkState();
  let complete = false;

  const walkBcy = async () => {
    let before = null;
    for (let call = 0; call < MAX_WALK_CALLS; call++) {
      const url = before == null
        ? `/addrs/${address}?limit=${REFS_PAGE}`
        : `/addrs/${address}?limit=${REFS_PAGE}&before=${before}`;
      const json = await pool.bcyGet(url, ck(`txrefs-${address}-${before == null ? 'top' : before}`));
      const page = bcyRefsToWalk(json);
      const grew = foldWalkRefs(state, page.refs);
      if (!page.hasMore) { complete = true; return; }
      if (state.newestSpendMs) return;
      if (!grew || page.minHeight == null) return; // stuck guard: no cursor progress
      before = page.minHeight + 1;
    }
  };

  const walkBci = async () => {
    let seen = 0;
    for (let call = 0; call < MAX_WALK_CALLS; call++) {
      const offset = call * 100;
      const j = await pool.bciGet(`/multiaddr?active=${address}&offset=${offset}`, ck(`maddr-${address}-${offset}`));
      const txs = ((j && j.txs) || []).map(bciTxToEsplora);
      foldWalkRefs(state, txs.map((tx) => ({
        key: tx.txid,
        ms: txTimeMs(tx),
        isSpend: spendsFrom(tx, address),
        height: tx.status && tx.status.block_height != null ? tx.status.block_height : null,
      })));
      seen += txs.length;
      if (state.newestSpendMs) return;
      const total = j && j.addresses && j.addresses[0] && j.addresses[0].n_tx;
      if (!txs.length || (total && seen >= total) || txs.length < 100) { complete = true; return; }
    }
  };

  try {
    await walkBcy();
  } catch (err) {
    // Source diversity: one family's outage is not the row's problem, and a
    // blockcypher-specific 4xx may not bind blockchain.info. If the fallback
    // answers with the same permanent error it surfaces here and fails fast.
    await walkBci();
  }
  return { newestSpendMs: state.newestSpendMs, oldestSeenMs: state.oldestSeenMs || 0, complete };
};

// Exact first-seen in ONE call when it works: blockchain.info multiaddr
// returns the oldest tx at offset=n_tx-1 (verified on the block-23 canary:
// n_tx=8, offset=7 -> its 2009-01-10 coinbase). Deep offsets (past ~9000)
// come back 502/400 server-side, so this is best-effort and
// firstSeenByHeight covers the deep addresses. n_tx drifts with unconfirmed
// txs, so a tail that came up short (offset + returned < fresh n_tx) is
// aimed once more at the fresh tail.
const firstSeenTail = async (address, txCount) => {
  if (!txCount) return null;
  let off = txCount - 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    let j;
    try {
      j = await pool.bciGet(`/multiaddr?active=${address}&offset=${off}`, ck(`mtail-${address}-${off}`));
    } catch (err) {
      return null; // deep offsets 400/502 - the height search covers this
    }
    const n = (j && j.addresses && j.addresses[0] && j.addresses[0].n_tx) || txCount;
    const txs = (j && j.txs) || [];
    if (txs.length && off + txs.length >= n) {
      const times = txs.filter((t) => t.block_index != null).map((t) => t.time * 1000).filter(Boolean);
      return times.length ? Math.min(...times) : null;
    }
    off = n - 1;
  }
  return null;
};

// Exact first-seen when the tail trick can't reach: blockcypher's before=H
// cursor returns refs strictly below H, so "a ref exists below H" is
// monotone in H - binary-searching it finds the first height with refs in
// ~21 probes at ANY depth, then one fetch at that height reads the oldest
// tx's timestamp. Confirmed refs only (unconfirmed_txrefs are not history).
const FIRST_HEIGHT = 1;
const LAST_HEIGHT = 2100000; // past any live height for the foreseeable future
const firstSeenByHeight = async (address) => {
  const hasBelow = async (h) => {
    const json = await pool.bcyGet(`/addrs/${address}?limit=3&before=${h}`, ck(`tfind-${address}-${h}`));
    return ((json && json.txrefs) || []).length > 0;
  };
  try {
    if (!(await hasBelow(LAST_HEIGHT))) return null; // no confirmed history at all
    let lo = FIRST_HEIGHT;
    let hi = LAST_HEIGHT;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await hasBelow(mid)) hi = mid;
      else lo = mid + 1;
    }
    // lo is the first height with refs plus one (hasBelow(h) <=> a ref sits
    // below h), so before=lo returns exactly the refs at the first height.
    const json = await pool.bcyGet(`/addrs/${address}?limit=500&before=${lo}`, ck(`tage-${address}-${lo}`));
    const times = ((json && json.txrefs) || [])
      .map((r) => Date.parse(r.confirmed))
      .filter((t) => Number.isFinite(t) && t > 0);
    return times.length ? Math.min(...times) : null;
  } catch (err) {
    return null;
  }
};

const statsFor = async (address) => {
  const hit = statsByAddr.get(address);
  if (hit) return hit;
  return statsFromEsplora(await pool.esploraGet(`/address/${address}`, ck(`addr-${address}`)));
};

const verifyOne = async (cand, prev) => {
  const stats = await statsFor(cand.address);
  const outs = trackedOuts(cand);

  let trackedSpendMs = 0;
  let spentOuts = 0;
  let spentAttributedSats = 0;
  let minedSats = 0;
  let hiddenUnspentSats = 0;
  for (const o of outs) {
    minedSats += o.valueSats;
    const ev = unspentEv.get(outpointKey(o.txid, o.voutIndex));
    if (ev === true) {
      if (hiddenFromIndex(o)) hiddenUnspentSats += o.valueSats;
      continue;
    }
    // Unknown or proven-spent: resolve (and date) the spend. The outspend call
    // reflects the mempool too, so a just-spent output disqualifies dormancy.
    const outspend = await pool.esploraGet(`/tx/${o.txid}/outspend/${o.voutIndex}`, ck(`osp-${o.txid}-${o.voutIndex}`));
    if (outspend && outspend.spent) {
      spentOuts++;
      if (stats.p2pkIncluded || !hiddenFromIndex(o)) spentAttributedSats += o.valueSats;
      let spendMs = Date.now();
      if (outspend.txid) {
        const spendTx = await pool.esploraGet(`/tx/${outspend.txid}`, ck(`tx-${outspend.txid}`));
        spendMs = txTimeMs(spendTx);
      }
      if (spendMs > trackedSpendMs) trackedSpendMs = spendMs;
    } else if (hiddenFromIndex(o)) {
      hiddenUnspentSats += o.valueSats;
    }
  }

  // Spends not explained by the tracked outputs (spent dust, reused keys) only
  // show at the address level. On sources that index bare-P2PK every tracked
  // spend lands in totalSentSats, so subtracting attributed tracked spends
  // leaves exactly the untracked spend value; on Esplora P2PK spends are
  // invisible there and hidden tracked spends never enter the subtraction.
  // Blind stats can never prove a wallet quiet, so those rows walk even when
  // the arithmetic says zero - and a completed p2pk-inclusive walk that finds
  // no spend disproves the doubt. An unconfirmed-spend hint also forces a walk
  // so a wallet waking up during the snapshot cannot masquerade as dormant.
  const untrackedSpends = stats.totalSentSats - spentAttributedSats;
  const spendEvidence = untrackedSpends > 0;

  // First funding: the earliest tracked mining output (scan rows), else a
  // prior exact date (first-seen is immutable chain history). Rows missing
  // both walk even when they look quiet: a completed txrefs walk yields the
  // exact first-seen date in 1-4 calls, while the fallback chain below costs
  // a 21-probe height search on the quota-limited host - the tagged half of
  // the store (1133 rows, no tracked outputs) all land here.
  const fundTimes = outs.map((o) => (o.blockTime || 0) * 1000).filter(Boolean);
  const firstSeenFromFunds = fundTimes.length ? Math.min(...fundTimes) : null;
  const firstSeenKnown = firstSeenFromFunds != null
    || (prev && prev.firstSeenExact === true && prev.firstSeenMs);
  const needWalk = spendEvidence || !stats.p2pkIncluded || stats.unconfirmedHint
    || (!firstSeenKnown && stats.txCount > 0 && stats.txCount <= FIRST_SEEN_WALK_TXS);
  const hist = needWalk ? await history(cand.address) : null;
  const walkQuiet = !!(hist && hist.complete && !hist.newestSpendMs);
  const spendPossible = spendEvidence || (!stats.p2pkIncluded && !walkQuiet);

  // Chain order is cheapest-exact-first: prior exact date, then the completed
  // walk window, then the multiaddr tail (1 call), then the height bisection
  // (~21 probes) - and the bisection only runs when no bound exists at all.
  // With a walk-window bound the disclosed upper bound beats burning 21 calls
  // of the host quota on a display date (needsVerify retries exactness on the
  // next run, when the cheap tail may answer). If nothing yields a date the
  // row keeps that bound (firstSeenExact=false) or throws so it lands in
  // verify-failures instead of shipping a made-up date.
  let firstSeenMs = firstSeenFromFunds;
  let firstSeenExact = true;
  if (firstSeenMs == null && stats.txCount > 0) {
    if (prev && prev.firstSeenExact === true && prev.firstSeenMs) {
      firstSeenMs = prev.firstSeenMs;
    } else if (hist && hist.complete && hist.oldestSeenMs) {
      firstSeenMs = hist.oldestSeenMs;
    } else {
      firstSeenMs = await firstSeenTail(cand.address, stats.txCount);
      if (firstSeenMs == null && !(hist && hist.oldestSeenMs)) {
        firstSeenMs = await firstSeenByHeight(cand.address);
      }
      if (firstSeenMs == null) {
        if (hist && hist.oldestSeenMs) {
          firstSeenMs = hist.oldestSeenMs;
          firstSeenExact = false;
        } else {
          throw new Error(`first-seen unavailable for ${cand.address} (tail + height search returned nothing)`);
        }
      }
    }
  }

  // lastActive is the newest known spend anywhere: tracked outputs (dated via
  // outspend) and address-level spends (dated by the walk). Receives never
  // reset the clock; a never-spent wallet is dormant since its first funding.
  // When a spend exists (or cannot be ruled out) but no walk page located it,
  // falling back to firstSeenMs would OVERSTATE dormancy (the v1/v2 bug this
  // replaces) - resolveLastActive picks the safe bound instead: the walk
  // window's oldest tx (the undated spend sits below the window, i.e. older
  // than that bound, so dormancy is understated, never overstated), or now
  // when no window exists.
  const lastActive = resolveLastActive({
    firstSeenMs,
    trackedSpendMs,
    spendPossible,
    spendEvidence,
    walkSpendMs: hist ? hist.newestSpendMs : 0,
    walkOldestMs: hist ? hist.oldestSeenMs : 0,
    walkComplete: hist ? hist.complete : false,
    nowMs: Date.now(),
  });

  const balanceSats = balanceWithMined(stats, hiddenUnspentSats, outs.length > 0);

  const rec = {
    v: 3,
    src: stats.src,
    balanceSats,
    fundedSats: stats.fundedSats,
    spentSats: stats.spentSats,
    txCount: stats.txCount,
    lastActiveMs: lastActive.lastActiveMs || 0,
    firstSeenMs: firstSeenMs || null,
    firstSeenExact,
    fromScan: !!cand.fromScan,
    outsCount: outs.length,
    verifiedAt: Date.now(),
  };
  if (lastActive.spendUndated) rec.spendUndated = true;
  if (outs.length) {
    const heights = outs.map((o) => o.blockHeight).filter((h) => h != null);
    rec.minedSats = minedSats;
    rec.txid = outs[0].txid;
    rec.voutIndex = outs[0].voutIndex;
    rec.blockHeight = heights.length ? Math.min(...heights) : null;
    rec.spent = spentOuts === outs.length;
  }
  return rec;
};

// Balance formula canary (P2PK gap side): block 23's coinbase is a bare-P2PK
// 50 BTC output whose derived address only ever collected dust. While that
// outpoint is unspent, Esplora address stats MUST NOT cover the mined value -
// if they ever do, the indexer tracks bare-P2PK and adding hiddenUnspentSats
// double-counts; stop and fix it rather than ship wrong balances.
const checkIndexGap = async () => {
  const TXID = 'e1cf3476234d8446653ad52a8939ed792003eefdcd0e897319ab9d2cb4c14c8c';
  const ADDR = '1AqC4PhwYf7QAyGBhThcyQCKHJyyyLyAwc';
  const VALUE = 5000000000;
  const outspend = await pool.esploraGet(`/tx/${TXID}/outspend/0`, ck(`osp-${TXID}-0`));
  if (!outspend || outspend.spent) {
    console.error('verify: index-gap canary outpoint spent/missing - cannot confirm the P2PK assumption; continuing');
    return;
  }
  const info = await pool.esploraGet(`/address/${ADDR}`, ck(`addr-${ADDR}`));
  const funded = (info.chain_stats || {}).funded_txo_sum || 0;
  if (funded >= VALUE) {
    throw new Error(`index-gap canary FAILED: ${ADDR} chain stats now cover the 50 BTC P2PK output (funded_txo_sum=${funded}). The indexer tracks bare-P2PK - the "hidden + address" balance formula double-counts. Update verify.js before running.`);
  }
  console.error(`verify: index-gap canary ok (funded_txo_sum=${funded} < ${VALUE} - bare-P2PK still unindexed)`);
};

// Inclusive-index canary (the other side): blockcypher and blockchain.info
// attribute bare-P2PK to its derived address, so their stats MUST cover the
// same 50 BTC. If that flips, balances computed from them silently lose the
// mined coins; stop rather than ship them.
const checkInclusiveIndex = async () => {
  const ADDR = '1AqC4PhwYf7QAyGBhThcyQCKHJyyyLyAwc';
  const VALUE = 5000000000;
  const probes = [
    ['blockcypher', async () => {
      const rows = await pool.bcyGet(`/addrs/${ADDR}/balance`, ck(`statsbcy-${ADDR}`));
      return Array.isArray(rows) ? (rows[0] || rows).total_received : rows.total_received;
    }],
    ['blockchain.info', async () => {
      const j = await pool.bciGet(`/multiaddr?active=${ADDR}`, ck(`maddr-${ADDR}-stats`));
      return j.addresses[0].total_received;
    }],
  ];
  for (const [name, probe] of probes) {
    let received;
    try {
      received = await probe();
    } catch (err) {
      console.error(`verify: inclusive-index canary skipped for ${name} (${err.message})`);
      continue;
    }
    if (received == null || received < VALUE) {
      throw new Error(`inclusive-index canary FAILED on ${name}: ${ADDR} total_received=${received}. It no longer keys bare-P2PK to the derived address - set p2pkIncluded=false for this source in lib/normalize.js before running.`);
    }
    console.error(`verify: inclusive-index canary ok on ${name} (total_received=${received} >= ${VALUE})`);
  }
};

// A quarter is the refresh contract: balances and dormancy ages must track
// the chain, not the day a row was first verified.
const QUARTER_MS = 90 * 24 * 60 * 60 * 1000;

const needsVerify = (cand, verified) => {
  const prev = verified[cand.address];
  const outsCount = cand.fromScan ? ((cand.outputs && cand.outputs.length) || 1) : 0;
  // v3 is the txrefs-walk + undated-spend contract. The stored rows predate
  // it (v1 rows are dust-polluted mis-dates, v2 rows predate the walk fix),
  // so this pass redoes the whole store once. After that a row is redone when
  // it gained outputs, when its first-seen never got exact, or when its
  // record is a quarter old.
  return !(prev
    && prev.v === 3
    && (prev.outsCount || 0) === outsCount
    && prev.firstSeenExact !== false
    && prev.verifiedAt
    && Date.now() - prev.verifiedAt < QUARTER_MS);
};

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await checkIndexGap();
  await checkInclusiveIndex();
  const scanFile = path.join(OUT_DIR, 'candidates-scan.json');
  const scan = fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, 'utf8')) : [];
  const ofacFile = path.join(OUT_DIR, 'ofac-tags.json');
  const pressFile = path.join(OUT_DIR, 'press-tags.json');
  const webFile = path.join(OUT_DIR, 'web-lists.json');
  const tagged = [];
  for (const f of [ofacFile, pressFile, webFile]) {
    if (!fs.existsSync(f)) continue;
    for (const t of JSON.parse(fs.readFileSync(f, 'utf8'))) {
      if (t.chain === 'BTC') tagged.push({ address: t.address, tagLabel: t.label });
    }
  }

  const candidates = new Map();
  // Scan rows first: they verify in at most a couple of calls each and are the
  // bulk of the pool. Tagged rows need history walks and trickle in behind them.
  for (const c of scan) candidates.set(c.address, { ...c, fromScan: true });
  for (const t of tagged) {
    // Tag feeds carry other chains' addresses mislabeled as BTC (Tron "T..."
    // etc). They poison every batch they join with HTTP 400s and can never
    // verify on Bitcoin indexers - drop them up front.
    if (!isBtcAddress(t.address)) {
      console.error(`verify: skipping non-BTC tagged address ${t.address} (${t.tagLabel})`);
      continue;
    }
    if (!candidates.has(t.address)) candidates.set(t.address, { address: t.address, chain: 'BTC', fromScan: false, blockTime: 0, valueSats: 0 });
  }

  const outFile = path.join(OUT_DIR, 'verified.json');
  const verified = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
  const queue = [...candidates.values()];
  const pending = queue.filter((c) => needsVerify(c, verified));
  console.error(`verify: ${candidates.size} candidates (${scan.length} scan, ${tagged.length} tagged lookups), ${Object.keys(verified).length} already verified, ${pending.length} to do`);

  // Batch prefetch is opt-in (config.batchPrefetch) because a refused batch
  // is not free: the quota-limited hosts charge a batch its whole address
  // count even when they answer 429, so 16 refused 100-address batches cost
  // ~1600 units of quota for nothing AND stall the workers behind sequential
  // escalating cool-offs. Per-row fetches cost the same units one at a time
  // (walks and stats probes are single-address), land incrementally, and the
  // Esplora stats/outspend fallbacks are unquota'd - turn batches back on
  // only for a run against hosts measured to serve them.
  if (config.batchPrefetch) {
    await fillStats(pending.map((c) => c.address));
    await fillUnspent(pending.filter((c) => c.fromScan));
  }

  let done = 0;
  const failed = [];
  const retried = {};
  const total = candidates.size;
  const save = () => fs.writeFileSync(outFile, JSON.stringify(verified));
  // A few concurrent candidates keep the shared limiters saturated instead of
  // serially waiting out each fetch's latency. Host pressure is unchanged -
  // the limiters gate every request across all workers.
  const worker = async () => {
    for (;;) {
      const cand = queue.shift();
      if (!cand) return;
      done++;
      // Progress/save cadence sits BEFORE the redo skip: during a redo pass
      // the skips consume done values silently and hide real progress otherwise.
      if (done % 50 === 0) {
        save();
        console.error(`verify: ${done}/${total} (${Object.keys(verified).length} verified)`);
      }
      if (!needsVerify(cand, verified)) continue;
      try {
        verified[cand.address] = await verifyOne(cand, verified[cand.address]);
      } catch (err) {
        // Rate-limited rows always go back to the queue: a 429 is the host's
        // budget, not the row's fault, and the quota window resets - the
        // retry lands eventually. Timeouts and network errors requeue twice
        // before dropping; permanent 4xx lookups fail immediately. A dropped
        // row is absent from verified.json, so the next run redoes it anyway
        // (needsVerify) - dropping quota casualties only costs re-verify runs.
        const attempt = (retried[cand.address] || 0) + 1;
        if (err.rateLimited || (!err.permanent && attempt <= 2)) {
          retried[cand.address] = attempt;
          queue.push(cand);
          console.error(`verify: ${cand.address} requeued (${err.rateLimited ? 'quota' : attempt + '/2'}): ${err.message}`);
        } else {
          failed.push(cand.address);
          console.error(`verify: ${cand.address} failed: ${err.message}`);
        }
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  save();
  fs.writeFileSync(path.join(OUT_DIR, 'verify-failures.json'), JSON.stringify(failed));

  const now = Date.now();
  const dormant = Object.entries(verified).filter(([, v]) =>
    v.balanceSats > 0 && isDormant(v.lastActiveMs, now, config.minDormantYears));
  console.error(`verify: complete, ${Object.keys(verified).length} verified, ${failed.length} failed (out/verify-failures.json), ${dormant.length} dormant with balance > 0`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
