/*
 * Word wizard - a whole-phrase way to assemble a BIP39 seed. The word boxes
 * sit on top of the full 2048-word matrix, which is visible by default:
 * clicking any cell fills the first empty box (repeats are fine - each picked
 * cell shows the sequence numbers it filled), and every box also accepts
 * typing. The finished phrase is handed to the canonical Enter-words loader
 * (mnemonicInputSeedLoad) so word checks, the checksum gate and the
 * downstream load all run through exactly one code path. Nothing here goes
 * online: the word list ships with the page.
 */

const WIZARD_SIZES = [12, 15, 18, 21, 24];
// Cell-size steps for the matrix zoom buttons: 1 is the fit-all default.
const WIZARD_ZOOMS = [0.8, 1, 1.5, 2.2, 3.2];

const wizardState = {
  length: 12,
  words: [],
  zoom: 1,
  numbers: true,
};

// The bundled BIP39 English word list - the same source the loader validates
// against, so the wizard can never offer a word the loader would refuse.
const wizardWords = () => {
  const lists = (typeof window !== 'undefined' && window.bip39 && window.bip39.wordlists) || {};
  return lists.english || Object.values(lists)[0] || [];
};

const wizardValidate = (phrase) => {
  try {
    return !!(typeof bip39 !== 'undefined' && bip39.validateMnemonic && bip39.validateMnemonic(phrase));
  } catch (err) {
    return false;
  }
};

