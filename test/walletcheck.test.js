/*
 * Tests for the Wallet Checker (Explore Blockchain): address classification
 * (base58, bech32, bech32m/taproot, Ethereum), address-list parsing, sats/wei
 * formatting, and balance lookups against stubbed APIs including the fallback
 * endpoints and per-row error isolation.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadTool } = require('./harness');

const WWW = path.join(__dirname, '..', 'src', 'www');
const ADDR_LEGACY = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ADDR_SCRIPT = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const ADDR_SEGWIT = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const ADDR_TAPROOT = 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr';
const ADDR_ETH = '0x52908400098527886E0F7030069857D2E4169EE7';

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const openTool = async () => {
  const tool = loadTool();
  await vm.runInContext('setupDom', tool.context)();
  tool.cancelPendingTimers();
  vm.runInContext(fs.readFileSync(path.join(WWW, 'js', 'keys.js'), 'utf8'), tool.context);
  tool.run = (code) => vm.runInContext(code, tool.context);
  return tool;
};

// Minimal fetch-response stand-ins
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
const down = () => {
  throw new Error('connection refused');
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let failures = 0;

test('wallet checker: addresses are classified and checksummed', async () => {
  const tool = await openTool();
  const classify = tool.run('classifyWalletAddress');
  assert.strictEqual(classify(ADDR_LEGACY).network, 'BTC');
  assert.strictEqual(classify(ADDR_SCRIPT).network, 'BTC');
  assert.strictEqual(classify(ADDR_SEGWIT).network, 'BTC');
  // bech32m (taproot) - the bundled bitcoinjs rejects this one
  const taproot = classify(ADDR_TAPROOT);
  assert.strictEqual(taproot.network, 'BTC');
  assert.strictEqual(taproot.address, ADDR_TAPROOT);
  // all-uppercase bech32 is valid and canonicalised to lowercase
  assert.strictEqual(classify('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4').address, ADDR_SEGWIT);
  assert.strictEqual(classify(ADDR_ETH).network, 'ETH');
  assert.strictEqual(classify('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B').network, 'ETH');
  assert.match(classify('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5').error, /checksum/);
  assert.match(classify('Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').error, /mixed-case/);
  assert.match(classify('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx').error, /testnet/);
  assert.match(classify('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn').error, /testnet/);
  assert.match(classify('1BoatSLRHtKNngkdXEeobR76b53LETtpyX').error, /checksum/);
  assert.match(classify('xyz').error, /not a valid/);
  assert.match(classify('0x123').error, /not a valid/);
  assert.match(classify('').error, /empty/);
});

test('wallet checker: addresses are extracted from messy pasted text', async () => {
  const tool = await openTool();
  const extract = tool.run('extractWalletAddresses');
  // A real export sample: addresses mixed with amounts, notes and separators
  const messy = [
    'bc1q7h9egjhxcy4zv3hvlfc0j0g9a7v7ufwvjl6385 | 0.00784083   ',
    '',
    'bc1q3wmekjyxunfc4xe47dkl45ckqugw2nqxv2p75f | 0.00232158',
    'bc1qktds0kvm0a6whay9qz48wvrpv68m3tg09d3qtw | 0.00012772',
    'bc1qc6knfqrwynldkay0y9s5ldq7jadkvd9fkhsd86 | 0.00804999 high   -----',
    '',
    'bc1qxdajpq4l4h5yjsl6aj280hhnudymgedq8yhsrw | 0.01918753',
    'bc1p5akucnl7tasjp7cw0qej6q389hsed54uwham9ucepr4x3lygyz9q0kuvla | 0.00384450',
    'bc1qjqcq6x9e0axx8u36gf6n2nntwhkv8ee024989e | 0.00313381  ok',
  ].join('\n');
  assert.deepStrictEqual(
    Array.from(extract(messy)),
    [
      'bc1q7h9egjhxcy4zv3hvlfc0j0g9a7v7ufwvjl6385',
      'bc1q3wmekjyxunfc4xe47dkl45ckqugw2nqxv2p75f',
      'bc1qktds0kvm0a6whay9qz48wvrpv68m3tg09d3qtw',
      'bc1qc6knfqrwynldkay0y9s5ldq7jadkvd9fkhsd86',
      'bc1qxdajpq4l4h5yjsl6aj280hhnudymgedq8yhsrw',
      'bc1p5akucnl7tasjp7cw0qej6q389hsed54uwham9ucepr4x3lygyz9q0kuvla',
      'bc1qjqcq6x9e0axx8u36gf6n2nntwhkv8ee024989e',
    ]
  );
  // separators and simple lists still work
  assert.deepStrictEqual(
    Array.from(extract(`${ADDR_LEGACY}, ${ADDR_ETH};${ADDR_SCRIPT}\nxyz`)),
    [ADDR_LEGACY, ADDR_ETH, ADDR_SCRIPT]
  );
  // repeats de-dupe case-insensitively
  assert.deepStrictEqual(
    Array.from(extract(`${ADDR_SEGWIT} ${ADDR_SEGWIT.toUpperCase()} ${ADDR_ETH} ${ADDR_ETH}`)),
    [ADDR_SEGWIT, ADDR_ETH]
  );
  // a 32-byte hex txid is not an Ethereum address
  assert.deepStrictEqual(Array.from(extract(`0x${'ab'.repeat(32)} | note`)), []);
  // amounts, notes and empty text extract nothing
  assert.deepStrictEqual(Array.from(extract('0.00784083 high ----- ok')), []);
  assert.deepStrictEqual(Array.from(extract('  \n , ; ')), []);
  assert.deepStrictEqual(Array.from(extract('')), []);
});

test('wallet checker: balances are formatted exactly', async () => {
  const tool = await openTool();
  const btc = tool.run('satsToBtcString');
  const eth = tool.run('weiToEthString');
  assert.strictEqual(btc(0), '0');
  assert.strictEqual(btc(1), '0.00000001');
  assert.strictEqual(btc(100000000), '1');
  assert.strictEqual(btc(12345678), '0.12345678');
  assert.strictEqual(btc(-500), '-0.000005');
  assert.strictEqual(btc(2100000000000000), '21000000');
  assert.strictEqual(eth(BigInt(0)), '0');
  assert.strictEqual(eth(BigInt('1000000000000000')), '0.001');
  assert.strictEqual(eth(BigInt('1500000000000000000')), '1.5');
  assert.strictEqual(eth(BigInt('1000000000000000000')), '1');
  assert.strictEqual(eth(BigInt('123456789012345678901234567890')), '123456789012.34567890123456789');
});

test('wallet checker: USD amounts format cleanly and rates fetch with fallback', async () => {
  const tool = await openTool();
  const formatUsd = tool.run('formatUsd');
  assert.strictEqual(formatUsd(0), '$0.00');
  assert.strictEqual(formatUsd(0.001), '<$0.01');
  assert.strictEqual(formatUsd(1234.5), '$1,234.50');
  assert.strictEqual(formatUsd(1234567.891), '$1,234,567.89');
  assert.strictEqual(formatUsd(-5), '-$5.00');

  const fetchUsdRates = tool.run('fetchUsdRates');
  // CoinGecko answers directly
  let calls = [];
  let rates = await fetchUsdRates(async (url) => {
    calls.push(url);
    return okJson({ bitcoin: { usd: 30000 }, ethereum: { usd: 2000 } });
  });
  assert.strictEqual(rates.btcUsd, 30000);
  assert.strictEqual(rates.ethUsd, 2000);
  assert.match(calls[0], /coingecko/);

  // unusable primary -> Coinbase spot prices
  calls = [];
  rates = await fetchUsdRates(async (url) => {
    calls.push(url);
    if (url.includes('coingecko')) return okJson({});
    return okJson(url.includes('BTC-USD') ? { data: { amount: '31000.25' } } : { data: { amount: '2100.75' } });
  });
  assert.strictEqual(rates.btcUsd, 31000.25);
  assert.strictEqual(rates.ethUsd, 2100.75);
  assert.strictEqual(calls.filter((u) => u.includes('coinbase')).length, 2);

  // both down -> null; rates are optional
  assert.strictEqual(await fetchUsdRates(down), null);
});

test('wallet checker: Bitcoin lookups use Blockstream and fall back to mempool.space', async () => {
  const tool = await openTool();
  const fetchBtcBalance = tool.run('fetchBtcBalance');
  const esplora = {
    chain_stats: { funded_txo_sum: 150000, spent_txo_sum: 50000 },
    mempool_stats: { funded_txo_sum: 2500, spent_txo_sum: 3000 },
  };

  // primary answers
  let calls = [];
  let bal = await fetchBtcBalance(ADDR_LEGACY, async (url) => {
    calls.push(url);
    return okJson(esplora);
  });
  assert.strictEqual(bal.confirmedSats, 100000);
  assert.strictEqual(bal.pendingSats, -500);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /^https:\/\/blockstream\.info\/api\/address\//);

  // primary down -> fallback answers
  calls = [];
  bal = await fetchBtcBalance(ADDR_LEGACY, async (url) => {
    calls.push(url);
    if (url.includes('blockstream')) return down();
    return okJson(esplora);
  });
  assert.strictEqual(bal.confirmedSats, 100000);
  assert.strictEqual(calls.length, 2);
  assert.match(calls[1], /^https:\/\/mempool\.space\/api\/address\//);

  // both down -> throws
  await assert.rejects(fetchBtcBalance(ADDR_LEGACY, down), /connection refused/);
  // malformed (but 200) response -> falls through to fallback, then throws
  await assert.rejects(
    fetchBtcBalance(ADDR_LEGACY, async () => okJson({ oops: true })),
    /unexpected response/
  );
});

test('wallet checker: Ethereum lookups use Cloudflare and fall back to PublicNode', async () => {
  const tool = await openTool();
  const fetchEthBalance = tool.run('fetchEthBalance');

  let calls = [];
  let bal = await fetchEthBalance(ADDR_ETH, async (url, opts) => {
    calls.push(url);
    assert.strictEqual(opts.method, 'POST');
    assert.match(opts.body, /eth_getBalance/);
    return okJson({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' });
  });
  assert.strictEqual(bal.wei, BigInt('1000000000000000000'));
  assert.strictEqual(calls[0], 'https://cloudflare-eth.com');

  // RPC error on the primary -> fallback answers
  calls = [];
  bal = await fetchEthBalance(ADDR_ETH, async (url) => {
    calls.push(url);
    if (url.includes('cloudflare')) return okJson({ error: { message: 'nope' } });
    return okJson({ result: '0x0' });
  });
  assert.strictEqual(bal.wei, BigInt(0));
  assert.strictEqual(calls[1], 'https://ethereum.publicnode.com');

  await assert.rejects(fetchEthBalance(ADDR_ETH, down), /connection refused/);
});

test('wallet checker: a mixed batch renders rows, isolates failures and totals up', async () => {
  const tool = await openTool();
  const calls = [];
  tool.context.fetch = async (url) => {
    calls.push(String(url));
    if (url.includes('blockstream') && url.includes(ADDR_LEGACY))
      return okJson({
        chain_stats: { funded_txo_sum: 150000, spent_txo_sum: 50000 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      });
    if (url.includes('cloudflare-eth'))
      return okJson({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' });
    if (url.includes('coingecko'))
      return okJson({ bitcoin: { usd: 30000 }, ethereum: { usd: 2000 } });
    return down();
  };
  tool.document.getElementById('walletCheckInput').value = [
    `${ADDR_LEGACY} | 0.00784083`,
    `${ADDR_ETH}, ${ADDR_SCRIPT}`,
    ADDR_LEGACY, // duplicate on purpose - must not double-count
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', // corrupted checksum
    '0.00804999 high   -----', // junk line - ignored
  ].join('\n');
  const rows = Array.from(await tool.run('walletCheckRun')());
  assert.strictEqual(rows.length, 4);
  // biggest first: the ETH row ($2,000) ranks above the BTC row ($30);
  // error rows have no balance and keep input order at the bottom
  assert.strictEqual(rows[0].wei, BigInt('1000000000000000000'));
  assert.strictEqual(rows[1].confirmedSats, 100000);
  assert.match(rows[2].error, /lookup failed/);
  assert.match(rows[3].error, /checksum/);
  const html = tool.document.getElementById('walletCheckResults').innerHTML;
  assert.match(html, /wallet-table/);
  assert.match(html, /0\.001 BTC ≈ \$30\.00/);
  assert.match(html, /1 ETH ≈ \$2,000\.00/);
  assert.match(html, /0\.001 BTC ≈ \$30\.00 across 1 address/);
  assert.match(html, /1 ETH ≈ \$2,000\.00 across 1 address/);
  assert.match(html, /≈ \$2,030\.00 total/);
});

test('wallet checker: results are sorted by balance, biggest first', async () => {
  const corrupted = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5';
  // with rates: rows compare in USD across chains, error row pinned to the bottom
  const tool = await openTool();
  tool.context.fetch = async (url) => {
    const s = String(url);
    if (s.includes('coingecko')) return okJson({ bitcoin: { usd: 30000 }, ethereum: { usd: 2000 } });
    if (s.includes('cloudflare-eth')) return okJson({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' });
    if (s.includes('blockstream') && s.includes(ADDR_SEGWIT))
      return okJson({ chain_stats: { funded_txo_sum: 20000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } });
    if (s.includes('blockstream') && s.includes(ADDR_SCRIPT))
      return okJson({ chain_stats: { funded_txo_sum: 500000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } });
    if (s.includes('blockstream') && s.includes(ADDR_LEGACY))
      return okJson({ chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } });
    return down();
  };
  tool.document.getElementById('walletCheckInput').value = [
    ADDR_SEGWIT, // $0.60
    ADDR_SCRIPT, // $15
    ADDR_ETH, // $2,000
    ADDR_LEGACY, // $3
    corrupted,
  ].join('\n');
  const rows = Array.from(await tool.run('walletCheckRun')());
  assert.deepStrictEqual(
    Array.from(rows, (r) => r.raw),
    [ADDR_ETH, ADDR_SCRIPT, ADDR_LEGACY, ADDR_SEGWIT, corrupted]
  );
  const html = tool.document.getElementById('walletCheckResults').innerHTML;
  assert.ok(html.indexOf(ADDR_ETH) < html.indexOf(ADDR_SCRIPT));
  assert.ok(html.indexOf(ADDR_SCRIPT) < html.indexOf(ADDR_LEGACY));
  assert.ok(html.indexOf(ADDR_LEGACY) < html.indexOf(ADDR_SEGWIT));
  assert.ok(html.indexOf(ADDR_SEGWIT) < html.indexOf(corrupted));

  // rate APIs down (fresh tool = fresh rate cache): native amounts still rank
  const bare = await openTool();
  bare.context.fetch = async (url) => {
    const s = String(url);
    if (s.includes('blockstream') && s.includes(ADDR_SEGWIT))
      return okJson({ chain_stats: { funded_txo_sum: 500000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } });
    if (s.includes('blockstream') && s.includes(ADDR_LEGACY))
      return okJson({ chain_stats: { funded_txo_sum: 100000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } });
    return down();
  };
  bare.document.getElementById('walletCheckInput').value = `${ADDR_LEGACY}\n${ADDR_SEGWIT}`;
  const bareRows = Array.from(await bare.run('walletCheckRun')());
  assert.deepStrictEqual(
    Array.from(bareRows, (r) => r.raw),
    [ADDR_SEGWIT, ADDR_LEGACY]
  );
  assert.doesNotMatch(bare.document.getElementById('walletCheckResults').innerHTML, /≈/);
});

test('wallet checker: USD figures are skipped when rate APIs are down', async () => {
  const tool = await openTool();
  tool.context.fetch = async (url) => {
    if (url.includes('blockstream') && url.includes(ADDR_LEGACY))
      return okJson({
        chain_stats: { funded_txo_sum: 150000, spent_txo_sum: 50000 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      });
    return down();
  };
  tool.document.getElementById('walletCheckInput').value = ADDR_LEGACY;
  const rows = Array.from(await tool.run('walletCheckRun')());
  assert.strictEqual(rows[0].confirmedSats, 100000);
  const html = tool.document.getElementById('walletCheckResults').innerHTML;
  assert.match(html, /0\.001 BTC/);
  assert.doesNotMatch(html, /≈/);
});

test('wallet checker: batch cap, empty input, and Clear / Clear seed', async () => {
  // (kept as the last test on purpose: it also exercises wipeAllSeedMaterial)
  const tool = await openTool();
  let fetches = 0;
  tool.context.fetch = async () => {
    fetches += 1;
    return okJson({});
  };
  const input = tool.document.getElementById('walletCheckInput');
  const errorEl = tool.document.getElementById('walletCheckError');

  input.value = Array.from({ length: 101 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`).join(' ');
  assert.strictEqual((await tool.run('walletCheckRun')()).length, 0);
  assert.match(errorEl.textContent, /limit is 100/);
  assert.strictEqual(fetches, 0);

  input.value = 'high   ----- 0.0078 ok';
  assert.strictEqual((await tool.run('walletCheckRun')()).length, 0);
  assert.match(errorEl.textContent, /No Bitcoin or Ethereum addresses/);

  input.value = ' ';
  assert.strictEqual((await tool.run('walletCheckRun')()).length, 0);
  assert.match(errorEl.textContent, /at least one/);

  tool.run('walletCheckRender')([{ raw: ADDR_ETH, network: 'ETH', wei: BigInt(0) }]);
  assert.match(tool.document.getElementById('walletCheckResults').innerHTML, /wallet-table/);
  input.value = ADDR_ETH;
  errorEl.textContent = 'boom';
  tool.run('walletCheckClear')();
  assert.strictEqual(input.value, '');
  assert.strictEqual(errorEl.textContent, '');
  assert.strictEqual(tool.document.getElementById('walletCheckResults').innerHTML, '');

  // Clear seed must wipe the checker too (the modal promises all tool input)
  input.value = ADDR_ETH;
  tool.document.getElementById('walletCheckResults').innerHTML = '<p>leftover</p>';
  tool.run('wipeAllSeedMaterial')();
  assert.strictEqual(input.value, '');
  assert.strictEqual(tool.document.getElementById('walletCheckResults').innerHTML, '');
});

(async () => {
  console.log('wallet checker');
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL ${name}`);
      console.error(`       ${err.message}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tests passed');
})();
