// Phase 3c: web lists - dormant / lost / Satoshi-era wallet lists published
// on the public web (config.webLists). Same provenance rules as press-extract:
// every tag carries {name, url, retrievedAt}; an entry that CLAIMS addresses
// emits only claims the fetched page actually contains ("be correct"); an
// entry without claims harvests every address the page lists. These are
// third-party CLAIMS - verify.js independently establishes balances and
// dormancy for every address it imports, so a wrong list can mislabel a
// wallet but can never make it look dormant.
// Usage: node tools/dormant/web-extract.js
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const { HttpClient } = require('./lib/http');
const { stripTags, tagsFromText } = require('./lib/harvest');

const OUT_DIR = path.join(__dirname, 'out');
const http = new HttpClient({ cacheDir: path.join(__dirname, '..', '..', '.cache', 'dormant'), perSecond: 1 });

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const retrievedAt = new Date().toISOString();
  const out = [];

  for (const src of config.webLists || []) {
    console.error(`web: ${src.url}`);
    let text;
    try {
      const html = await http.get(src.url, { cacheKey: 'web-' + Buffer.from(src.url).toString('base64url'), asText: true });
      // Display text can truncate long bech32 addresses ("bc1q..5g") while
      // hrefs carry the full strings - extract against stripped text AND raw
      // HTML so truncated renders neither match nor hide the real address.
      text = stripTags(html) + '\n' + html;
    } catch (err) {
      console.error(`web: SKIPPED (${err.message})`);
      continue;
    }
    const tags = tagsFromText(text, {
      label: src.label,
      category: src.category,
      claimed: src.addresses,
      source: { name: src.sourceName, url: src.url, retrievedAt },
    });
    // Import budget: a web list can hold tens of thousands of addresses
    // (lost.txt alone has 42k) and every imported row later costs walk quota
    // to verify. maxRows bounds one source's claim on the verify queue; the
    // subset is first-N in page order and the truncation is logged.
    const capped = src.maxRows ? tags.slice(0, src.maxRows) : tags;
    out.push(...capped);
    console.error(`web: ${capped.length} tags from this page${capped.length < tags.length ? ` (capped from ${tags.length} by maxRows=${src.maxRows})` : ''}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'web-lists.json'), JSON.stringify(out, null, 2));
  console.error(`web: wrote ${out.length} tags -> out/web-lists.json`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
