/*
 * Dormant Wallets Research - browses the shipped data/dormant-wallets.json
 * snapshot (fetched same-origin once). Everything else happens in the page:
 * threshold filters re-run in memory, exports are generated locally, and the
 * only online actions are the user clicking an address out to a block
 * explorer. Balances and dates are snapshot values, not live chain data.
 */

const DORMANT_PAGE_SIZE = 50;
const DORMANT_YEAR_MS = 365.25 * 24 * 3600 * 1000;
// Fixed display order; unknown categories get appended after these.
const DORMANT_CATEGORY_ORDER = [
  'sanctions', 'hack-theft', 'law-enforcement', 'darknet', 'mixer',
  'scam-ransomware', 'exchange', 'early-miner', 'entity', 'unknown',
];

const dormantState = {
  snapshot: null,
  filtered: [],
  page: 0,
  category: 'all',
  openAddr: null,
  dir: null,
};

// Years since the coins last moved: only spends reset the clock, receiving
// funds (including dust campaigns) never does. Recomputed from the snapshot
// date against the wall clock so the pool keeps ageing; snapshot dormantYears
// is the fallback when a record has no lastActive.
const dormantYears = (w) => {
  if (!w.lastActive) return w.dormantYears || 0;
  const ms = Date.now() - Date.parse(w.lastActive);
  return ms > 0 ? ms / DORMANT_YEAR_MS : 0;
};

// USD at the snapshot's captured BTC/USD price - never a live rate. null when
// the snapshot shipped without a price: the column degrades to a dash rather
// than guessing.
const dormantUsd = (w) => {
  const price = dormantState.snapshot ? dormantState.snapshot.priceUsd : null;
  return Number.isFinite(price) && price > 0 ? (w.balanceBtc || 0) * price : null;
};

const dormantFormatUsd = (usd) => {
  if (usd == null || !Number.isFinite(usd)) return '—';
  const digits = Math.abs(usd) >= 1000 ? 0 : 2;
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};

const dormantCategories = (wallets) => {
  const seen = new Set();
  for (const w of wallets || []) {
    for (const t of w.tags || []) seen.add(t.category || 'unknown');
  }
  const ordered = DORMANT_CATEGORY_ORDER.filter((c) => seen.has(c));
  for (const c of seen) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
};

// Sort direction defaults per key: balance and years read best-first, the date
// keys read chronologically. A missing/unknown dir falls back to these.
const dormantDefaultDir = (sort) => (sort === 'last' || sort === 'first' ? 'asc' : 'desc');

// The direction button always names the real order, whatever the key.
const dormantDirLabel = (sort, dir) => {
  const desc = dir !== 'asc';
  if (sort === 'years') return desc ? '↓ longest first' : '↑ shortest first';
  if (sort === 'last' || sort === 'first') return desc ? '↓ newest first' : '↑ oldest first';
  return desc ? '↓ biggest first' : '↑ smallest first';
};

// Pure filter + sort over the pool; the UI's thresholds are inputs here.
// Blank/omitted thresholds mean "no floor" - everything in the pool shows.
const dormantFilterSort = (wallets, opts) => {
  const minYears = Number(opts.minYears) || 0;
  const minBtc = Number(opts.minBtc) || 0;
  const query = (opts.query || '').trim().toLowerCase();
  const category = opts.category || 'all';
  const out = (wallets || []).filter((w) => {
    if (dormantYears(w) < minYears) return false;
    if ((w.balanceBtc || 0) < minBtc) return false;
    if (category !== 'all' && !(w.tags || []).some((t) => (t.category || 'unknown') === category)) return false;
    if (query) {
      const inAddr = (w.address || '').toLowerCase().includes(query);
      const inTags = (w.tags || []).some((t) => (t.label || '').toLowerCase().includes(query));
      if (!inAddr && !inTags) return false;
    }
    return true;
  });
  const sort = opts.sort || 'balance';
  const dir = opts.dir === 'asc' || opts.dir === 'desc' ? opts.dir : dormantDefaultDir(sort);
  const sign = dir === 'asc' ? 1 : -1;
  const val = (w) => {
    if (sort === 'years') return dormantYears(w);
    if (sort === 'last') return Date.parse(w.lastActive || 0);
    if (sort === 'first') return Date.parse(w.firstSeen || 0);
    return (w.balanceBtc || 0);
  };
  out.sort((a, b) => sign * (val(a) - val(b)));
  return out;
};

