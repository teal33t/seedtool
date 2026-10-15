/*
 * Tests for the Dormant Wallets Research UI (dormant.js): threshold
 * re-filtering (dormant-years + min-balance), category and text filters,
 * sorting, numbered pagination, tag chips, row accordion with source
 * citations, and the export builders. The snapshot comes from a stubbed
 * same-origin fetch - no network is touched.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadTool } = require('./harness');

const WWW = path.join(__dirname, '..', 'src', 'www');

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const SNAPSHOT = {
  schemaVersion: 1,
  generatedAt: '2026-10-10T00:00:00.000Z',
  minDormantYears: 5,
  totalPool: 5,
  count: 5,
  priceUsd: 100000,
  priceAt: '2026-10-10T00:00:00.000Z',
  priceSource: 'test-feed',
  wallets: [
    {
      address: '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF',
      chain: 'BTC',
      balanceSats: 800000000000,
      balanceBtc: 8000,
      firstSeen: '2011-06-01T00:00:00.000Z',
      lastActive: '2011-06-02T00:00:00.000Z',
      dormantYears: 15.3,
      txCount: 1,
      spendUndated: true,
      tags: [
        { label: 'MtGox hack (2011 theft)', category: 'hack-theft', confidence: 'corroborated', sources: [{ name: 'WizSec', url: 'https://example.test/wizsec', retrievedAt: '2026-10-10T00:00:00.000Z' }] },
      ],
    },
    {
      address: '1LazarusGroupAddressXXXXXXXXXXXXXAA',
      chain: 'BTC',
      balanceSats: 50000000000,
      balanceBtc: 500,
      firstSeen: '2010-01-01T00:00:00.000Z',
      lastActive: '2011-01-01T00:00:00.000Z',
      dormantYears: 15.8,
      txCount: 2,
      firstSeenExact: false,
      tags: [
        { label: 'OFAC SDN: Lazarus Group', category: 'sanctions', confidence: 'corroborated', sources: [{ name: 'OFAC', url: 'https://example.test/ofac', retrievedAt: '2026-10-10T00:00:00.000Z' }] },
      ],
    },
    {
      address: '1EarlyMinerXXXXXXXXXXXXXXXXXXXXXX',
      chain: 'BTC',
      balanceSats: 5000000000,
      balanceBtc: 50,
      firstSeen: '2009-02-01T00:00:00.000Z',
      lastActive: '2009-02-01T00:00:00.000Z',
      dormantYears: 17.7,
      txCount: 1,
      blockHeight: 321,
      minedSats: 5000000000,
      txid: 'e1cf3476234d8446653ad52a8939ed792003eefdcd0e897319ab9d2cb4c14c8c',
      voutIndex: 0,
      spent: false,
      firstSeenExact: true,
      tags: [
        { label: 'Early miner (2009-2011 era)', category: 'early-miner', confidence: 'single-source', sources: [{ name: 'Esplora', url: 'https://example.test/tx', retrievedAt: '2026-10-10T00:00:00.000Z' }] },
      ],
    },
    {
      address: '1RecentlyActiveXXXXXXXXXXXXXXXXXX',
      chain: 'BTC',
      balanceSats: 100000000000,
      balanceBtc: 1000,
      firstSeen: '2015-01-01T00:00:00.000Z',
      lastActive: '2025-06-01T00:00:00.000Z',
      dormantYears: 1.3,
      txCount: 9,
      tags: [],
    },
    {
      address: '1TinyBalanceXXXXXXXXXXXXXXXXXXXXX',
      chain: 'BTC',
      balanceSats: 50000000,
      balanceBtc: 0.5,
      firstSeen: '2011-01-01T00:00:00.000Z',
      lastActive: '2011-01-01T00:00:00.000Z',
      dormantYears: 15.7,
      txCount: 1,
      tags: [
        { label: 'Silk Road <script>market</script>', category: 'darknet', confidence: 'single-source', sources: [] },
      ],
    },
  ],
};

const openTool = async () => {
  const tool = loadTool();
  await vm.runInContext('setupDom', tool.context)();
  tool.cancelPendingTimers();
  tool.context.fetch = async () => ({ ok: true, status: 200, json: async () => SNAPSHOT });
  vm.runInContext(fs.readFileSync(path.join(WWW, 'js', 'dormant.js'), 'utf8'), tool.context);
  tool.run = (code) => vm.runInContext(code, tool.context);
  // The harness stubs start with value:''; a real DOM would honour the
  // value="" attributes from dev.html.
  tool.run('document.getElementById("dormantYearsInput").value = "5"');
  tool.run('document.getElementById("dormantMinBtcInput").value = "10"');
  tool.run('document.getElementById("dormantSort").value = "balance"');
  return tool;
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('dormant: default thresholds hide recent and low-balance wallets', async () => {
  const tool = await openTool();
  const filter = tool.run('dormantFilterSort');
  const got = filter(SNAPSHOT.wallets, { minYears: 5, minBtc: 10, query: '', category: 'all', sort: 'balance' });
  const addrs = got.map((w) => w.address);
  assert.strictEqual(addrs.length, 3);
  assert.ok(addrs.includes('1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF'));
  assert.ok(addrs.includes('1LazarusGroupAddressXXXXXXXXXXXXXAA'));
  assert.ok(addrs.includes('1EarlyMinerXXXXXXXXXXXXXXXXXXXXXX'));
  assert.ok(!addrs.includes('1RecentlyActiveXXXXXXXXXXXXXXXXXX'));
  assert.ok(!addrs.includes('1TinyBalanceXXXXXXXXXXXXXXXXXXXXX'));
  // balance desc: 8000, 500, 50
  assert.deepStrictEqual(addrs.map((a) => SNAPSHOT.wallets.find((w) => w.address === a).balanceBtc), [8000, 500, 50]);
});

test('dormant: thresholds are adjustable from the UI inputs', async () => {
  const tool = await openTool();
  const filter = tool.run('dormantFilterSort');
  // Raise the dormancy floor: only the two 15y+ wallets above 50 BTC... all 3 qualify at 15; at 15.5 only two
  const strict = filter(SNAPSHOT.wallets, { minYears: 15.5, minBtc: 10, query: '', category: 'all', sort: 'balance' });
  assert.deepStrictEqual(strict.map((w) => w.address), ['1LazarusGroupAddressXXXXXXXXXXXXXAA', '1EarlyMinerXXXXXXXXXXXXXXXXXXXXXX']);
  // Drop the balance floor to zero: the tiny-balance wallet joins
  const wide = filter(SNAPSHOT.wallets, { minYears: 5, minBtc: 0, query: '', category: 'all', sort: 'balance' });
  assert.strictEqual(wide.length, 4);
  assert.ok(wide.some((w) => w.address === '1TinyBalanceXXXXXXXXXXXXXXXXXXXXX'));
});

test('dormant: category chips filter and search matches address or tag', async () => {
  const tool = await openTool();
  const filter = tool.run('dormantFilterSort');
  const san = filter(SNAPSHOT.wallets, { minYears: 5, minBtc: 0, category: 'sanctions', sort: 'balance' });
  assert.deepStrictEqual(san.map((w) => w.address), ['1LazarusGroupAddressXXXXXXXXXXXXXAA']);
  const hack = filter(SNAPSHOT.wallets, { minYears: 5, minBtc: 0, category: 'hack-theft', sort: 'balance' });
  assert.deepStrictEqual(hack.map((w) => w.address), ['1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF']);
  const byTag = filter(SNAPSHOT.wallets, { minYears: 5, minBtc: 0, query: 'lazarus', sort: 'balance' });
  assert.strictEqual(byTag.length, 1);
  const byAddr = filter(SNAPSHOT.wallets, { minYears: 5, minBtc: 0, query: '1feex', sort: 'balance' });
  assert.strictEqual(byAddr.length, 1);
  assert.strictEqual(byAddr[0].address, '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF');
});

test('dormant: sort orders work for years, last-active and first-seen', async () => {
  const tool = await openTool();
  const filter = tool.run('dormantFilterSort');
  const base = { minYears: 5, minBtc: 0, query: '', category: 'all' };
  const byYears = filter(SNAPSHOT.wallets, { ...base, sort: 'years' });
  assert.deepStrictEqual(byYears.map((w) => w.address), [
    '1EarlyMinerXXXXXXXXXXXXXXXXXXXXXX', '1LazarusGroupAddressXXXXXXXXXXXXXAA', '1TinyBalanceXXXXXXXXXXXXXXXXXXXXX', '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF',
  ]);
  const byLast = filter(SNAPSHOT.wallets, { ...base, sort: 'last' });
  assert.strictEqual(byLast[0].address, '1EarlyMinerXXXXXXXXXXXXXXXXXXXXXX');
  assert.strictEqual(byLast[byLast.length - 1].address, '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF');
  const byFirst = filter(SNAPSHOT.wallets, { ...base, sort: 'first' });
  assert.strictEqual(byFirst[0].address, '1EarlyMinerXXXXXXXXXXXXXXXXXXXXXX');
});

test('dormant: rows link to the block explorer and escape tag markup', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('document.getElementById("dormantMinBtcInput").value = "0"');
  tool.run('dormantApply()');
  const html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.match(html, /href="https:\/\/blockstream\.info\/address\/1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  // the darknet label contains <script> in the fixture - it must be escaped in the chip title
  assert.ok(!html.includes('<script>market</script>'));
  assert.ok(html.includes('Silk Road &lt;script&gt;'));
  assert.match(html, /onclick="dormantShowDetail\(\+this\.dataset\.idx\)"/);
});

test('dormant: snapshot info and summary reflect the pool', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  const info = tool.run('document.getElementById("dormantSnapshotInfo").textContent');
  assert.match(info, /2026-10-10/);
  assert.match(info, /5 dormant wallets/);
  const summary = tool.run('document.getElementById("dormantSummary").textContent');
  assert.match(summary, /3 wallets match/);
});

test('dormant: detail panel lists every tag with its source citation', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('dormantShowDetail(0)');
  const html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.match(html, /MtGox hack \(2011 theft\)/);
  assert.match(html, /corroborated/);
  assert.match(html, /href="https:\/\/example\.test\/wizsec"/);
  assert.match(html, /retrieved 2026-10-10/);
  assert.match(html, /Open on block explorer/);
  // a tagged row has no mining provenance block
  assert.ok(!html.includes('View the coinbase output'));
});

test('dormant: detail panel explains mined pay-to-pubkey outputs', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('dormantShowDetail(2)'); // the early-miner row after the default sort
  const html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.match(html, /Mined 50\.00000000 BTC/);
  assert.match(html, /in block 321/);
  assert.match(html, /coins unspent since 2009-02-01/);
  assert.match(html, /href="https:\/\/blockstream\.info\/tx\/e1cf3476234d8446653ad52a8939ed792003eefdcd0e897319ab9d2cb4c14c8c"/);
  assert.match(html, /View the coinbase output/);
  assert.match(html, /pay-to-pubkey label for a mining output/);
});

test('dormant: detail panel discloses upper-bound first-seen and undated spends', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('dormantShowDetail(0)'); // the undated-spend row
  let html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.match(html, /Last-moved date is an upper bound/);
  assert.ok(!html.includes('First-seen date is an upper bound'));
  tool.run('dormantShowDetail(1)'); // the inexact first-seen row
  html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.match(html, /First-seen date is an upper bound/);
  assert.ok(!html.includes('Last-moved date is an upper bound'));
  tool.run('dormantShowDetail(2)'); // the exact early-miner row shows neither
  html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(!html.includes('date is an upper bound'));
});

test('dormant: exports carry the filtered set with tags and citations', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  const csv = tool.run('dormantExportCsv()');
  assert.match(csv, /"address","balanceBtc","balanceUsd","dormantYears","firstSeen","lastActive","txCount","tags","txid","minedSats"/);
  assert.match(csv, /"800000000\.00"/); // 8000 BTC at the fixture's snapshot price
  assert.match(csv, /MtGox hack \(2011 theft\) \(hack-theft\/corroborated\)/);
  assert.match(csv, /e1cf3476234d8446653ad52a8939ed792003eefdcd0e897319ab9d2cb4c14c8c/); // mined row carries its coinbase txid
  assert.ok(csv.trim().split('\n').length >= 4); // header + 3 matches
  const json = JSON.parse(tool.run('dormantExportJson()'));
  assert.strictEqual(json.count, 3);
  assert.strictEqual(json.generatedAt, '2026-10-10T00:00:00.000Z');
  assert.strictEqual(json.priceUsd, 100000);
  assert.strictEqual(json.wallets[0].balanceBtc, 8000);
});

test('dormant: empty thresholds show the whole pool until the user fills them', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('document.getElementById("dormantYearsInput").value = ""');
  tool.run('document.getElementById("dormantMinBtcInput").value = ""');
  tool.run('dormantApply()');
  const summary = tool.run('document.getElementById("dormantSummary").textContent');
  assert.match(summary, /5 wallets match/);
  const html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(html.includes('1TinyBalance')); // dust row joins with no minimum
  assert.ok(html.includes('1RecentlyActive')); // recent row joins with no dormancy floor
  // Reset restores the blank state, not the old 5y/10BTC defaults
  tool.run('dormantReset()');
  assert.strictEqual(tool.run('document.getElementById("dormantYearsInput").value'), '');
  assert.strictEqual(tool.run('document.getElementById("dormantMinBtcInput").value'), '');
  assert.match(tool.run('document.getElementById("dormantSummary").textContent'), /5 wallets match/);
});

test('dormant: USD values come from the snapshot price, never a live rate', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('document.getElementById("dormantYearsInput").value = ""');
  tool.run('document.getElementById("dormantMinBtcInput").value = ""');
  tool.run('dormantApply()');
  const html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(html.includes('$800,000,000')); // 8000 BTC at the fixture's 100k price
  assert.ok(html.includes('$50,000')); // 0.5 BTC row formats at the same price
  const summary = tool.run('document.getElementById("dormantSummary").textContent');
  assert.match(summary, /\(≈ \$955,050,000\)/); // 9550.5 BTC total at the snapshot price
  const rate = tool.run('document.getElementById("dormantRateNote").innerHTML');
  assert.match(rate, /1 BTC = \$100,000/);
  assert.match(rate, /reported by test-feed/);
  assert.match(rate, /captured 2026-10-10 00:00 UTC/);
  assert.match(rate, /Not a live rate/);
  assert.strictEqual(tool.run('document.getElementById("dormantRateNote").hidden'), false);
  tool.run('dormantShowDetail(0)');
  const detail = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.match(detail, /\$800,000,000 at snapshot price/);
});

test('dormant: snapshots without a captured price degrade gracefully', async () => {
  const tool = await openTool();
  tool.context.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ...SNAPSHOT, priceUsd: null, priceAt: null, priceSource: null }),
  });
  await tool.run('initDormant()');
  tool.run('document.getElementById("dormantYearsInput").value = ""');
  tool.run('document.getElementById("dormantMinBtcInput").value = ""');
  tool.run('dormantApply()');
  const html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(!html.includes('$')); // no USD cells invented
  const summary = tool.run('document.getElementById("dormantSummary").textContent');
  assert.ok(!summary.includes('≈'));
  const rate = tool.run('document.getElementById("dormantRateNote").innerHTML');
  assert.match(rate, /USD amounts unavailable/);
});

test('dormant: missing snapshot degrades to an honest message', async () => {
  const tool = loadTool();
  await vm.runInContext('setupDom', tool.context)();
  tool.cancelPendingTimers();
  tool.context.fetch = async () => { throw new Error('connection refused'); };
  vm.runInContext(fs.readFileSync(path.join(WWW, 'js', 'dormant.js'), 'utf8'), tool.context);
  await vm.runInContext('initDormant()', tool.context);
  const info = vm.runInContext('document.getElementById("dormantSnapshotInfo").textContent', tool.context);
  assert.match(info, /could not be loaded/);
});

test('dormant: page-number window shows neighbors, edges and gaps', async () => {
  const tool = await openTool();
  const nums = (page, total) => tool.run(`JSON.stringify(dormantPageNumbers(${page}, ${total}))`);
  assert.strictEqual(nums(0, 88), '[0,1,2,3,"…",87]');
  assert.strictEqual(nums(40, 88), '[0,"…",39,40,41,"…",87]');
  assert.strictEqual(nums(86, 88), '[0,"…",84,85,86,87]');
  assert.strictEqual(nums(0, 1), '[0]');
  assert.strictEqual(nums(0, 4), '[0,1,2,3]'); // short lists never gap
  assert.strictEqual(nums(3, 4), '[0,1,2,3]');
});

test('dormant: numbered pagination jumps pages and clamps at the edges', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('dormantState.filtered = new Array(120).fill(0).map((_, i) => ({ address: "1Fake" + i, balanceBtc: 1, tags: [] }))');
  tool.run('dormantGoPage(2)');
  const pager = tool.run('document.getElementById("dormantPagerTop").innerHTML');
  assert.match(pager, /Page 3 of 3/);
  assert.match(pager, /class="dormant-page active" onclick="dormantGoPage\(2\)"/); // page 3 button is the current one
  assert.match(pager, /aria-current="page"/);
  const rows = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(rows.includes('1Fake100')); // page 3 holds rows 100..119
  assert.ok(rows.includes('1Fake119'));
  assert.ok(!rows.includes('>1Fake0<'));
  tool.run('dormantGoPage(99)'); // past the end clamps to the last page
  assert.match(tool.run('document.getElementById("dormantPagerTop").innerHTML'), /Page 3 of 3/);
  tool.run('dormantGoPage(-5)'); // before the start clamps to the first page
  assert.match(tool.run('document.getElementById("dormantPagerTop").innerHTML'), /Page 1 of 3/);
});

test('dormant: row accordion opens below its row and closes on second click', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('dormantShowDetail(0)');
  let html = tool.run('document.getElementById("dormantRows").innerHTML');
  const openAt = html.indexOf('<tr class="dormant-acc">');
  assert.ok(openAt > 0, 'accordion row emitted');
  assert.ok(html.indexOf('data-idx="0"') < openAt, 'accordion sits below its own wallet row');
  assert.match(html, /dormant-row open/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /\$800,000,000 at snapshot price/);
  // clicking another row moves the accordion - one row open at a time
  tool.run('dormantShowDetail(1)');
  html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.strictEqual((html.match(/<tr class="dormant-acc">/g) || []).length, 1);
  assert.ok(html.indexOf('data-idx="1"') < html.indexOf('<tr class="dormant-acc">'));
  assert.match(html, /First-seen date is an upper bound/); // the Lazarus row's detail
  assert.ok(!html.includes('$800,000,000 at snapshot price'));
  // clicking the open row again closes it
  tool.run('dormantShowDetail(1)');
  html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(!html.includes('dormant-acc'));
  assert.match(html, /aria-expanded="false"/);
});

test('dormant: sort direction flips the amount order, defaults preserved', async () => {
  const tool = await openTool();
  const filter = tool.run('dormantFilterSort');
  const base = { minYears: 5, minBtc: 0, query: '', category: 'all', sort: 'balance' };
  const desc = filter(SNAPSHOT.wallets, { ...base, dir: 'desc' });
  assert.deepStrictEqual(desc.map((w) => w.balanceBtc), [8000, 500, 50, 0.5]);
  const asc = filter(SNAPSHOT.wallets, { ...base, dir: 'asc' });
  assert.deepStrictEqual(asc.map((w) => w.balanceBtc), [0.5, 50, 500, 8000]);
  // no dir passed keeps the original fixed orders
  assert.deepStrictEqual(filter(SNAPSHOT.wallets, base).map((w) => w.balanceBtc), [8000, 500, 50, 0.5]);
  const byLast = filter(SNAPSHOT.wallets, { ...base, sort: 'last' });
  assert.strictEqual(byLast[0].address, '1EarlyMinerXXXXXXXXXXXXXXXXXXXXXX'); // oldest first
  const wide = { ...base, minYears: 0 };
  const byLastDesc = filter(SNAPSHOT.wallets, { ...wide, sort: 'last', dir: 'desc' });
  assert.strictEqual(byLastDesc[0].address, '1RecentlyActiveXXXXXXXXXXXXXXXXXX'); // newest first
  const byYearsAsc = filter(SNAPSHOT.wallets, { ...wide, sort: 'years', dir: 'asc' });
  assert.strictEqual(byYearsAsc[0].address, '1RecentlyActiveXXXXXXXXXXXXXXXXXX'); // shortest dormant first
});

test('dormant: direction toggle flips the rendered order and its label', async () => {
  const tool = await openTool();
  await tool.run('initDormant()');
  tool.run('document.getElementById("dormantMinBtcInput").value = ""');
  tool.run('dormantApply()'); // 4 matches, biggest first by default
  let html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(html.indexOf('1Feex') < html.indexOf('1TinyBalance'));
  assert.match(tool.run('document.getElementById("dormantDirBtn").textContent'), /biggest first/);
  tool.run('dormantToggleDir()'); // ascending by amount
  html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(html.indexOf('1TinyBalance') < html.indexOf('1Feex'));
  assert.match(tool.run('document.getElementById("dormantDirBtn").textContent'), /smallest first/);
  tool.run('dormantToggleDir()'); // and back
  html = tool.run('document.getElementById("dormantRows").innerHTML');
  assert.ok(html.indexOf('1Feex') < html.indexOf('1TinyBalance'));
  tool.run('dormantReset()'); // reset restores the default direction
  assert.match(tool.run('document.getElementById("dormantDirBtn").textContent'), /biggest first/);
});

let failures = 0;
(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   ' + name);
    } catch (err) {
      failures++;
      console.error('FAIL ' + name);
      console.error(err);
    }
  }
  if (failures) {
    console.error(failures + ' dormant-ui test(s) failed');
    process.exit(1);
  }
  console.log('all dormant-ui tests passed');
})();
