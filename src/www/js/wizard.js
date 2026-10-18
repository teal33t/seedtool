/*
 * Word wizard - a step-by-step way to assemble a BIP39 seed phrase: pick the
 * phrase length, then choose each word one at a time from the 2048-word
 * English list, either by typing (with suggestions) or by clicking in the full
 * word picker. The finished phrase is handed to the canonical Enter-words
 * loader (mnemonicInputSeedLoad) so word checks, the checksum gate and the
 * downstream load all run through exactly one code path. Nothing here goes
 * online: the word list ships with the page.
 */

const WIZARD_SIZES = [12, 15, 18, 21, 24];

const wizardState = {
  length: 12,
  words: [],
  step: 0, // 0 = choose length, 1..length = one word per step, length+1 = review
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

// Suggestions for the word box: prefix matches first, then substring matches.
const wizardSuggestions = (text, limit = 8) => {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return [];
  const prefix = [];
  const inside = [];
  for (const w of wizardWords()) {
    if (w.startsWith(q)) prefix.push(w);
    else if (w.includes(q)) inside.push(w);
  }
  return prefix.concat(inside).slice(0, limit);
};

// A typed fragment resolves to one word when it is a whole word, or when
// exactly one word starts with it - the BIP39 list is built so four letters
// already identify a word uniquely. Ambiguous fragments resolve to nothing.
const wizardResolve = (text) => {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return null;
  const list = wizardWords();
  if (list.includes(q)) return q;
  const starts = list.filter((w) => w.startsWith(q));
  return starts.length === 1 ? starts[0] : null;
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

const wizardGoStep = (n) => {
  const st = wizardState;
  st.step = Math.min(Math.max(0, n), st.length + 1);
  wizardStatusClear();
  wizardRender();
};

// Step 1 of the wizard: how long the phrase is. Jumps straight to the first
// word still missing (or the review when every word is already picked).
const wizardSetLength = (n) => {
  const st = wizardState;
  st.length = Math.max(1, parseInt(n, 10) || 12);
  st.words = st.words.slice(0, st.length);
  let step = st.length + 1;
  for (let i = 0; i < st.length; i += 1) {
    if (!st.words[i]) {
      step = i + 1;
      break;
    }
  }
  wizardGoStep(step);
};

// Choose the word for the current step and move on: one click (or Enter) per
// word is the whole flow.
const wizardPickWord = (word) => {
  const st = wizardState;
  const w = String(word || '').trim().toLowerCase();
  if (!wizardWords().includes(w)) return false;
  if (st.step < 1 || st.step > st.length) return false;
  st.words[st.step - 1] = w;
  wizardGoStep(st.step + 1);
  return true;
};

// The word box: take whatever is typed when it resolves to exactly one word.
const wizardCommitInput = () => {
  const input = document.getElementById('wizardWordInput');
  const typed = input ? String(input.value || '').trim() : '';
  const resolved = wizardResolve(typed);
  if (typed && !resolved) {
    wizardStatusError(`"${typed}" is not one BIP39 word. Keep typing until one word matches, or browse the full list.`);
    return;
  }
  if (resolved) {
    wizardPickWord(resolved);
    return;
  }
  if (wizardState.words[wizardState.step - 1]) {
    wizardGoStep(wizardState.step + 1);
    return;
  }
  wizardStatusError('Pick a word first - type part of it, or browse the full list.');
};

const wizardBack = () => wizardGoStep(wizardState.step - 1);

const wizardRestart = () => {
  wizardState.words = [];
  wizardState.step = 0;
  wizardStatusClear();
  wizardRender();
};

// Hand the assembled words to the canonical Enter-words loader: it re-checks
// every word, gates on the BIP39 checksum and runs the same downstream load
// as typing the words into the boxes by hand would.
const wizardLoadSeed = () => {
  const st = wizardState;
  const words = st.words.slice(0, st.length);
  if (words.length < st.length || words.some((w) => !w)) {
    wizardStatusError('Every word slot must be filled before loading.');
    return;
  }
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

// ---------------------------------------------------------------------
// The full 2048-word picker (mouse-first word choice)
// ---------------------------------------------------------------------
const wizardOpenPicker = () => {
  const modal = document.getElementById('wizardWordModal');
  if (modal) modal.classList.remove('hidden');
  const filter = document.getElementById('wizardWordFilter');
  if (filter) filter.value = '';
  wizardRenderPicker();
  if (filter && filter.focus) filter.focus();
};

const wizardClosePicker = () => {
  const modal = document.getElementById('wizardWordModal');
  if (modal) modal.classList.add('hidden');
};

const wizardRenderPicker = () => {
  const list = wizardWords();
  const filterEl = document.getElementById('wizardWordFilter');
  const q = filterEl ? String(filterEl.value || '').trim().toLowerCase() : '';
  const matches = q ? list.filter((w) => w.includes(q)) : list;
  const countEl = document.getElementById('wizardWordCount');
  if (countEl) {
    countEl.textContent = q
      ? `${matches.length} of ${list.length} words contain "${q}" - click one to choose it`
      : `All ${list.length} words - click one to choose it`;
  }
  const grid = document.getElementById('wizardWordGrid');
  if (grid) {
    grid.innerHTML = matches
      .map((w) => `<button type="button" class="wizard-word" onclick="wizardPickFromPicker('${w}')">${w}</button>`)
      .join('');
  }
};

const wizardPickFromPicker = (w) => {
  if (wizardPickWord(w)) wizardClosePicker();
};

// ---------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------
const wizardSuggestRender = () => {
  const box = document.getElementById('wizardSuggest');
  const input = document.getElementById('wizardWordInput');
  if (!box) return;
  const items = wizardSuggestions(input ? input.value : '');
  box.innerHTML = items
    .map((w) => `<button type="button" class="wizard-suggest-item" onclick="wizardPickWord('${w}')">${w}</button>`)
    .join('');
};

const wizardRender = () => {
  const el = document.getElementById('seedWizard');
  if (!el) return;
  const st = wizardState;

  if (st.step === 0) {
    el.innerHTML = `
      <h3 class="wizard-title">How many words is your seed phrase?</h3>
      <p class="recover-hint">BIP39 phrases come in standard lengths. Pick the one that matches your seed, then enter the words one at a time.</p>
      <div class="wizard-length-row">${WIZARD_SIZES.map((n) => `<button type="button" class="btn wizard-length-btn${n === st.length ? ' active' : ''}" onclick="wizardSetLength(${n})">${n} words</button>`).join('')}</div>`;
    return;
  }

  const chips = Array.from({ length: st.length }, (_, i) => {
    const n = i + 1;
    const done = !!st.words[i];
    return `<button type="button" class="wizard-chip${n === st.step ? ' current' : ''}${done ? ' done' : ''}" title="${escapeHtml(st.words[i] || `word ${n}`)}" onclick="wizardGoStep(${n})">${done ? '✓' : n}</button>`;
  }).join('');

  if (st.step > st.length) {
    const phrase = st.words.slice(0, st.length).join(' ');
    const complete = st.words.length >= st.length && st.words.slice(0, st.length).every(Boolean);
    const valid = complete && wizardValidate(phrase);
    el.innerHTML = `
      <h3 class="wizard-title">Review your ${st.length} words</h3>
      <div class="wizard-steps" role="group" aria-label="Progress">${chips}</div>
      <div class="wizard-review">${st.words.slice(0, st.length).map((w, i) => `<button type="button" class="wizard-review-word" onclick="wizardGoStep(${i + 1})"><span class="wizard-review-n">${i + 1}</span>${escapeHtml(w || '…')}</button>`).join('')}</div>
      <p class="wizard-checksum ${valid ? 'wizard-ok' : 'wizard-error'}">${valid ? '✓ BIP39 checksum valid' : '✗ BIP39 checksum not valid yet - a word is probably mistyped, in the wrong order, or missing. Click a word to fix it.'}</p>
      <div class="button-row">
        <button type="button" class="btn" onclick="wizardBack()">← Back</button>
        <button type="button" class="btn" onclick="wizardLoadSeed()"><b>LOAD SEED</b></button>
        <button type="button" class="btn" onclick="wizardRestart()">Start over</button>
      </div>`;
    return;
  }

  const cur = st.words[st.step - 1] || '';
  el.innerHTML = `
    <h3 class="wizard-title">Word ${st.step} of ${st.length}</h3>
    <div class="wizard-steps" role="group" aria-label="Progress">${chips}</div>
    <div class="wizard-word-entry">
      <input type="text" id="wizardWordInput" class="wizard-word-input" placeholder="type part of the word" value="${escapeHtml(cur)}" aria-label="Word ${st.step} of ${st.length}" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" oninput="wizardSuggestRender()" onkeydown="if (event.key === 'Enter') { event.preventDefault(); wizardCommitInput(); }">
      <div class="wizard-suggest" id="wizardSuggest" role="listbox" aria-label="Word suggestions"></div>
    </div>
    <div class="button-row">
      <button type="button" class="btn" onclick="wizardBack()">← Back</button>
      <button type="button" class="btn" onclick="wizardCommitInput()">Next →</button>
      <button type="button" class="btn" onclick="wizardOpenPicker()">Browse all 2048 words</button>
    </div>
    <p class="recover-hint">Type part of a word and pick from the suggestions, press Enter when one word matches, or click a word in the full list.${cur ? ` Currently: <strong>${escapeHtml(cur)}</strong> - type to replace it.` : ''}</p>`;
  const input = document.getElementById('wizardWordInput');
  if (input && input.focus) input.focus();
  wizardSuggestRender();
};

const initWizard = () => {
  wizardRender();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') wizardClosePicker();
  });
};

window.addEventListener('DOMContentLoaded', initWizard);
