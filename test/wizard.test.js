/*
 * Tests for the Word wizard: suggestions and fragment resolution, the
 * word-by-word walk to the review step, the 2048-word picker with its live
 * filter, and the final hand-off to the canonical Enter-words loader.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadTool } = require('./harness');

const WWW = path.join(__dirname, '..', 'src', 'www');
const ZERO_12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

const openTool = async () => {
  const tool = loadTool();
  await vm.runInContext('setupDom', tool.context)();
  tool.cancelPendingTimers();
  vm.runInContext(fs.readFileSync(path.join(WWW, 'js', 'wizard.js'), 'utf8'), tool.context);
  tool.run = (code) => vm.runInContext(code, tool.context);
  return tool;
};

// Word boxes as the page has them: a div per word holding an input
const fakeWordBoxes = (tool, words) => {
  const boxes = Array.from({ length: 24 }, (_, i) => {
    const input = tool.document.getElementById(`word-box-${i}`);
    input.value = words[i] || '';
    input.attributes = {};
    input.setAttribute = (name, value) => { input.attributes[name] = value; };
    input.classList.names.delete('hidden');
    return {
      querySelector: () => input,
      input,
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    };
  });
  tool.DOM.mnemonicInputs = boxes;
  return boxes.map((b) => b.input);
};

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('suggestions: prefix matches come first, substring matches fill in, capped at 8', async () => {
  const tool = await openTool();
  const sugg = tool.run('wizardSuggestions');
  const words = tool.run('wizardWords')();
  assert.strictEqual(words.length, 2048, 'the bundled English list has 2048 words');
  assert.deepStrictEqual(Array.from(sugg('')), []);
  assert.deepStrictEqual(Array.from(sugg('abandon')), ['abandon']);
  assert.deepStrictEqual(Array.from(sugg('ABAN')), ['abandon'], 'case does not matter');

  const q = 'z';
  const expPrefix = words.filter((w) => w.startsWith(q));
  const expInside = words.filter((w) => !w.startsWith(q) && w.includes(q));
  assert.ok(expPrefix.length >= 1 && expPrefix.length + expInside.length >= 8, 'fixture: z has matches');
  const res = Array.from(sugg(q));
  assert.strictEqual(res.length, 8);
  assert.deepStrictEqual(res.slice(0, expPrefix.length), Array.from(expPrefix), 'words starting with z come first');
  assert.ok(res.slice(expPrefix.length).every((w) => expInside.includes(w)), 'the rest are substring matches');

  const big = Array.from(sugg('a'));
  assert.strictEqual(big.length, 8);
  assert.ok(big.every((w) => w.startsWith('a')), 'with plenty of prefix matches the cap keeps only those');
});

test('resolve: whole words and unique fragments win, ambiguous ones resolve to nothing', async () => {
  const tool = await openTool();
  const resolve = tool.run('wizardResolve');
  const words = tool.run('wizardWords')();
  assert.strictEqual(words.filter((w) => w.startsWith('aban')).length, 1, 'fixture: aban is unique');
  assert.strictEqual(resolve('abandon'), 'abandon');
  assert.strictEqual(resolve('  ABAN  '), 'abandon');
  assert.strictEqual(resolve('aban'), 'abandon', 'four letters already identify a word');
  assert.strictEqual(resolve('ab'), null, 'ambiguous fragments resolve to nothing');
  assert.strictEqual(resolve('zzzqq'), null);
  assert.strictEqual(resolve(''), null);
});

test('walk: word by word from the length step to the review step', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  const pick = tool.run('wizardPickWord');
  assert.strictEqual(JSON.stringify(Array.from(tool.run('WIZARD_SIZES'))), '[12,15,18,21,24]');

  tool.run('wizardSetLength')(12);
  assert.strictEqual(st.length, 12);
  assert.strictEqual(st.step, 1, 'the first missing word is step 1');

  const words = ZERO_12.split(' ');
  words.slice(0, 11).forEach((w, i) => {
    assert.strictEqual(pick(w), true);
    assert.strictEqual(st.words[i], w);
    assert.strictEqual(st.step, i + 2);
  });
  assert.strictEqual(pick('zzzq'), false, 'a word outside the list is refused');
  assert.strictEqual(st.step, 12, 'a refused word does not advance');
  assert.strictEqual(pick('about'), true);
  assert.strictEqual(st.step, 13, 'the review comes after the last word');
  assert.deepStrictEqual(Array.from(st.words.slice(0, 12)), words);

  const html = tool.document.getElementById('seedWizard').innerHTML;
  assert.match(html, /Review your 12 words/);
  assert.match(html, /BIP39 checksum valid/);

  tool.run('wizardBack')();
  assert.strictEqual(st.step, 12, 'back goes to the last word');
  tool.run('wizardGoStep')(13);
  assert.match(tool.document.getElementById('seedWizard').innerHTML, /Review your 12 words/);

  tool.run('wizardRestart')();
  assert.strictEqual(st.step, 0);
  assert.deepStrictEqual(Array.from(st.words), []);
  assert.match(tool.document.getElementById('seedWizard').innerHTML, /How many words is your seed phrase/);
});

test('review: the checksum verdict is honest and a word can be jumped back to', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  const pick = tool.run('wizardPickWord');
  tool.run('wizardSetLength')(12);
  for (let i = 0; i < 12; i += 1) pick('abandon');
  assert.strictEqual(st.step, 13);

  let html = tool.document.getElementById('seedWizard').innerHTML;
  assert.match(html, /BIP39 checksum not valid yet/);
  assert.ok(html.includes('wizard-error'));

  tool.run('wizardGoStep')(3);
  html = tool.document.getElementById('seedWizard').innerHTML;
  assert.match(html, /Word 3 of 12/);
  assert.match(html, /value="abandon"/, 'the current word is prefilled');

  tool.run('wizardGoStep')(12);
  assert.strictEqual(pick('about'), true, 'fixing word 12 to "about" makes the phrase valid');
  html = tool.document.getElementById('seedWizard').innerHTML;
  assert.match(html, /BIP39 checksum valid/);
  assert.ok(html.includes('wizard-ok'));
});

test('picker: the full word list filters live and closes when a word is clicked', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  tool.run('wizardSetLength')(12);
  tool.run('wizardOpenPicker')();

  const modal = tool.document.getElementById('wizardWordModal');
  const count = tool.document.getElementById('wizardWordCount');
  const grid = tool.document.getElementById('wizardWordGrid');
  const filter = tool.document.getElementById('wizardWordFilter');
  assert.ok(!modal.classList.contains('hidden'));
  assert.strictEqual(count.textContent, 'All 2048 words - click one to choose it');
  assert.ok(grid.innerHTML.includes('>abandon<'));
  assert.ok(grid.innerHTML.includes('>zoo<'));
  assert.ok((grid.innerHTML.match(/class="wizard-word"/g) || []).length >= 2048, 'every word is offered');

  const words = tool.run('wizardWords')();
  filter.value = 'zi';
  tool.run('wizardRenderPicker')();
  const n = words.filter((w) => w.includes('zi')).length;
  assert.ok(n > 0 && n < 2048, 'fixture: zi matches some but not all words');
  assert.strictEqual(count.textContent, `${n} of ${words.length} words contain "zi" - click one to choose it`);
  assert.ok(grid.innerHTML.includes('>amazing<'));
  assert.ok(!grid.innerHTML.includes('>zoo<'), 'filtered-out words are gone');

  filter.value = 'xyzq';
  tool.run('wizardRenderPicker')();
  assert.strictEqual(count.textContent, `0 of ${words.length} words contain "xyzq" - click one to choose it`);

  filter.value = '';
  tool.run('wizardRenderPicker')();
  tool.run('wizardPickFromPicker')('abandon');
  assert.strictEqual(st.words[0], 'abandon');
  assert.strictEqual(st.step, 2);
  assert.ok(modal.classList.contains('hidden'), 'picking from the modal closes it');
});

test('typed input: unique fragments commit, ambiguous or unknown ones complain', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  const status = tool.document.getElementById('wizardStatus');
  tool.run('wizardSetLength')(12);
  const input = tool.document.getElementById('wizardWordInput');
  const commit = tool.run('wizardCommitInput');

  input.value = 'aban';
  tool.run('wizardSuggestRender')();
  assert.ok(tool.document.getElementById('wizardSuggest').innerHTML.includes('wizard-suggest-item'));
  commit();
  assert.strictEqual(st.words[0], 'abandon');
  assert.strictEqual(st.step, 2);

  input.value = 'ab';
  commit();
  assert.strictEqual(st.step, 2, 'ambiguous input does not advance');
  assert.match(status.textContent, /is not one BIP39 word/);
  assert.ok(!status.classList.contains('hidden'));

  input.value = 'zzzqq';
  commit();
  assert.match(status.textContent, /is not one BIP39 word/);
  assert.strictEqual(st.step, 2);

  input.value = '';
  commit();
  assert.match(status.textContent, /Pick a word first/);
  assert.strictEqual(st.step, 2);

  input.value = 'zoo';
  commit();
  assert.strictEqual(st.words[1], 'zoo');
  assert.strictEqual(st.step, 3);

  tool.run('wizardGoStep')(2);
  input.value = '';
  commit();
  assert.strictEqual(st.step, 3, 'empty input on an already-filled word just advances');
  tool.cancelPendingTimers();
});

test('hand-off: the wizard feeds the canonical loader and the seed lands', async () => {
  const tool = await openTool();
  const words = ZERO_12.split(' ');
  fakeWordBoxes(tool, words);
  tool.run('wizardSetLength')(12);
  words.forEach((w) => tool.run('wizardPickWord')(w));
  assert.strictEqual(tool.run('wizardState').step, 13);

  tool.run('wizardLoadSeed')();
  assert.strictEqual(tool.document.getElementById('inputMnemonicError').textContent, '');
  assert.strictEqual(tool.DOM.bip39Phrase.value, ZERO_12);
  const status = tool.document.getElementById('wizardStatus');
  assert.match(status.textContent, /Seed loaded \(12 words\)/);
  assert.ok(!status.classList.contains('hidden'));
  tool.cancelPendingTimers();
});

test('hand-off: a phrase failing the checksum is refused and explained', async () => {
  const tool = await openTool();
  const bad = Array(12).fill('abandon');
  fakeWordBoxes(tool, bad);
  tool.run('wizardSetLength')(12);
  bad.forEach((w) => tool.run('wizardPickWord')(w));
  tool.run('wizardLoadSeed')();

  const status = tool.document.getElementById('wizardStatus');
  assert.match(status.textContent, /checksum/);
  assert.ok(!status.classList.contains('hidden'));
  assert.strictEqual(tool.DOM.bip39Phrase.value, '', 'a bad phrase never reaches the phrase box');
  tool.cancelPendingTimers();
});

(async () => {
  console.log('seed word wizard');
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
