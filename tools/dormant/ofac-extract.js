// Phase 3a: download the OFAC SDN enhanced XML and extract every digital
// currency address into out/ofac-tags.json (sanctions category, OFAC-sourced).
// The export endpoint 302s to a presigned S3 URL, so redirects must be followed.
// Usage: node tools/dormant/ofac-extract.js
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const { HttpClient } = require('./lib/http');
const { parseOfacEnhanced } = require('./lib/ofac');

const OUT_DIR = path.join(__dirname, 'out');
const http = new HttpClient({ cacheDir: path.join(__dirname, '..', '..', '.cache', 'dormant'), perSecond: 2 });

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.error('ofac: downloading SDN enhanced XML (100+ MB, cached after first run)');
  const xml = await http.get(config.ofacUrl, { cacheKey: 'sdn-enhanced-xml', asText: true });
  const entries = parseOfacEnhanced(xml);
  console.error(`ofac: ${entries.length} digital-currency entries across ${new Set(entries.map((e) => e.entityId)).size} entities`);

  const retrievedAt = new Date().toISOString();
  const tags = entries.map((e) => ({
    address: e.address,
    chain: e.chain,
    label: `OFAC SDN: ${e.entityName}`,
    category: 'sanctions',
    sources: [{
      name: 'OFAC Specially Designated Nationals list (enhanced XML)',
      url: config.ofacUrl,
      retrievedAt,
    }],
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'ofac-tags.json'), JSON.stringify(tags, null, 2));
  const btc = tags.filter((t) => t.chain === 'BTC');
  console.error(`ofac: wrote ${tags.length} tags (${btc.length} BTC) -> out/ofac-tags.json`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