const dormantTagChip = (t) => {
  const label = t.label || 'tag';
  const short = label.length > 32 ? label.slice(0, 31) + '…' : label;
  const sources = (t.sources || []).length;
  const title = `${escapeHtml(label)} - ${escapeHtml(t.category || 'unknown')}, ${escapeHtml(t.confidence || 'unverified')}, ${sources} source${sources === 1 ? '' : 's'}`;
  return `<span class="dormant-tag" data-category="${escapeHtml(t.category || 'unknown')}" title="${title}">${escapeHtml(short)}</span>`;
};

const dormantRowHtml = (w, idx, open) => {
  const addr = escapeHtml(w.address);
  const years = dormantYears(w).toFixed(1);
  const first = w.firstSeen ? escapeHtml(w.firstSeen.slice(0, 10)) : '?';
  const last = w.lastActive ? escapeHtml(w.lastActive.slice(0, 10)) : '?';
  const tags = (w.tags || []).map(dormantTagChip).join(' ');
  return `<tr class="dormant-row${open ? ' open' : ''}" data-idx="${idx}" tabindex="0" aria-expanded="${open ? 'true' : 'false'}" onclick="dormantShowDetail(+this.dataset.idx)"><td><span class="dormant-chev" aria-hidden="true">▸</span><code><a href="https://blockstream.info/address/${addr}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${addr}</a></code></td><td>${(w.balanceBtc || 0).toFixed(8)}</td><td>${escapeHtml(dormantFormatUsd(dormantUsd(w)))}</td><td>${years}y</td><td>${first}</td><td>${last}</td><td>${tags}</td></tr>`;
};

const dormantRender = () => {
  const st = dormantState;
  const rowsEl = document.getElementById('dormantRows');
  const summaryEl = document.getElementById('dormantSummary');
  const totalPages = Math.max(1, Math.ceil(st.filtered.length / DORMANT_PAGE_SIZE));
  if (st.page >= totalPages) st.page = totalPages - 1;
  if (st.page < 0) st.page = 0;
  const start = st.page * DORMANT_PAGE_SIZE;
  const pageRows = st.filtered.slice(start, start + DORMANT_PAGE_SIZE);
  rowsEl.innerHTML = pageRows.map((w) => {
    const open = st.openAddr === w.address;
    return dormantRowHtml(w, st.filtered.indexOf(w), open) + (open ? dormantAccordionHtml(w) : '');
  }).join('');
  const totalBtc = st.filtered.reduce((sum, w) => sum + (w.balanceBtc || 0), 0);
  const price = st.snapshot ? st.snapshot.priceUsd : null;
  const usdPart = Number.isFinite(price) && price > 0 ? ` (≈ ${dormantFormatUsd(totalBtc * price)})` : '';
  summaryEl.textContent = `${st.filtered.length} wallet${st.filtered.length === 1 ? '' : 's'} match - ${totalBtc.toFixed(2)} BTC${usdPart} on this page's selection (page ${st.page + 1} of ${totalPages})`;
  const sortKey = document.getElementById('dormantSort').value;
  const dirBtn = document.getElementById('dormantDirBtn');
  if (dirBtn) dirBtn.textContent = dormantDirLabel(sortKey, st.dir || dormantDefaultDir(sortKey));
  // The same pager renders above and below the table: 50-row pages mean one
  // of them is always off-screen.
  const pagerHtml = dormantPagerHtml(st.page, totalPages);
  for (const id of ['dormantPagerTop', 'dormantPagerBottom']) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = pagerHtml;
  }
};

