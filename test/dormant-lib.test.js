// Tests for the dormant-wallets pipeline libraries (address derivation, OFAC
// parser, tag merging). Node built-ins only - run via `node test/dormant-lib.test.js`.
'use strict';

const assert = require('assert');
const { p2pkAddressFromPubkey, p2pkPubkeyFromScript, voutAddress, base58checkEncode, base58checkVerify, isBtcAddress, hash160 } = require('../tools/dormant/lib/address');
const { parseOfacEnhanced } = require('../tools/dormant/lib/ofac');
const { mergeTags, isDormant } = require('../tools/dormant/lib/tags');
const { stripTags, extractAddresses, tagsFromText } = require('../tools/dormant/lib/harvest');
const {
  bciTxToEsplora,
  inferScriptType,
  unspentOutpointSet,
  outpointKey,
  statsFromBcy,
  statsFromBci,
  statsFromEsplora,
  balanceWithMined,
  bcyRefsToWalk,
  newWalkState,
  foldWalkRefs,
  resolveLastActive,
} = require('../tools/dormant/lib/normalize');
const { HostPool } = require('../tools/dormant/lib/hosts');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const PUBKEY_GENESIS = '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f';
const PUBKEY_GENESIS_COMPRESSED = '02678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb6';
const ADDR_GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const ADDR_GENESIS_COMPRESSED = '1GgkcZcXsMNeoxAqc6iEUq6QrP4SW9aTa2';

test('dormant: p2pk genesis pubkey derives 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', () => {
  assert.strictEqual(p2pkAddressFromPubkey(PUBKEY_GENESIS), ADDR_GENESIS);
});

test('dormant: compressed p2pk pubkey derives its own address', () => {
  assert.strictEqual(p2pkAddressFromPubkey(PUBKEY_GENESIS_COMPRESSED), ADDR_GENESIS_COMPRESSED);
});

test('dormant: p2pk script parsing extracts pushed pubkey (65 and 33 byte forms)', () => {
  const script65 = '41' + PUBKEY_GENESIS + 'ac';
  const script33 = '21' + PUBKEY_GENESIS_COMPRESSED + 'ac';
  assert.strictEqual(p2pkPubkeyFromScript(script65), PUBKEY_GENESIS);
  assert.strictEqual(p2pkPubkeyFromScript(script33), PUBKEY_GENESIS_COMPRESSED);
  assert.strictEqual(p2pkPubkeyFromScript('76a914' + '00'.repeat(20) + '88ac'), null);
});

