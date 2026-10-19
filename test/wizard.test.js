/*
 * Tests for the Word wizard matrix UI: the 2048-word matrix with sequence
 * badges on picked cells, click-to-fill of the first empty box, typing into
 * boxes, the per-box x and Reset all, the live verdict, and the final
 * hand-off to the canonical Enter-words loader.
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
  tool.run('wizardRender')();
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

test('matrix: every word is offered and picked cells carry their sequence numbers', async () => {
  const tool = await openTool();
  const grid = () => tool.document.getElementById('wizardMatrix');
  assert.strictEqual((grid().innerHTML.match(/class="wiz-cell[ "]/g) || []).length, 2048, 'the full list is visible by default');
  assert.ok(grid().innerHTML.includes(`wizardMatrixPick('zebra')"><span class="wiz-cell-w">zebra</span></button>`), 'unused cells show no badge');

  const pick = tool.run('wizardMatrixPick');
  assert.strictEqual(pick('abandon'), true);
  assert.strictEqual(pick('zoo'), true);
  assert.strictEqual(pick('abandon'), true, 'repeats are fine');
  const html = grid().innerHTML;
  assert.ok(html.includes(`wizardMatrixPick('abandon')"><span class="wiz-cell-w">abandon</span><span class="wiz-cell-n">1,3</span></button>`), 'a repeated cell shows every sequence number');
  assert.ok(html.includes(`wizardMatrixPick('zoo')"><span class="wiz-cell-w">zoo</span><span class="wiz-cell-n">2</span></button>`));
  assert.ok(html.includes('class="wiz-cell used"'), 'picked cells are highlighted');
});

test('sequence badges collapse long runs into ranges', async () => {
  const tool = await openTool();
  const label = tool.run('wizardSeqLabel');
  assert.strictEqual(label([2]), '2');
  assert.strictEqual(label([1, 2]), '1,2');
  assert.strictEqual(label([1, 3]), '1,3');
  assert.strictEqual(label([1, 2, 3]), '1-3');
  assert.strictEqual(label([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), '1-11');
  assert.strictEqual(label([1, 2, 4, 5, 6, 9]), '1,2,4-6,9');
});

test('the density toggle swaps fit-all for bigger cells and back', async () => {
  const tool = await openTool();
  const grid = tool.document.getElementById('wizardMatrix');
  assert.ok(!grid.className.includes('comfortable'), 'fit-all is the default');
  assert.match(tool.document.getElementById('seedWizard').innerHTML, />Bigger words</);
  tool.run('wizardToggleDensity')();
  assert.match(grid.className, /comfortable/);
  assert.strictEqual(tool.document.getElementById('wizardDensityBtn').textContent, 'Fit all in view');
  tool.run('wizardToggleDensity')();
  assert.ok(!grid.className.includes('comfortable'));
  assert.strictEqual(tool.document.getElementById('wizardDensityBtn').textContent, 'Bigger words');
});

test('clicks fill the first empty box in order and never overwrite', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  const pick = tool.run('wizardMatrixPick');
  tool.run('wizardSetLength')(12);
  ZERO_12.split(' ').forEach((w, i) => {
    assert.strictEqual(pick(w), true);
    assert.strictEqual(st.words[i], w);
    assert.strictEqual(tool.document.getElementById(`wizardWordBox-${i + 1}`).value, w, 'the matching box shows the word');
  });
  assert.strictEqual(pick('zebra'), false, 'a full phrase refuses more picks');
  assert.match(tool.document.getElementById('wizardStatus').textContent, /boxes are filled/);
  assert.deepStrictEqual(Array.from(st.words), ZERO_12.split(' '), 'a refused pick changes nothing');
});

test('the x clears one box and reset all clears the phrase', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  const pick = tool.run('wizardMatrixPick');
  tool.run('wizardSetLength')(12);
  pick('abandon');
  pick('zoo');
  pick('abandon');
  tool.run('wizardClearWord')(1);
  assert.strictEqual(st.words[1], '', 'the second word is forgotten');
  assert.strictEqual(tool.document.getElementById('wizardWordBox-2').value, '', 'its box is emptied');
  assert.strictEqual(st.words[0], 'abandon', 'other words survive');
  assert.ok(tool.document.getElementById('wizardMatrix').innerHTML.includes(`wizardMatrixPick('zoo')"><span class="wiz-cell-w">zoo</span></button>`), 'the cell badge is gone');

  tool.run('wizardRestart')();
  assert.ok(Array.from(st.words).every((w) => !w), 'reset all forgets every word');
  assert.strictEqual(tool.document.getElementById('wizardCheck').textContent, '0 of 12 words filled');
  assert.ok(tool.document.getElementById('seedWizard').innerHTML.includes('Reset all'));
});

test('typing in a box keeps the verdict honest', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  const type = tool.run('wizardTypeWord');
  tool.run('wizardSetLength')(12);
  ZERO_12.split(' ').forEach((w, i) => type(i, w));
  const check = tool.document.getElementById('wizardCheck');
  assert.strictEqual(check.textContent, '✓ BIP39 checksum valid');
  assert.match(check.className, /wizard-ok/);

  type(0, 'zzzq');
  assert.match(check.textContent, /Not in the BIP39 word list: word 1 \("zzzq"\)/);
  assert.match(check.className, /wizard-error/);

  type(0, 'abandon');
  type(11, 'abandon');
  assert.match(check.textContent, /BIP39 checksum not valid yet/);
  assert.strictEqual(st.words[11], 'abandon');
});

test('the filter narrows the matrix and the count line tells the truth', async () => {
  const tool = await openTool();
  const filter = tool.document.getElementById('wizardWordFilter');
  const count = tool.document.getElementById('wizardWordCount');
  const grid = tool.document.getElementById('wizardMatrix');
  const words = tool.run('wizardWords')();

  filter.value = 'zi';
  tool.run('wizardMatrixRender')();
  const n = words.filter((w) => w.includes('zi')).length;
  assert.ok(n > 0 && n < 2048, 'fixture: zi matches some but not all words');
  assert.strictEqual(count.textContent, `${n} of ${words.length} words contain "zi" - click one to put it in the next empty box`);
  assert.ok(grid.innerHTML.includes('>amazing'));
  assert.ok(!grid.innerHTML.includes('>zoo<'), 'filtered-out words are gone');

  filter.value = 'xyzq';
  tool.run('wizardMatrixRender')();
  assert.strictEqual(count.textContent, `0 of ${words.length} words contain "xyzq" - click one to put it in the next empty box`);
});

test('length changes keep earlier words and rebuild the boxes', async () => {
  const tool = await openTool();
  const st = tool.run('wizardState');
  const pick = tool.run('wizardMatrixPick');
  tool.run('wizardSetLength')(12);
  pick('abandon');
  pick('zoo');
  pick('zebra');
  tool.run('wizardSetLength')(24);
  assert.strictEqual(st.length, 24);
  assert.deepStrictEqual(Array.from(st.words.slice(0, 3)), ['abandon', 'zoo', 'zebra']);
  assert.strictEqual(st.words.length, 24);
  assert.ok(tool.document.getElementById('seedWizard').innerHTML.includes('id="wizardWordBox-24"'));

  tool.run('wizardSetLength')(12);
  assert.strictEqual(st.words.length, 12, 'shrinking drops the tail');
  assert.strictEqual(st.words[2], 'zebra');
});

test('hand-off: the wizard feeds the canonical loader and the seed lands', async () => {
  const tool = await openTool();
  fakeWordBoxes(tool, ZERO_12.split(' '));
  tool.run('wizardSetLength')(12);
  ZERO_12.split(' ').forEach((w) => tool.run('wizardMatrixPick')(w));
  tool.document.getElementById('wizardWordBox-2').value = 'drifted';
  tool.run('wizardLoadSeed')();

  assert.strictEqual(tool.document.getElementById('inputMnemonicError').textContent, '');
  assert.strictEqual(tool.DOM.bip39Phrase.value, ZERO_12);
  assert.strictEqual(tool.document.getElementById('wizardWordBox-2').value, 'abandon', 'the visible boxes are re-synced to what loaded');
  const status = tool.document.getElementById('wizardStatus');
  assert.match(status.textContent, /Seed loaded \(12 words\)/);
  assert.ok(!status.classList.contains('hidden'));
  tool.cancelPendingTimers();
});

test('hand-off: missing boxes are named and a bad checksum is refused', async () => {
  const tool = await openTool();
  fakeWordBoxes(tool, []);
  tool.run('wizardSetLength')(12);
  for (let i = 0; i < 11; i += 1) tool.run('wizardMatrixPick')('abandon');
  tool.run('wizardLoadSeed')();
  assert.match(tool.document.getElementById('wizardStatus').textContent, /Fill every box first - still missing word 12/);
  assert.strictEqual(tool.DOM.bip39Phrase.value, '');

  tool.run('wizardMatrixPick')('abandon');
  tool.run('wizardLoadSeed')();
  assert.match(tool.document.getElementById('wizardStatus').textContent, /checksum/);
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