const dormantApply = () => {
  const st = dormantState;
  if (!st.snapshot) return;
  const opts = {
    minYears: document.getElementById('dormantYearsInput').value,
    minBtc: document.getElementById('dormantMinBtcInput').value,
    query: document.getElementById('dormantQuery').value,
    category: st.category,
    sort: document.getElementById('dormantSort').value,
    dir: st.dir,
  };
  st.filtered = dormantFilterSort(st.snapshot.wallets, opts);
  st.page = 0;
  // openAddr survives re-filtering: it is keyed by address, so the same wallet
  // stays expanded wherever it lands (or silently collapses if filtered out).
  dormantRender();
};

// Flip the current sort's direction; the button label names the real order.
const dormantToggleDir = () => {
  const st = dormantState;
  const sortKey = document.getElementById('dormantSort').value;
  st.dir = (st.dir || dormantDefaultDir(sortKey)) === 'asc' ? 'desc' : 'asc';
  dormantApply();
};

const dormantSetCategory = (category) => {
  dormantState.category = category;
  const container = document.getElementById('dormantCats');
  container.querySelectorAll('.dormant-cat').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.category === category);
  });
  dormantApply();
};

const dormantRenderChips = () => {
  const container = document.getElementById('dormantCats');
  const cats = ['all'].concat(dormantCategories(dormantState.snapshot.wallets));
  container.innerHTML = cats.map((c) => {
    const label = c === 'all' ? 'All tags' : c.replace(/-/g, ' ');
    return `<button type="button" class="dormant-cat${c === dormantState.category ? ' active' : ''}" data-category="${escapeHtml(c)}" onclick="dormantSetCategory('${escapeHtml(c)}')">${escapeHtml(label)}</button>`;
  }).join('');
};

// Mining-output provenance for scan-derived rows: the coins live on a bare
// pay-to-pubkey coinbase output, which some explorers show under the
// transaction rather than the address.
const dormantMinedHtml = (w) => {
  if (w.minedSats == null) return '';
  const btc = (w.minedSats / 1e8).toFixed(8);
  const where = w.blockHeight != null ? ` in block ${escapeHtml(String(w.blockHeight))}` : '';
  const state = w.spent === false
    ? `coins unspent since ${escapeHtml(String(w.firstSeen || 'funding').slice(0, 10))}`
    : `tracked coins last moved ${escapeHtml(String(w.lastActive || 'unknown').slice(0, 10))}`;
  const extra = w.spent === false && (w.balanceSats || 0) > w.minedSats
    ? ` - plus ${((w.balanceSats - w.minedSats) / 1e8).toFixed(8)} BTC more received at this address since (same key controls both)`
    : '';
  const link = w.txid
    ? `<p><a href="https://blockstream.info/tx/${escapeHtml(w.txid)}" target="_blank" rel="noopener noreferrer">View the coinbase output</a></p>`
    : '';
  return `<p><strong>Mined ${btc} BTC</strong>${where} - ${state}${extra}</p>${link}`
    + `<p class="recover-hint">This address is a pay-to-pubkey label for a mining output; some explorers show the coins under the transaction, not the address.</p>`;
};

