// Shape adapters between the third-party Bitcoin indexers and the pipeline's
// internal Esplora-like records. blockchain.info and blockcypher answer the
// same questions as Esplora under different field names - and, critically,
// with different bare-P2PK indexing semantics (see balanceWithMined).
'use strict';

const { p2pkPubkeyFromScript } = require('./address');

// blockchain.info rawtx/multiaddr tx -> pipeline tx. tx.hash is display-order
// (verified against block 23's coinbase e1cf3476...c8c).
const bciTxToEsplora = (tx) => ({
  txid: tx.hash,
  status: {
    confirmed: tx.block_index != null,
    block_time: tx.time,
    block_height: tx.block_height != null ? tx.block_height : null,
  },
  vin: (tx.inputs || []).map((i) => {
    const prev = i.prev_out;
    // blockchain.info marks coinbase with prev_out.n = 4294967295 (value 0,
    // empty script) instead of omitting prev_out the way Esplora does.
    const coinbase = !prev || prev.n === 4294967295;
    return {
      is_coinbase: coinbase,
      prevout: coinbase
        ? null
        : { scriptpubkey_address: prev.addr || null, scriptpubkey: prev.script || null, value: prev.value },
    };
  }),
  vout: (tx.out || []).map(bciOutToEsplora),
});

const inferScriptType = (script) => {
  if (!script) return 'unknown';
  if (p2pkPubkeyFromScript(script)) return 'p2pk';
  if (/^76a914[0-9a-f]{40}88ac$/i.test(script)) return 'p2pkh';
  if (/^a914[0-9a-f]{40}87$/i.test(script)) return 'p2sh';
  if (/^0014[0-9a-f]{40}$/i.test(script)) return 'v0_p2wpkh';
  if (/^0020[0-9a-f]{64}$/i.test(script)) return 'v0_p2wsh';
  return 'unknown';
};

// Bare-P2PK outputs get their address derived by lib/address.js so pool keys
// match rows fetched through Esplora; every other type trusts the indexer's
// address (bech32 derivation is not implemented here).
const bciOutToEsplora = (o) => {
  const type = inferScriptType(o.script);
  return {
    value: o.value,
    scriptpubkey: o.script,
    scriptpubkey_type: type,
    scriptpubkey_address: type === 'p2pk' ? null : (o.addr || null),
  };
};

// blockcypher /addrs/A;B/.../balance row: confirmed-only balances, and the
// indexer keys bare-P2PK outputs to their derived address (verified on the
// block-23 canary address: total_received covers the 50 BTC mined output).
const statsFromBcy = (a) => ({
  address: a.address,
  balanceSats: a.balance || 0,
  fundedSats: a.total_received || 0,
  spentSats: a.total_sent || 0,
  totalSentSats: a.total_sent || 0,
  txCount: a.n_tx || 0,
  // Mempool visibility is free on this source: any unconfirmed activity means
  // the confirmed-only stats could hide a fresh spend, so verify walks.
  unconfirmedHint: (a.unconfirmed_n_tx || 0) > 0 || (a.unconfirmed_balance || 0) !== 0,
  p2pkIncluded: true,
  src: 'bcy',
});

// blockchain.info multiaddr addresses[] row: same P2PK semantics as
// blockcypher but final_balance includes unconfirmed txs. No unconfirmed
// counter exists on the row - verify.js derives the hint from the same
// call's mempool txs (unconfirmedHint starts false).
const statsFromBci = (a) => ({
  address: a.address,
  balanceSats: a.final_balance || 0,
  fundedSats: a.total_received || 0,
  spentSats: a.total_sent || 0,
  totalSentSats: a.total_sent || 0,
  txCount: a.n_tx || 0,
  unconfirmedHint: false,
  p2pkIncluded: true,
  src: 'bci',
});

// Esplora /address/:addr chain_stats: confirmed-only, and the address index
// does NOT attach bare-P2PK outputs to the derived address. mempool_stats
// gives the same free unconfirmed hint as blockcypher.
const statsFromEsplora = (info) => {
  const s = info.chain_stats || {};
  const m = info.mempool_stats || {};
  return {
    address: info.address,
    balanceSats: (s.funded_txo_sum || 0) - (s.spent_txo_sum || 0),
    fundedSats: s.funded_txo_sum || 0,
    spentSats: s.spent_txo_sum || 0,
    totalSentSats: s.spent_txo_sum || 0,
    txCount: s.tx_count || 0,
    unconfirmedHint: (m.tx_count || 0) > 0,
    p2pkIncluded: false,
    src: 'esplora',
  };
};

// Mined bare-P2PK coins live outside address stats only on Esplora; the other
// indexers key them to the derived address already, so adding minedUnspentSats
// there would double-count. hasOuts: the row tracks its mining outputs.
const balanceWithMined = (stats, minedUnspentSats, hasOuts) =>
  stats.p2pkIncluded ? stats.balanceSats : (hasOuts ? minedUnspentSats + stats.balanceSats : stats.balanceSats);

// blockchain.info /unspent drops UTXOs beyond 250 per call; on a complete
// response absence of an outpoint proves it spent, on a truncated one it
// proves nothing.
const UNSPENT_TRUNCATED = 250;

const unspentOutpointSet = (json) => {
  const outs = (json && json.unspent_outputs) || [];
  return {
    outpoints: new Set(outs.map((u) => `${u.tx_hash_big_endian}:${u.tx_output_n}`)),
    complete: outs.length < UNSPENT_TRUNCATED,
  };
};

const outpointKey = (txid, voutIndex) => `${txid}:${voutIndex}`;

