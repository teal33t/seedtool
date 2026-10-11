// P2PK -> base58check address derivation for early-coinbase outputs.
// Esplora omits scriptpubkey_address for p2pk outputs (the pre-multisig era),
// so the pipeline derives the classic "1..." address from the pushed pubkey.
'use strict';

const crypto = require('crypto');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();
const hash160 = (buf) => crypto.createHash('ripemd160').update(sha256(buf)).digest();

const base58Encode = (buf) => {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out || '1';
};

// version(1) || payload(20) || checksum(4)
const base58checkEncode = (version, payload) => {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  return base58Encode(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
};

// hash160(pubkey) -> P2PKH-style address; p2pk outputs spend to the same
// hash160-derived "1..." address, so balance lookups work by that address.
const p2pkAddressFromPubkey = (pubkeyHex) => {
  const pubkey = Buffer.from(pubkeyHex, 'hex');
  if (pubkey.length !== 65 && pubkey.length !== 33) {
    throw new Error('p2pk pubkey must be 65 or 33 bytes, got ' + pubkey.length);
  }
  return base58checkEncode(0x00, hash160(pubkey));
};

// Extract the pushed pubkey from a standard p2pk scriptPubKey:
// OP_PUSHBYTES_65 (0x41) <65-byte key> OP_CHECKSIG, or 0x21 <33-byte key> OP_CHECKSIG.
const p2pkPubkeyFromScript = (scriptHex) => {
  const script = Buffer.from(scriptHex, 'hex');
  if (script.length === 35 && script[0] === 0x21 && script[34] === 0xac) {
    return script.subarray(1, 34).toString('hex');
  }
  if (script.length === 67 && script[0] === 0x41 && script[66] === 0xac) {
    return script.subarray(1, 66).toString('hex');
  }
  return null;
};

// Resolve an address for any Esplora vout: trust scriptpubkey_address when
// present, derive it for p2pk, fall back to null (keyed by script elsewhere).
const voutAddress = (vout) => {
  if (vout.scriptpubkey_address) return vout.scriptpubkey_address;
  if (vout.scriptpubkey_type === 'p2pk' && vout.scriptpubkey) {
    const pubkey = p2pkPubkeyFromScript(vout.scriptpubkey);
    if (pubkey) return p2pkAddressFromPubkey(pubkey);
  }
  return null;
};

const base58Decode = (str) => {
  let n = 0n;
  for (const ch of str) {
    const idx = B58_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    n = n * 58n + BigInt(idx);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = n > 0n ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
  let pad = 0;
  for (const ch of str) {
    if (ch !== '1') break;
    pad++;
  }
  return Buffer.concat([Buffer.alloc(pad), bytes]);
};

// True when addr is a well-formed base58check address (checksum verified).
const base58checkVerify = (addr) => {
  const raw = base58Decode(addr);
  if (!raw || raw.length !== 25) return false;
  const body = raw.subarray(0, 21);
  const sum = sha256(sha256(body)).subarray(0, 4);
  return sum.equals(raw.subarray(21));
};

// True only for addresses the Bitcoin indexers will accept: base58check with a
// mainnet version byte (P2PKH 0x00 / P2SH 0x05) or a bech32 (bc1...) string.
// Tag feeds carry other chains' addresses mislabeled as BTC (a Tron "T..."
// address poisoned a 100-address batch with HTTP 400s), so batched callers
// must filter through this first.
const isBtcAddress = (addr) => {
  if (typeof addr !== 'string' || !addr) return false;
  if (/^bc1[ac-hj-np-z02-9]{11,87}$/.test(addr)) return true;
  const raw = base58Decode(addr);
  if (!raw || raw.length !== 25) return false;
  const version = raw[0];
  if (version !== 0x00 && version !== 0x05) return false;
  return base58checkVerify(addr);
};

module.exports = {
  sha256,
  hash160,
  base58Encode,
  base58checkEncode,
  base58checkVerify,
  isBtcAddress,
  p2pkAddressFromPubkey,
  p2pkPubkeyFromScript,
  voutAddress,
};