// Wallet detail for the row accordion: provenance first - which sources assert
// each tag and when they were retrieved - plus the honesty markers for
// walk-bounded dates. Pure builder shared by the accordion row and the tests.
const dormantDetailHtml = (w) => {
  const tags = (w.tags || []).map((t) => {
    const sources = (t.sources || []).map((s) => {
      const retrieved = s.retrievedAt ? ` - retrieved ${escapeHtml(String(s.retrievedAt).slice(0, 10))}` : '';
      return `<li><a href="${escapeHtml(s.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.name || s.url || 'source')}</a>${retrieved}</li>`;
    }).join('');
    return `<li><strong>${escapeHtml(t.label)}</strong> - ${escapeHtml(t.category || 'unknown')} - <em>${escapeHtml(t.confidence || 'unverified')}</em><ul>${sources}</ul></li>`;
  }).join('');
  return `
    <h3>${escapeHtml(w.address)}</h3>
    <p>${(w.balanceBtc || 0).toFixed(8)} BTC${dormantUsd(w) == null ? '' : ` (≈ ${escapeHtml(dormantFormatUsd(dormantUsd(w)))} at snapshot price)`} - dormant ${dormantYears(w).toFixed(1)} years (coins last moved ${escapeHtml((w.lastActive || 'unknown').slice(0, 10))}) - ${w.txCount || 0} tx${w.txCount === 1 ? '' : 's'}${w.blockHeight != null ? ` - first seen in block ${w.blockHeight}` : ''}</p>
    <p><a href="https://blockstream.info/address/${escapeHtml(w.address)}" target="_blank" rel="noopener noreferrer">Open on block explorer</a></p>
    ${dormantMinedHtml(w)}
    ${w.firstSeenExact === false ? '<p class="recover-hint">First-seen date is an upper bound - this address has too many transactions to walk to the very first one.</p>' : ''}
    ${w.spendUndated ? '<p class="recover-hint">Last-moved date is an upper bound - this wallet has spends our history walk could not date, so the real last move is older (it has been dormant at least this long).</p>' : ''}
    <p class="recover-hint">Tags are third-party claims with their sources listed - check the citation before treating any label as fact.</p>
    <ul class="dormant-sources">${tags || '<li>no tags</li>'}</ul>`;
};

// The open row's detail, emitted as a full-width row directly beneath it.
const dormantAccordionHtml = (w) =>
  `<tr class="dormant-acc"><td colspan="7"><div class="dormant-detail dormant-acc-body">${dormantDetailHtml(w)}</div></td></tr>`;

// One row open at a time; clicking the open row closes it. Keyed by address,
// not row index, so re-sorting cannot put the wrong wallet under an open row.
const dormantShowDetail = (idx) => {
  const w = dormantState.filtered[idx];
  if (!w) return;
  dormantState.openAddr = dormantState.openAddr === w.address ? null : w.address;
  dormantRender();
};