const wizardStatusError = (msg) => {
  const el = document.getElementById('wizardStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
};

const wizardStatusOk = (msg) => {
  const el = document.getElementById('wizardStatus');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
};

const wizardStatusClear = () => {
  const el = document.getElementById('wizardStatus');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
};

// Which sequence numbers each word currently holds - a word can repeat, so a
// cell may carry more than one number.
const wizardUsedMap = () => {
  const used = new Map();
  wizardState.words.slice(0, wizardState.length).forEach((w, i) => {
    if (!w) return;
    if (!used.has(w)) used.set(w, []);
    used.get(w).push(i + 1);
  });
  return used;
};

// Compact badge text for a cell: runs of three or more collapse to a range
// ("1-11"), anything shorter is listed ("1,3").
const wizardSeqLabel = (seqs) => {
  const parts = [];
  let i = 0;
  while (i < seqs.length) {
    let j = i;
    while (j + 1 < seqs.length && seqs[j + 1] === seqs[j] + 1) j += 1;
    if (j - i + 1 >= 3) parts.push(`${seqs[i]}-${seqs[j]}`);
    else for (let k = i; k <= j; k += 1) parts.push(String(seqs[k]));
    i = j + 1;
  }
  return parts.join(',');
};

// Zoom: - steps smaller than the fit-all default, + steps bigger at the cost
// of a longer page. The scale lives on the grid as data-zoom; CSS turns it
// into cell size, so the matrix itself never scrolls internally.
const wizardZoomApply = () => {
  const z = WIZARD_ZOOMS[wizardState.zoom];
  const grid = document.getElementById('wizardMatrix');
  if (grid && grid.dataset) grid.dataset.zoom = String(z);
  const label = document.getElementById('wizardZoomLabel');
  if (label) label.textContent = `×${z}`;
  const out = document.getElementById('wizardZoomOut');
  if (out) out.disabled = wizardState.zoom === 0;
  const inBtn = document.getElementById('wizardZoomIn');
  if (inBtn) inBtn.disabled = wizardState.zoom === WIZARD_ZOOMS.length - 1;
};

const wizardZoomIn = () => {
  if (wizardState.zoom < WIZARD_ZOOMS.length - 1) {
    wizardState.zoom += 1;
    wizardZoomApply();
  }
};

const wizardZoomOut = () => {
  if (wizardState.zoom > 0) {
    wizardState.zoom -= 1;
    wizardZoomApply();
  }
};

// The numbers checkbox: checked shows each word's place in the list
// (abandon = 1), unchecked shows the words themselves.
const wizardToggleNumbers = () => {
  const cb = document.getElementById('wizardNumberMode');
  wizardState.numbers = !!(cb && cb.checked);
  wizardMatrixRender();
};

const wizardFilled = () => wizardState.words.slice(0, wizardState.length).filter(Boolean).length;

// The live verdict under the boxes: progress, unknown words, then the honest
// checksum answer once every box holds a real word.
const wizardCheckRender = () => {
  const el = document.getElementById('wizardCheck');
  if (!el) return;
  const st = wizardState;
  const words = st.words.slice(0, st.length).map((w) => w || '');
  const unknown = [];
  words.forEach((w, i) => {
    if (w && !wizardWords().includes(w)) unknown.push(`word ${i + 1} ("${w}")`);
  });
  if (unknown.length) {
    el.className = 'wizard-checksum wizard-error';
    el.textContent = `✗ Not in the BIP39 word list: ${unknown.join(', ')} - click the right cell or fix the box.`;
    return;
  }
  const filled = words.filter(Boolean).length;
  if (filled < st.length) {
    el.className = 'wizard-checksum';
    el.textContent = `${filled} of ${st.length} words filled`;
    return;
  }
  const ok = wizardValidate(words.join(' '));
  el.className = `wizard-checksum ${ok ? 'wizard-ok' : 'wizard-error'}`;
  el.textContent = ok
    ? '✓ BIP39 checksum valid'
    : '✗ BIP39 checksum not valid yet - a word is probably mistyped or out of order. Click a box, then the right cell.';
};

// The matrix itself: every word as a clickable cell, narrowed by the filter,
// each picked cell tinted and carrying its sequence number(s). By default the
// cell body shows the word's place in the list (abandon = 1); the numbers
// checkbox switches that to the word itself.
const wizardMatrixRender = () => {
  const grid = document.getElementById('wizardMatrix');
  if (!grid) return;
  const list = wizardWords();
  const entries = list.map((w, i) => ({ w, place: i + 1 }));
  const filterEl = document.getElementById('wizardWordFilter');
  const q = filterEl ? String(filterEl.value || '').trim().toLowerCase() : '';
  const shown = q ? entries.filter((e) => e.w.includes(q)) : entries;
  const countEl = document.getElementById('wizardWordCount');
  if (countEl) {
    countEl.textContent = q
      ? `${shown.length} of ${list.length} words contain "${q}" - click one to put it in the next empty box`
      : `All ${list.length} words - click one to put it in the next empty box`;
  }
  const hint = document.getElementById('wizardMatrixHint');
  if (hint) {
    hint.textContent = wizardState.numbers
      ? 'Cells show each word\u2019s place in the list (abandon = 1) - uncheck Numbers to see the words. Click a cell to fill the next empty box (repeats are fine - the small badges show where each pick went). Typing works too; \u00d7 clears one box, Reset all starts over.'
      : 'Click a word to fill the next empty box (repeats are fine - the small badges show where each pick went). Typing works too; \u00d7 clears one box, Reset all starts over.';
  }
  const used = wizardUsedMap();
  grid.className = 'wizard-matrix';
  grid.innerHTML = shown
    .map(({ w, place }) => {
      const seqs = used.get(w) || [];
      const badge = seqs.length ? `<span class="wiz-cell-n">${wizardSeqLabel(seqs)}</span>` : '';
      const body = wizardState.numbers ? String(place) : w;
      const title = `#${place} ${w}${seqs.length ? ` - picked as word ${seqs.join(', ')}` : ''}`;
      return `<button type="button" class="wiz-cell${seqs.length ? ' used' : ''}" title="${title}" onclick="wizardMatrixPick('${w}')"><span class="wiz-cell-w">${body}</span>${badge}</button>`;
    })
    .join('');
  wizardZoomApply();
};

// Click a cell: the word goes into the first empty box - never overwrites.
const wizardMatrixPick = (word) => {
  const st = wizardState;
  const w = String(word || '').trim().toLowerCase();
  if (!wizardWords().includes(w)) return false;
  const words = st.words.slice(0, st.length).map((x) => x || '');
  const i = words.findIndex((x) => !x);
  if (i === -1) {
    wizardStatusError(`All ${st.length} boxes are filled - clear one with its × (or use Reset all) before changing the phrase.`);
    return false;
  }
  st.words[i] = w;
  const input = document.getElementById(`wizardWordBox-${i + 1}`);
  if (input) input.value = w;
  wizardStatusClear();
  wizardMatrixRender();
  wizardCheckRender();
  wizardFocusEmpty();
  return true;
};

// Typing in a box keeps the matrix badges and the verdict in step.
const wizardTypeWord = (i, value) => {
  const st = wizardState;
  const idx = parseInt(i, 10);
  if (!(idx >= 0 && idx < st.length)) return;
  st.words[idx] = String(value || '').trim().toLowerCase();
  wizardStatusClear();
  wizardMatrixRender();
  wizardCheckRender();
};

// The small x by a box: forget just that word, keep the rest.
const wizardClearWord = (i) => {
  const st = wizardState;
  const idx = parseInt(i, 10);
  if (!(idx >= 0 && idx < st.length)) return;
  st.words[idx] = '';
  const input = document.getElementById(`wizardWordBox-${idx + 1}`);
  if (input) input.value = '';
  wizardStatusClear();
  wizardMatrixRender();
  wizardCheckRender();
};

const wizardFocusEmpty = () => {
  const st = wizardState;
  const words = st.words.slice(0, st.length).map((x) => x || '');
  const i = words.findIndex((x) => !x);
  const input = i === -1 ? null : document.getElementById(`wizardWordBox-${i + 1}`);
  if (input && input.focus) input.focus();
};

const wizardSetLength = (n) => {
  const st = wizardState;
  st.length = Math.max(1, parseInt(n, 10) || 12);
  st.words = Array.from({ length: st.length }, (_, i) => st.words[i] || '');
  wizardStatusClear();
  wizardRender();
};

const wizardRestart = () => {
  wizardState.words = Array.from({ length: wizardState.length }, () => '');
  wizardStatusClear();
  wizardRender();
};

// Hand the assembled words to the canonical Enter-words loader: it re-checks
// every word, gates on the BIP39 checksum and runs the same downstream load
// as typing the words into the boxes by hand would.
const wizardLoadSeed = () => {
  const st = wizardState;
  const words = st.words.slice(0, st.length).map((w) => w || '');
  const missing = [];
  words.forEach((w, i) => {
    if (!w) missing.push(i + 1);
  });
  if (missing.length) {
    wizardStatusError(`Fill every box first - still missing word${missing.length > 1 ? 's' : ''} ${missing.join(', ')}.`);
    return;
  }
  // Make the visible boxes match exactly what is about to load.
  words.forEach((w, i) => {
    const box = document.getElementById(`wizardWordBox-${i + 1}`);
    if (box && box.value !== w) box.value = w;
  });
  const boxes = (typeof DOM !== 'undefined' && DOM.mnemonicInputs) || [];
  boxes.forEach((div, i) => {
    const input = div.querySelector('input');
    if (input) input.value = i < words.length ? words[i] : '';
  });
  const lenSel = document.getElementById('mnemonicLengthSelect');
  if (lenSel) lenSel.value = String(st.length);
  const idMode = document.getElementById('inputMnemonicIdMode');
  if (idMode && idMode.checked) {
    idMode.checked = false;
    if (typeof applyMnemonicIdMode === 'function') applyMnemonicIdMode();
  }
  const err = document.getElementById('inputMnemonicError');
  if (err) err.textContent = '';
  if (typeof mnemonicInputSeedLoad === 'function') mnemonicInputSeedLoad();
  const failed = err ? String(err.textContent || '') : '';
  if (failed) {
    wizardStatusError(failed);
    return;
  }
  wizardStatusOk(`Seed loaded (${st.length} words). The rest of the toolkit is unlocked below.`);
};

// The shell: length buttons, the word boxes on top, the verdict and actions,
// then the filter and the full matrix underneath.
const wizardRender = () => {
  const el = document.getElementById('seedWizard');
  if (!el) return;
  const st = wizardState;
  st.words = Array.from({ length: st.length }, (_, i) => st.words[i] || '');
  const inputs = st.words
    .map((w, i) => {
      const n = i + 1;
      return `<div class="wizard-word-slot"><span class="wizard-word-n">${n}</span><input type="text" id="wizardWordBox-${n}" class="wizard-word-box" value="${escapeHtml(w)}" aria-label="Word ${n} of ${st.length}" placeholder="word ${n}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" oninput="wizardTypeWord(${i}, this.value)"><button type="button" class="wizard-clear" onclick="wizardClearWord(${i})" title="Clear word ${n}" aria-label="Clear word ${n}">&times;</button></div>`;
    })
    .join('');
  el.innerHTML = `
    <div class="wizard-length-row" role="group" aria-label="Phrase length">${WIZARD_SIZES.map((n) => `<button type="button" class="btn wizard-length-btn${n === st.length ? ' active' : ''}" onclick="wizardSetLength(${n})">${n} words</button>`).join('')}</div>
    <div class="wizard-inputs">${inputs}</div>
    <p class="wizard-checksum" id="wizardCheck"></p>
    <div class="button-row">
      <button type="button" class="btn" onclick="wizardLoadSeed()"><b>LOAD SEED</b></button>
      <button type="button" class="btn" onclick="wizardRestart()" title="Clear every word and start over">Reset all</button>
    </div>
    <div class="wizard-matrix-tools">
      <input type="search" id="wizardWordFilter" placeholder="Filter 2048 words&hellip;" aria-label="Filter words" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" oninput="wizardMatrixRender()">
      <span class="recover-hint" id="wizardWordCount"></span>
      <span class="wizard-zoom" role="group" aria-label="Matrix zoom">
        <button type="button" class="btn wizard-zoom-btn" id="wizardZoomOut" onclick="wizardZoomOut()" title="Smaller cells" aria-label="Zoom out">&minus;</button>
        <span class="wizard-zoom-label" id="wizardZoomLabel">&times;1</span>
        <button type="button" class="btn wizard-zoom-btn" id="wizardZoomIn" onclick="wizardZoomIn()" title="Bigger cells" aria-label="Zoom in">+</button>
      </span>
      <label class="wizard-numbers-label"><input type="checkbox" id="wizardNumberMode" ${st.numbers ? 'checked' : ''} onchange="wizardToggleNumbers()"> Numbers (place in list)</label>
    </div>
    <div class="wizard-matrix" id="wizardMatrix" role="group" aria-label="BIP39 English word matrix"></div>
    <p class="recover-hint" id="wizardMatrixHint"></p>`;
  wizardCheckRender();
  wizardMatrixRender();
};

const initWizard = () => {
  wizardRender();
};

window.addEventListener('DOMContentLoaded', initWizard);