// Map tracked outpoints to unspent-status evidence from one /unspent response:
// true = proven unspent (presence is always trustworthy), false = proven spent
// (only on complete pages), undefined = unknown (truncated page).
const unspentEvidence = (json, keys) => {
  const { outpoints, complete } = unspentOutpointSet(json);
  const ev = new Map();
  for (const k of keys) ev.set(k, outpoints.has(k) ? true : complete ? false : undefined);
  return ev;
};

// blockcypher /addrs/A txrefs page -> pipeline walk refs. txrefs[] is the
// confirmed history sorted newest-first by block height; unconfirmed_txrefs[]
// is the mempool and is newer than all of it. tx_input_n >= 0 marks the wallet
// SPENDING and `confirmed` dates that spend with no extra /tx call;
// tx_input_n === -1 marks a receive. Ref keys dedupe the before=minHeight+1
// cursor (before=H is strictly heights < H, so paging deliberately re-includes
// the boundary height - same-height refs must not be skipped).
const bcyRefsToWalk = (json, nowMs = Date.now()) => {
  const toRef = (r, unconfirmed) => ({
    key: `${r.tx_hash}:${r.tx_input_n}:${r.tx_output_n}`,
    ms: unconfirmed || !r.confirmed ? nowMs : Date.parse(r.confirmed),
    isSpend: r.tx_input_n != null && r.tx_input_n >= 0,
    height: r.block_height != null ? r.block_height : null,
  });
  const refs = [];
  for (const r of (json && json.unconfirmed_txrefs) || []) refs.push(toRef(r, true));
  for (const r of (json && json.txrefs) || []) refs.push(toRef(r, false));
  const heights = refs.map((r) => r.height).filter((h) => h != null);
  return {
    refs,
    // Only an explicit false completes the walk; anything else keeps paging.
    hasMore: json ? json.hasMore !== false : false,
    minHeight: heights.length ? Math.min(...heights) : null,
  };
};

const newWalkState = () => ({ seen: new Set(), newestSpendMs: 0, oldestSeenMs: 0, newestSeenMs: 0 });

// Fold one page of refs into the walk state. Returns true when the page added
// anything new - a page of pure duplicates means the before-cursor is stuck
// and the walk must stop instead of looping.
const foldWalkRefs = (state, refs) => {
  let grew = false;
  for (const r of refs) {
    if (state.seen.has(r.key)) continue;
    state.seen.add(r.key);
    grew = true;
    if (!state.oldestSeenMs || r.ms < state.oldestSeenMs) state.oldestSeenMs = r.ms;
    if (!state.newestSeenMs || r.ms > state.newestSeenMs) state.newestSeenMs = r.ms;
    if (r.isSpend && r.ms > state.newestSpendMs) state.newestSpendMs = r.ms;
  }
  return grew;
};

// The walk contract as a pure decision (see verify.js): "coins last moved" =
// the newest SPEND anywhere (receives never reset the clock), and a never-spent
// wallet is dormant since its first funding. spendPossible = a spend exists or
// cannot be ruled out (address totals exceed the tracked spends, or the stats
// source hides bare-P2PK and the walk window never closed). Undated spends make
// the firstSeen fallback illegal - claiming it overstates dormancy (the v1/v2
// bug this replaces). The walk window's oldest tx is the safe bound instead
// (the undated spend sits below the window, i.e. older than that bound, so
// dormancy is understated, never overstated), and with no usable window the
// only safe answer is "now".
const resolveLastActive = ({
  firstSeenMs,
  trackedSpendMs = 0,
  spendPossible = false,
  spendEvidence = false,
  walkSpendMs = 0,
  walkOldestMs = 0,
  walkComplete = false,
  nowMs = Date.now(),
}) => {
  if (walkSpendMs > 0) return { lastActiveMs: Math.max(walkSpendMs, trackedSpendMs), spendUndated: false };
  if (spendPossible) {
    // An undated spend can only hide BELOW the walk window - unless stats
    // themselves report a send the walk never saw (spendEvidence): its date is
    // then unknown and no window bounds it. When no such contradiction exists
    // and the window's oldest tx IS the first funding (scan rows know it
    // exactly - the coinbase block time), nothing predates the first funding,
    // the window covers the whole history even if hasMore never reported the
    // end, and the dated history stands with no marker. walkOldestMs BELOW
    // firstSeenMs is NOT coverage: the walk dipped under a P2PK-blind stats
    // first-seen and the true floor is unknown.
    const covered = !spendEvidence && walkOldestMs > 0 && firstSeenMs > 0 && walkOldestMs === firstSeenMs;
    if (covered) return { lastActiveMs: trackedSpendMs > 0 ? trackedSpendMs : firstSeenMs, spendUndated: false };
    const bound = !walkComplete && walkOldestMs > 0 ? Math.max(walkOldestMs, trackedSpendMs) : nowMs;
    return { lastActiveMs: bound, spendUndated: true };
  }
  if (trackedSpendMs > 0) return { lastActiveMs: trackedSpendMs, spendUndated: false };
  // No funding date either (an unused address): "dormant since 1970" would be
  // an overstatement, so the only safe answer is "now" with the undated flag.
  if (!firstSeenMs) return { lastActiveMs: nowMs, spendUndated: true };
  return { lastActiveMs: firstSeenMs, spendUndated: false };
};

module.exports = {
  bciTxToEsplora,
  bciOutToEsplora,
  inferScriptType,
  statsFromBcy,
  statsFromBci,
  statsFromEsplora,
  balanceWithMined,
  unspentOutpointSet,
  unspentEvidence,
  outpointKey,
  UNSPENT_TRUNCATED,
  bcyRefsToWalk,
  newWalkState,
  foldWalkRefs,
  resolveLastActive,
};