// Windowed page-number list: first and last always, the current page with its
// neighbors, and '…' where numbers are skipped. The window widens near the
// start (and symmetrically at the end) so early pages never collapse to "1 …".
const dormantPageNumbers = (page, total) => {
  const want = new Set([0, total - 1, page - 1, page, page + 1]);
  if (page <= 2) [1, 2, 3].forEach((n) => want.add(n));
  if (page >= total - 3) [total - 2, total - 3, total - 4].forEach((n) => want.add(n));
  const out = [];
  let prev = null;
  for (const n of [...want].filter((x) => x >= 0 && x < total).sort((a, b) => a - b)) {
    if (prev != null && n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
};

const dormantPagerHtml = (page, totalPages) => {
  const nums = dormantPageNumbers(page, totalPages).map((n) => (n === '…'
    ? '<span class="dormant-page-gap">…</span>'
    : `<button type="button" class="dormant-page${n === page ? ' active' : ''}" onclick="dormantGoPage(${n})"${n === page ? ' aria-current="page"' : ''}>${n + 1}</button>`)).join('');
  return `<span class="dormant-page-info">Page ${page + 1} of ${totalPages}</span>`
    + `<button type="button" class="dormant-page" onclick="dormantPage(-1)"${page === 0 ? ' disabled' : ''}>← Prev</button>`
    + nums
    + `<button type="button" class="dormant-page" onclick="dormantPage(1)"${page >= totalPages - 1 ? ' disabled' : ''}>Next →</button>`;
};

const dormantGoPage = (n) => {
  const st = dormantState;
  const totalPages = Math.max(1, Math.ceil(st.filtered.length / DORMANT_PAGE_SIZE));
  st.page = Math.min(totalPages - 1, Math.max(0, n));
  dormantRender();
};

const dormantPage = (delta) => {
  dormantGoPage(dormantState.page + delta);
};

// Export content builders (pure): the click handlers wrap these in a download.
const dormantExportCsv = () => {
  const rows = [['address', 'balanceBtc', 'balanceUsd', 'dormantYears', 'firstSeen', 'lastActive', 'txCount', 'tags', 'txid', 'minedSats']];
  for (const w of dormantState.filtered) {
    const tags = (w.tags || []).map((t) => `${t.label} (${t.category}/${t.confidence})`).join('; ');
    const usd = dormantUsd(w);
    rows.push([w.address, (w.balanceBtc || 0).toFixed(8), usd == null ? '' : usd.toFixed(2), dormantYears(w).toFixed(1), w.firstSeen || '', w.lastActive || '', w.txCount || 0, tags, w.txid || '', w.minedSats != null ? w.minedSats : '']);
  }
  return rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
};

const dormantExportJson = () => JSON.stringify({
  exportedAt: new Date().toISOString(),
  generatedAt: dormantState.snapshot ? dormantState.snapshot.generatedAt : null,
  priceUsd: dormantState.snapshot ? (dormantState.snapshot.priceUsd ?? null) : null,
  priceAt: dormantState.snapshot ? (dormantState.snapshot.priceAt ?? null) : null,
  count: dormantState.filtered.length,
  wallets: dormantState.filtered,
}, null, 2);

const dormantDownload = (filename, text, type) => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const dormantReset = () => {
  // Empty thresholds = no floor: the whole pool shows until the user fills
  // the boxes in himself.
  dormantState.dir = null;
  document.getElementById('dormantYearsInput').value = '';
  document.getElementById('dormantMinBtcInput').value = '';
  document.getElementById('dormantQuery').value = '';
  document.getElementById('dormantSort').value = 'balance';
  dormantSetCategory('all');
};

const initDormant = async () => {
  const infoEl = document.getElementById('dormantSnapshotInfo');
  dormantState.loading = true;
  try {
    const res = await fetch('dormant-wallets.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    dormantState.snapshot = await res.json();
  } catch (err) {
    dormantState.loading = false;
    infoEl.textContent = 'Snapshot could not be loaded (' + escapeHtml(String(err.message || err)) + '). Run the dormant-wallets pipeline and rebuild.';
    return;
  }
  const snap = dormantState.snapshot;
  // The rate badge is the user-facing answer to "what rate, from where": the
  // USD figures in the table are balance x this snapshot price - never a rate
  // the browser fetches, so nothing here goes online.
  const rateEl = document.getElementById('dormantRateNote');
  if (Number.isFinite(snap.priceUsd) && snap.priceUsd > 0) {
    const captured = snap.priceAt
      ? `${String(snap.priceAt).slice(0, 10)} ${String(snap.priceAt).slice(11, 16)} UTC`
      : 'date not recorded';
    rateEl.innerHTML = `<strong>USD rate used in this table: 1 BTC = ${escapeHtml(dormantFormatUsd(snap.priceUsd))}</strong>`
      + ` - reported by ${escapeHtml(String(snap.priceSource || 'an unrecorded source'))}, captured ${escapeHtml(captured)} when this snapshot was built.`
      + ' Not a live rate: the browser never fetches one.';
  } else {
    rateEl.innerHTML = '<strong>USD amounts unavailable</strong> - no BTC/USD price was captured when this snapshot was built.';
  }
  rateEl.hidden = false;
  infoEl.textContent = `Snapshot generated ${snap.generatedAt} - ${snap.count} dormant wallets shipped (${snap.totalPool} in the compiled pool). Balances and dates are from that snapshot, not live.`;
  dormantRenderChips();
  dormantApply();
};

// Lazy: the snapshot can be several MB, so fetch it only when the tool is
// actually opened (deep links included), never on unrelated app starts.
const dormantEnsureInit = () => {
  if (dormantState.snapshot || dormantState.loading) return;
  if (!/^#\/dormant/.test(location.hash)) return;
  initDormant();
};

window.addEventListener('hashchange', dormantEnsureInit);
window.addEventListener('DOMContentLoaded', dormantEnsureInit);
