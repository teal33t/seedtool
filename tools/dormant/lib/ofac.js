// OFAC SDN "enhanced" XML parser: extracts every Digital Currency Address
// feature with its entity name. Shape (verified against the 2026-10 download):
//   <entity id="4632"> ... <name nameId="16878" ...>ABDALLAH, Ramadan</name> ...
//     <features>
//       <feature id="97667">
//         <type featureTypeId="992">Digital Currency Address - TRX</type>
//         <versionId>95242</versionId>
//         <value>TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81</value>
//       </feature>
'use strict';

// OFAC chain codes -> the chains we model. XBT is OFAC's code for Bitcoin.
const CHAIN_MAP = {
  XBT: 'BTC', BTC: 'BTC', BCH: 'BCH', BSV: 'BSV', BTG: 'BTG', LTC: 'LTC',
  DASH: 'DASH', ZEC: 'ZEC', DOGE: 'DOGE', XVG: 'XVG',
  ETH: 'ETH', ETC: 'ETC', BSC: 'BSC', ARB: 'ARB', BNB: 'BNB',
  TRX: 'TRX', XMR: 'XMR', XRP: 'XRP', SOL: 'SOL',
  USDT: 'USDT', USDC: 'USDC',
};

const ENTITY_RE = /<entity id="(\d+)">([\s\S]*?)<\/entity>/g;
const NAME_RE = /<name[^>]*>([^<]+)<\/name>/g;
const FEATURE_RE = /<feature id="\d+">\s*<type featureTypeId="\d+">Digital Currency Address - (\w+)<\/type>[\s\S]*?<value>([^<]+)<\/value>/g;

// -> [{ entityId, entityName, chain, address }] with unmappable chains skipped.
const parseOfacEnhanced = (xml) => {
  const out = [];
  for (const em of xml.matchAll(ENTITY_RE)) {
    const entityId = em[1];
    const chunk = em[2];
    const names = Array.from(chunk.matchAll(NAME_RE)).map((m) => m[1].trim());
    const entityName = names.length ? names[0] : 'OFAC SDN entry ' + entityId;
    for (const fm of chunk.matchAll(FEATURE_RE)) {
      const chain = CHAIN_MAP[fm[1].toUpperCase()];
      if (!chain) continue;
      out.push({ entityId, entityName, chain, address: fm[2].trim() });
    }
  }
  return out;
};

module.exports = { parseOfacEnhanced, CHAIN_MAP };