test('dormant: voutAddress trusts scriptpubkey_address, derives p2pk, null otherwise', () => {
  assert.strictEqual(voutAddress({ scriptpubkey_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5' }), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5');
  assert.strictEqual(
    voutAddress({ scriptpubkey_type: 'p2pk', scriptpubkey: '41' + PUBKEY_GENESIS + 'ac', value: 5000000000 }),
    ADDR_GENESIS,
  );
  assert.strictEqual(voutAddress({ scriptpubkey_type: 'p2sh', scriptpubkey: 'a914' + '00'.repeat(20) + '87' }), null);
});

test('dormant: base58check verify catches corruption', () => {
  assert.ok(base58checkVerify(ADDR_GENESIS));
  assert.ok(base58checkVerify(ADDR_GENESIS_COMPRESSED));
  assert.ok(!base58checkVerify(ADDR_GENESIS.slice(0, -1) + 'X'));
  assert.ok(!base58checkVerify('notanaddress'));
  // round-trip encode/verify
  const addr = base58checkEncode(0x00, hash160(Buffer.from(PUBKEY_GENESIS, 'hex')));
  assert.ok(base58checkVerify(addr));
});

const OFAC_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<Sanctions Version="3">
  <featureTypes>
    <featureType featureTypeId="344">
      <type>Digital Currency Address - XBT</type>
    </featureType>
    <featureType featureTypeId="345">
      <type>Digital Currency Address - ETH</type>
    </featureType>
    <featureType featureTypeId="992">
      <type>Digital Currency Address - TRX</type>
    </featureType>
    <featureType featureTypeId="777">
      <type>Digital Currency Address - NOPE</type>
    </featureType>
  </featureTypes>
  <entities>
    <entity id="4632">
      <generalInfo>
        <identityId>751</identityId>
      </generalInfo>
      <names>
        <name nameId="16878" nameTranslationId="1679">LAZARUS GROUP</name>
      </names>
      <features>
        <feature id="1">
          <type featureTypeId="344">Digital Currency Address - XBT</type>
          <versionId>1</versionId>
          <value>${ADDR_GENESIS}</value>
          <isPrimary>true</isPrimary>
        </feature>
        <feature id="2">
          <type featureTypeId="345">Digital Currency Address - ETH</type>
          <versionId>2</versionId>
          <value>0x252a8bd2319d8a555b872990601221b3a2053bce</value>
          <isPrimary>true</isPrimary>
        </feature>
        <feature id="3">
          <type featureTypeId="777">Digital Currency Address - NOPE</type>
          <versionId>3</versionId>
          <value>whatever</value>
          <isPrimary>true</isPrimary>
        </feature>
      </features>
    </entity>
    <entity id="9000">
      <names>
        <name nameId="1">SOME OTHER SANCTIONED PERSON</name>
      </names>
      <features>
        <feature id="4">
          <type featureTypeId="992">Digital Currency Address - TRX</type>
          <versionId>4</versionId>
          <value>TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81</value>
        </feature>
      </features>
    </entity>
  </entities>
</Sanctions>`;

test('dormant: OFAC enhanced parser extracts DC addresses with entity names', () => {
  const entries = parseOfacEnhanced(OFAC_FIXTURE);
  assert.strictEqual(entries.length, 3);
  const btc = entries.filter((e) => e.chain === 'BTC');
  assert.strictEqual(btc.length, 1);
  assert.strictEqual(btc[0].address, ADDR_GENESIS);
  assert.strictEqual(btc[0].entityName, 'LAZARUS GROUP');
  assert.strictEqual(btc[0].entityId, '4632');
  const eth = entries.find((e) => e.chain === 'ETH');
  assert.strictEqual(eth.address, '0x252a8bd2319d8a555b872990601221b3a2053bce');
  const trx = entries.find((e) => e.chain === 'TRX');
  assert.strictEqual(trx.entityName, 'SOME OTHER SANCTIONED PERSON');
  // unmappable chain codes are skipped, not guessed
  assert.ok(!entries.some((e) => e.chain === 'NOPE'));
});

test('dormant: mergeTags computes confidence from distinct sources', () => {
  const merged = mergeTags([
    { label: 'A', category: 'sanctions', sources: [{ name: 'n1', url: 'u1' }] },
    { label: 'A', category: 'sanctions', sources: [{ name: 'n1', url: 'u1' }, { name: 'n2', url: 'u2' }] },
    { label: 'B', category: 'hack-theft', sources: [] },
    { label: 'C', sources: [{ name: 'n1', url: 'u1' }] },
    { label: 'A', category: 'unknown', sources: [] },
  ]);
  const a = merged.find((t) => t.label === 'A');
  assert.strictEqual(a.confidence, 'corroborated');
  assert.strictEqual(a.sources.length, 2); // u1 deduped
  assert.strictEqual(a.category, 'sanctions');
  const b = merged.find((t) => t.label === 'B');
  assert.strictEqual(b.confidence, 'unverified');
  const c = merged.find((t) => t.label === 'C');
  assert.strictEqual(c.confidence, 'single-source');
  assert.strictEqual(c.category, 'unknown');
});

test('dormant: isDormant respects the 365.25-day year boundary', () => {
  const now = Date.now();
  const yearMs = 365.25 * 24 * 3600 * 1000;
  assert.ok(isDormant(now - 5 * yearMs, now, 5));
  assert.ok(!isDormant(now - 4.9 * yearMs, now, 5));
  assert.ok(!isDormant(0, now, 5));
  assert.ok(isDormant(now - 15 * yearMs, now, 15));
});

// blockchain.info rawtx shape: coinbase marker prev_out.n = 4294967295, tx.hash
// in display order, per-out `addr` pre-derived (even for bare-P2PK).
const BCI_COINBASE_TX = {
  hash: '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b',
  time: 1231469665,
  block_index: 0,
  block_height: 0,
  inputs: [{ prev_out: { n: 4294967295, value: 0, script: '', addr: null } }],
  out: [{ n: 0, value: 5000000000, script: '41' + PUBKEY_GENESIS + 'ac', addr: ADDR_GENESIS }],
};

test('dormant: bci coinbase tx normalizes to a coinbase vin and derived p2pk out', () => {
  const tx = bciTxToEsplora(BCI_COINBASE_TX);
  assert.strictEqual(tx.txid, BCI_COINBASE_TX.hash);
  assert.strictEqual(tx.status.confirmed, true);
  assert.strictEqual(tx.status.block_time, 1231469665);
  assert.strictEqual(tx.vin.length, 1);
  assert.strictEqual(tx.vin[0].is_coinbase, true);
  assert.strictEqual(tx.vin[0].prevout, null);
  assert.strictEqual(tx.vout[0].scriptpubkey_type, 'p2pk');
  // P2PK addresses are derived locally so pool keys never depend on the
  // indexer's derivation; everything else trusts the indexer address.
  assert.strictEqual(tx.vout[0].scriptpubkey_address, null);
  assert.strictEqual(voutAddress(tx.vout[0]), ADDR_GENESIS);
});

test('dormant: bci input prev_out.addr is preserved for spend detection', () => {
  const tx = bciTxToEsplora({
    hash: 'ab'.repeat(32),
    time: 1700000000,
    block_index: 800000,
    inputs: [{ prev_out: { n: 0, value: 546, script: '76a914' + '00'.repeat(20) + '88ac', addr: ADDR_GENESIS } }],
    out: [{ n: 0, value: 500, script: '76a914' + '11'.repeat(20) + '88ac', addr: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' }],
  });
  assert.strictEqual(tx.vin[0].is_coinbase, false);
  assert.strictEqual(tx.vin[0].prevout.scriptpubkey_address, ADDR_GENESIS);
  assert.strictEqual(tx.status.confirmed, true);
  // unconfirmed txs (block_index null) must read as unconfirmed
  const mempoolTx = bciTxToEsplora({ hash: 'cd'.repeat(32), time: 1700000001, block_index: null, inputs: [], out: [] });
  assert.strictEqual(mempoolTx.status.confirmed, false);
});

test('dormant: script type inference covers p2pk/p2pkh/p2sh/witness', () => {
  assert.strictEqual(inferScriptType('41' + PUBKEY_GENESIS + 'ac'), 'p2pk');
  assert.strictEqual(inferScriptType('21' + PUBKEY_GENESIS_COMPRESSED + 'ac'), 'p2pk');
  assert.strictEqual(inferScriptType('76a914' + '00'.repeat(20) + '88ac'), 'p2pkh');
  assert.strictEqual(inferScriptType('a914' + '00'.repeat(20) + '87'), 'p2sh');
  assert.strictEqual(inferScriptType('0014' + '11'.repeat(20)), 'v0_p2wpkh');
  assert.strictEqual(inferScriptType('0020' + '11'.repeat(32)), 'v0_p2wsh');
  assert.strictEqual(inferScriptType('6a'), 'unknown');
});

test('dormant: unspent set trusts absence only on complete pages', () => {
  const full = unspentOutpointSet({
    unspent_outputs: [
      { tx_hash_big_endian: 'aa'.repeat(32), tx_output_n: 0, value: 5000000000 },
      { tx_hash_big_endian: 'bb'.repeat(32), tx_output_n: 7, value: 546 },
    ],
  });
  assert.strictEqual(full.complete, true);
  assert.ok(full.outpoints.has(outpointKey('aa'.repeat(32), 0)));
  assert.ok(full.outpoints.has(outpointKey('bb'.repeat(32), 7)));
  assert.ok(!full.outpoints.has(outpointKey('cc'.repeat(32), 0)));
  const truncated = unspentOutpointSet({
    unspent_outputs: Array.from({ length: 250 }, (_, i) => ({ tx_hash_big_endian: 'dd'.repeat(32), tx_output_n: i })),
  });
  assert.strictEqual(truncated.complete, false);
  assert.strictEqual(unspentOutpointSet({}).complete, true);
});

test('dormant: stats adapters share one shape and the balance formula respects P2PK semantics', () => {
  const bcy = statsFromBcy({ address: ADDR_GENESIS, total_received: 5000003911, total_sent: 0, balance: 5000003911, n_tx: 8 });
  const bci = statsFromBci({ address: ADDR_GENESIS, final_balance: 5000003911, total_received: 5000003911, total_sent: 0, n_tx: 8 });
  const esp = statsFromEsplora({ address: ADDR_GENESIS, chain_stats: { funded_txo_sum: 3911, spent_txo_sum: 0, tx_count: 8 } });
  assert.strictEqual(bcy.p2pkIncluded, true);
  assert.strictEqual(bci.p2pkIncluded, true);
  assert.strictEqual(esp.p2pkIncluded, false);
  assert.strictEqual(esp.balanceSats, 3911);
  assert.strictEqual(esp.totalSentSats, 0);
  // Esplora stats miss the mined coins: add them once for tracked rows.
  assert.strictEqual(balanceWithMined(esp, 5000000000, true), 5000003911);
  assert.strictEqual(balanceWithMined(esp, 0, false), 3911);
  // bci/bcy already key mined P2PK to the derived address: never add again.
  assert.strictEqual(balanceWithMined(bcy, 5000000000, true), 5000003911);
  assert.strictEqual(balanceWithMined(bci, 5000000000, true), 5000003911);
});

test('dormant: isBtcAddress rejects foreign-chain addresses before they poison batches', () => {
  // The real poison pill seen in tagged data: a Tron base58check address.
  assert.strictEqual(isBtcAddress('TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq'), false);
  assert.strictEqual(isBtcAddress(ADDR_GENESIS), true); // P2PKH (0x00)
  assert.strictEqual(isBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), true); // P2SH (0x05)
  assert.strictEqual(isBtcAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), true); // bech32
  assert.strictEqual(isBtcAddress(''), false);
  assert.strictEqual(isBtcAddress('not-an-address'), false);
  // valid base58check but a testnet version byte (0x6f) is not mainnet BTC
  assert.strictEqual(isBtcAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'), false);
});

test('dormant: unconfirmedHint flags mempool activity so verify walks those rows', () => {
  assert.strictEqual(statsFromBcy({ address: ADDR_GENESIS, balance: 1, n_tx: 1 }).unconfirmedHint, false);
  assert.strictEqual(statsFromBcy({ address: ADDR_GENESIS, balance: 1, n_tx: 1, unconfirmed_n_tx: 1 }).unconfirmedHint, true);
  assert.strictEqual(statsFromBcy({ address: ADDR_GENESIS, balance: 1, n_tx: 1, unconfirmed_balance: -5000 }).unconfirmedHint, true);
  assert.strictEqual(statsFromBci({ address: ADDR_GENESIS, final_balance: 1, n_tx: 1 }).unconfirmedHint, false);
  assert.strictEqual(
    statsFromEsplora({ address: ADDR_GENESIS, chain_stats: { funded_txo_sum: 1, tx_count: 1 }, mempool_stats: { tx_count: 2 } }).unconfirmedHint,
    true,
  );
  assert.strictEqual(
    statsFromEsplora({ address: ADDR_GENESIS, chain_stats: { funded_txo_sum: 1, tx_count: 1 }, mempool_stats: { tx_count: 0 } }).unconfirmedHint,
    false,
  );
});

test('dormant: bcyRefsToWalk dates spends inline and only hasMore:false completes', () => {
  const now = 1700000000000;
  const page = bcyRefsToWalk({
    unconfirmed_txrefs: [{ tx_hash: 'cc', tx_input_n: 1, tx_output_n: -1, block_height: null }],
    txrefs: [
      { tx_hash: 'aa', tx_input_n: -1, tx_output_n: 0, block_height: 970755, confirmed: '2025-06-01T00:00:00.000Z' },
      { tx_hash: 'bb', tx_input_n: 3, tx_output_n: -1, block_height: 970700, confirmed: '2025-05-01T00:00:00.000Z' },
    ],
    hasMore: true,
  }, now);
  assert.strictEqual(page.hasMore, true);
  assert.strictEqual(page.minHeight, 970700);
  assert.strictEqual(page.refs.length, 3);
  assert.strictEqual(page.refs[0].key, 'cc:1:-1');
  assert.strictEqual(page.refs[0].ms, now); // mempool refs are "now"
  assert.strictEqual(page.refs[0].isSpend, true);
  assert.strictEqual(page.refs[1].isSpend, false); // tx_input_n === -1 is a receive
  assert.strictEqual(page.refs[1].ms, Date.parse('2025-06-01T00:00:00.000Z'));
  assert.strictEqual(page.refs[2].isSpend, true); // tx_input_n >= 0 is a spend
  assert.strictEqual(page.refs[2].key, 'bb:3:-1');
  assert.strictEqual(bcyRefsToWalk({ txrefs: [], hasMore: false }, now).hasMore, false);
  assert.strictEqual(bcyRefsToWalk({ txrefs: [] }, now).hasMore, true); // absent keeps paging
  assert.strictEqual(bcyRefsToWalk(null, now).hasMore, false);
  assert.strictEqual(bcyRefsToWalk(null, now).refs.length, 0);
});

test('dormant: foldWalkRefs dedupes by ref key and reports a stuck cursor', () => {
  const state = newWalkState();
  const refs = [
    { key: 'a:0:1', ms: 300, isSpend: true, height: 30 },
    { key: 'b:-1:0', ms: 200, isSpend: false, height: 20 },
    { key: 'c:-1:0', ms: 100, isSpend: false, height: 10 },
  ];
  assert.strictEqual(foldWalkRefs(state, refs), true);
  assert.strictEqual(state.newestSpendMs, 300);
  assert.strictEqual(state.oldestSeenMs, 100);
  assert.strictEqual(state.newestSeenMs, 300);
  // the before=minHeight+1 cursor re-delivers the boundary height: pure
  // duplicates must not grow the state and must read as stuck
  assert.strictEqual(foldWalkRefs(state, refs), false);
  assert.strictEqual(foldWalkRefs(state, [{ key: 'd:-1:0', ms: 50, isSpend: true, height: 5 }]), true);
  assert.strictEqual(state.newestSpendMs, 300); // an older spend never beats the newest
  assert.strictEqual(state.oldestSeenMs, 50);
  assert.strictEqual(state.seen.size, 4);
});

test('dormant: resolveLastActive never overstates dormancy on undated spends', () => {
  const now = 1700000000000;
  const first = 1200000000000;
  // never spent: dormant since first funding
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: first, nowMs: now }),
    { lastActiveMs: first, spendUndated: false },
  );
  // a dated walk spend wins (max over tracked + walk)
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: first, trackedSpendMs: 1400000000000, walkSpendMs: 1500000000000, spendPossible: true, nowMs: now }),
    { lastActiveMs: 1500000000000, spendUndated: false },
  );
  // a tracked-out spend alone is exact
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: first, trackedSpendMs: 1400000000000, nowMs: now }),
    { lastActiveMs: 1400000000000, spendUndated: false },
  );
  // THE v1/v2 BUG this replaces: an undated spend must NOT fall back to
  // firstSeenMs - the walk window's oldest tx is the safe bound instead
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: first, spendPossible: true, walkOldestMs: 1300000000000, nowMs: now }),
    { lastActiveMs: 1300000000000, spendUndated: true },
  );
  // the bound never lands before a dated tracked spend
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: first, trackedSpendMs: 1350000000000, spendPossible: true, walkOldestMs: 1300000000000, nowMs: now }),
    { lastActiveMs: 1350000000000, spendUndated: true },
  );
  // no walk window at all: the only safe answer is "now"
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: first, spendPossible: true, nowMs: now }),
    { lastActiveMs: now, spendUndated: true },
  );
  // a complete walk that saw no spend settles the contradiction conservatively
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: first, spendPossible: true, walkComplete: true, walkOldestMs: 1100000000000, nowMs: now }),
    { lastActiveMs: now, spendUndated: true },
  );
  // nothing datable at all: no dormancy claim
  assert.deepStrictEqual(
    resolveLastActive({ nowMs: now }),
    { lastActiveMs: now, spendUndated: true },
  );
});

test('dormant: resolveLastActive treats a funding-reaching window as whole history', () => {
  const firstSeen = 1231567611000;
  const now = firstSeen + 10 * 365.25 * 24 * 3600 * 1000;
  // Quiet row, window bottom == first funding, hasMore never closed the walk:
  // nothing can hide below the first tx ever - exact funding date, no marker.
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: firstSeen, spendPossible: true, walkOldestMs: firstSeen, walkComplete: false, nowMs: now }),
    { lastActiveMs: firstSeen, spendUndated: false },
  );
  // Window bottom ABOVE funding: an undated spend can hide below - keep the
  // understated bound and the disclosure marker.
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: firstSeen, spendPossible: true, walkOldestMs: firstSeen + 30 * 864e5, walkComplete: false, nowMs: now }),
    { lastActiveMs: firstSeen + 30 * 864e5, spendUndated: true },
  );
  // Covered window with a dated tracked spend: the spend wins.
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: firstSeen, trackedSpendMs: firstSeen + 864e5, spendPossible: true, walkOldestMs: firstSeen, walkComplete: false, nowMs: now }),
    { lastActiveMs: firstSeen + 864e5, spendUndated: false },
  );
  // Stats-reported spend the walk never saw (spendEvidence): its date is
  // unknown even on a funding-reaching window - the marker stays.
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: firstSeen, spendPossible: true, spendEvidence: true, walkOldestMs: firstSeen, walkComplete: false, nowMs: now }),
    { lastActiveMs: firstSeen, spendUndated: true },
  );
  // ...and a complete walk that still contradicts stats settles at "now".
  assert.deepStrictEqual(
    resolveLastActive({ firstSeenMs: firstSeen, spendPossible: true, spendEvidence: true, walkOldestMs: firstSeen, walkComplete: true, nowMs: now }),
    { lastActiveMs: now, spendUndated: true },
  );
});

test('dormant: host pool fails over and boxes a repeat-offender host', async () => {
  const calls = { A: 0, B: 0 };
  let aFailsLeft = 2;
  const createClient = (base) => ({
    get: async () => {
      calls[base]++;
      if (base === 'A' && aFailsLeft > 0) {
        aFailsLeft--;
        throw new Error('HTTP 503 for A');
      }
      return 'from-' + base;
    },
  });
  const pool = new HostPool({ esploraBases: ['A', 'B'], createClient, log: () => {} });
  assert.strictEqual(await pool.esploraGet('/x', null), 'from-B');
  assert.strictEqual(await pool.esploraGet('/y', null), 'from-B');
  // two consecutive failures put A in the penalty box: not tried at all now
  assert.strictEqual(await pool.esploraGet('/z', null), 'from-B');
  assert.strictEqual(calls.A, 2);
  assert.strictEqual(calls.B, 3);
});

test('dormant: host pool surfaces permanent 4xx without failing over', async () => {
  const calls = { A: 0, B: 0 };
  const createClient = (base) => ({
    get: async () => {
      calls[base]++;
      const err = new Error('HTTP 404 for ' + base);
      err.permanent = true;
      throw err;
    },
  });
  const pool = new HostPool({ esploraBases: ['A', 'B'], createClient, log: () => {} });
  await assert.rejects(() => pool.esploraGet('/x', null), /HTTP 404/);
  assert.strictEqual(calls.A, 1);
  assert.strictEqual(calls.B, 0);
});

test('dormant: harvest extraction checksum-verifies base58 and keeps chains apart', () => {
  const text = `real ${ADDR_GENESIS} fake 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb witness bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4 eth 0x742d35Cc6634C0532925a3b844Bc454e4438f44e`;
  const found = extractAddresses(text);
  assert.strictEqual(found.get(ADDR_GENESIS), 'BTC');
  assert.ok(!found.has('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb'), 'bad-checksum base58 must be dropped');
  assert.strictEqual(found.get('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), 'BTC');
  assert.strictEqual(found.get('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'), 'ETH');
});

test('dormant: harvest tagsFromText claims emit only on-page claims', () => {
  const source = { name: 'Test list', url: 'https://example.test/list', retrievedAt: '2026-10-12T00:00:00Z' };
  const page = `page names ${ADDR_GENESIS} and ${ADDR_GENESIS_COMPRESSED}`;
  const claimed = tagsFromText(page, {
    label: 'Claimed dormant (list)',
    category: 'dormant-claim',
    source,
    claimed: [ADDR_GENESIS, '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'],
  });
  assert.strictEqual(claimed.length, 1, 'absent claim dropped');
  assert.strictEqual(claimed[0].address, ADDR_GENESIS);
  assert.strictEqual(claimed[0].category, 'dormant-claim');
  assert.strictEqual(claimed[0].sources[0].name, 'Test list');

  const listed = tagsFromText(page, { label: 'Listed', source });
  assert.strictEqual(listed.length, 2, 'claimless entries harvest the whole page');
  assert.deepStrictEqual(listed.map((t) => t.address).sort(), [ADDR_GENESIS, ADDR_GENESIS_COMPRESSED].sort());
  assert.strictEqual(listed[0].category, 'unknown');
});

test('dormant: host pool never boxes a rate-limited host - quota is not death', async () => {
  const calls = { A: 0 };
  let limitedLeft = 3;
  const createClient = (base) => ({
    get: async () => {
      calls[base]++;
      if (limitedLeft > 0) {
        limitedLeft--;
        const err = new Error('HTTP 429 for ' + base);
        err.rateLimited = true;
        throw err;
      }
      return 'from-' + base;
    },
  });
  const pool = new HostPool({ esploraBases: ['A'], createClient, log: () => {} });
  // three rate-limit refusals in a row must NOT put A in the penalty box:
  // the 4th call still reaches it and succeeds once its bucket refills
  await assert.rejects(() => pool.esploraGet('/x', null), /HTTP 429/);
  await assert.rejects(() => pool.esploraGet('/y', null), /HTTP 429/);
  await assert.rejects(() => pool.esploraGet('/z', null), /HTTP 429/);
  assert.strictEqual(await pool.esploraGet('/w', null), 'from-A');
  assert.strictEqual(calls.A, 4);
});

(async () => {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('ok   ' + t.name);
    } catch (err) {
      failures++;
      console.error('FAIL ' + t.name);
      console.error(err);
    }
  }
  if (failures) {
    console.error(failures + ' dormant-lib test(s) failed');
    process.exit(1);
  }
  console.log('all dormant-lib tests passed');
})();
