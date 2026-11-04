import {
  KeyObject, constants, createCipheriv, createDecipheriv, createPrivateKey,
  createPublicKey, privateDecrypt, publicEncrypt, randomBytes,
} from 'node:crypto';
import { TextDecoder } from 'node:util';

// Binary, versioned framing avoids permissive base64/duplicate-JSON-key parsing.
// [28-byte header][12-byte IV][RSA-wrapped key][16-byte tag][ciphertext]
// The header, IV and wrapped key are GCM AAD. Plaintext is plan || manifest.
// There is deliberately no CLI, filesystem access, key generation or logging.
const MAGIC = Buffer.from('WS2PLAN\0', 'ascii');
const HEADER_SIZE = 28;
const IV_SIZE = 12;
const TAG_SIZE = 16;
const MAX_PLAN = 64 * 1024 * 1024;
const MAX_MANIFEST = 128 * 1024;
const DOMAIN = Buffer.from('ws2-personal-web-plan:aes-256-gcm:rsa-oaep-sha256:v1\0');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Plan envelope: ${message}`);
}

function bytes(value, maximum, label) {
  requireValue(value instanceof Uint8Array, `${label} must be bytes`);
  requireValue(value.byteLength > 0 && value.byteLength <= maximum, `${label} has an invalid size`);
  return Buffer.from(value);
}

function canonicalValue(value, active = new Set(), depth = 0) {
  requireValue(depth <= 32, 'manifest nesting is excessive');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value), 'manifest contains an invalid number');
    return value;
  }
  requireValue(typeof value === 'object' && !active.has(value), 'manifest must contain only acyclic JSON');
  requireValue(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'manifest contains a non-JSON object');
  requireValue(Object.getOwnPropertySymbols(value).length === 0, 'manifest contains symbol properties');
  active.add(value);
  let result;
  if (Array.isArray(value)) {
    const keys = Object.getOwnPropertyNames(value).filter(key => key !== 'length');
    requireValue(keys.length === value.length, 'manifest contains a sparse or extended array');
    result = [];
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      requireValue(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length && property.enumerable && Object.hasOwn(property, 'value'),
        'manifest contains an unsafe array property');
      result[key] = canonicalValue(property.value, active, depth + 1);
    }
  } else {
    result = Object.create(null);
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      requireValue(!dangerousKeys.has(key) && property.enumerable && Object.hasOwn(property, 'value'),
        'manifest contains an unsafe property');
      result[key] = canonicalValue(property.value, active, depth + 1);
    }
  }
  active.delete(value);
  return result;
}

function parseManifest(input) {
  let text;
  let value;
  try {
    text = decoder.decode(input);
    value = JSON.parse(text);
  } catch {
    throw new Error('Plan envelope: manifest is not strict UTF-8 JSON');
  }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'manifest must be an object');
  // JSON.parse alone accepts duplicate keys (including differently escaped keys).
  // It has already checked the grammar; this bounded walk checks key uniqueness.
  let offset = 0;
  let tokens = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset += 1; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset++] === '"') return JSON.parse(text.slice(start, offset));
    }
    throw new Error('Plan envelope: malformed manifest string');
  };
  function walk(depth) {
    requireValue(depth <= 32 && ++tokens <= 65_536, 'manifest complexity is excessive');
    whitespace();
    if (text[offset] === '{') {
      offset += 1;
      whitespace();
      const seen = new Set();
      if (text[offset] !== '}') {
        for (;;) {
          whitespace();
          const key = string();
          requireValue(!seen.has(key) && !dangerousKeys.has(key), 'manifest contains duplicate or unsafe keys');
          seen.add(key);
          whitespace();
          offset += 1; // colon; grammar was validated above
          walk(depth + 1);
          whitespace();
          if (text[offset] !== ',') break;
          offset += 1;
        }
      }
      offset += 1;
    } else if (text[offset] === '[') {
      offset += 1;
      whitespace();
      if (text[offset] !== ']') {
        for (;;) {
          walk(depth + 1);
          whitespace();
          if (text[offset] !== ',') break;
          offset += 1;
        }
      }
      offset += 1;
    } else if (text[offset] === '"') string();
    else while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset += 1;
  }
  walk(0);
  canonicalValue(value);
  return value;
}

function rsaKey(input, kind) {
  let key;
  try {
    key = input instanceof KeyObject ? input : kind === 'private' ? createPrivateKey(input) : createPublicKey(input);
  } catch {
    throw new Error('Plan envelope: invalid key material');
  }
  requireValue(key.type === kind && key.asymmetricKeyType === 'rsa', `an RSA ${kind} key is required`);
  const bits = key.asymmetricKeyDetails?.modulusLength;
  requireValue(Number.isInteger(bits) && bits >= 3072 && bits <= 16_384, 'RSA modulus must be 3072–16384 bits');
  requireValue(key.asymmetricKeyDetails.publicExponent >= 65_537n, 'RSA exponent is too small');
  return { key, wrappedSize: Math.ceil(bits / 8) };
}

export function sealPlan(planBytes, manifestBytesOrObject, publicKey) {
  const plan = bytes(planBytes, MAX_PLAN, 'plan');
  const manifestBytes = manifestBytesOrObject instanceof Uint8Array
    ? bytes(manifestBytesOrObject, MAX_MANIFEST, 'manifest')
    : bytes(Buffer.from(JSON.stringify(canonicalValue(manifestBytesOrObject))), MAX_MANIFEST, 'manifest');
  parseManifest(manifestBytes);
  const { key: recipient, wrappedSize } = rsaKey(publicKey, 'public');
  const contentKey = randomBytes(32);
  let plaintext;
  try {
    const iv = randomBytes(IV_SIZE);
    const wrapped = publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, contentKey);
    requireValue(wrapped.length === wrappedSize, 'unexpected wrapped-key size');
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header);
    header[8] = 1; // format version
    header[9] = 1; // AES-256-GCM
    header[10] = 1; // RSA-OAEP-SHA256; byte 11 is reserved and must be zero
    header.writeUInt32BE(wrappedSize, 12);
    header.writeUInt32BE(plan.length, 16);
    header.writeUInt32BE(manifestBytes.length, 20);
    header.writeUInt32BE(plan.length + manifestBytes.length, 24);
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv, { authTagLength: TAG_SIZE });
    cipher.setAAD(Buffer.concat([DOMAIN, header, iv, wrapped]));
    plaintext = Buffer.concat([plan, manifestBytes]);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, iv, wrapped, cipher.getAuthTag(), ciphertext]);
  } finally {
    contentKey.fill(0);
    plaintext?.fill(0);
    plan.fill(0);
    manifestBytes.fill(0);
  }
}

export function openPlan(envelopeBytes, privateKey) {
  const envelope = bytes(envelopeBytes, HEADER_SIZE + IV_SIZE + 2048 + TAG_SIZE + MAX_PLAN + MAX_MANIFEST, 'envelope');
  let contentKey;
  let plaintext;
  let unauthenticated;
  try {
    requireValue(envelope.length >= HEADER_SIZE + IV_SIZE + 384 + TAG_SIZE + 2, 'truncated envelope');
    const header = envelope.subarray(0, HEADER_SIZE);
    requireValue(header.subarray(0, 8).equals(MAGIC) && header[8] === 1 && header[9] === 1 && header[10] === 1 && header[11] === 0,
      'unsupported envelope format');
    const wrappedSize = header.readUInt32BE(12);
    const planSize = header.readUInt32BE(16);
    const manifestSize = header.readUInt32BE(20);
    const ciphertextSize = header.readUInt32BE(24);
    requireValue(wrappedSize >= 384 && wrappedSize <= 2048, 'invalid wrapped-key size');
    requireValue(planSize > 0 && planSize <= MAX_PLAN && manifestSize > 0 && manifestSize <= MAX_MANIFEST, 'invalid payload sizes');
    requireValue(ciphertextSize === planSize + manifestSize && envelope.length === HEADER_SIZE + IV_SIZE + wrappedSize + TAG_SIZE + ciphertextSize,
      'truncated, extended or inconsistent envelope');
    const { key: recipient, wrappedSize: expectedSize } = rsaKey(privateKey, 'private');
    requireValue(wrappedSize === expectedSize, 'recipient key size differs');
    const iv = envelope.subarray(HEADER_SIZE, HEADER_SIZE + IV_SIZE);
    const wrapped = envelope.subarray(HEADER_SIZE + IV_SIZE, HEADER_SIZE + IV_SIZE + wrappedSize);
    const tagOffset = HEADER_SIZE + IV_SIZE + wrappedSize;
    const tag = envelope.subarray(tagOffset, tagOffset + TAG_SIZE);
    contentKey = privateDecrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
    requireValue(contentKey.length === 32, 'invalid content key');
    const decipher = createDecipheriv('aes-256-gcm', contentKey, iv, { authTagLength: TAG_SIZE });
    decipher.setAAD(Buffer.concat([DOMAIN, header, iv, wrapped]));
    decipher.setAuthTag(tag);
    // Nothing is returned (or parsed) before final() authenticates everything.
    unauthenticated = decipher.update(envelope.subarray(tagOffset + TAG_SIZE));
    plaintext = Buffer.concat([unauthenticated, decipher.final()]);
    const manifestBytes = Buffer.from(plaintext.subarray(planSize));
    const manifest = parseManifest(manifestBytes);
    return { plan: Buffer.from(plaintext.subarray(0, planSize)), manifest, manifestBytes };
  } catch {
    throw new Error('Plan envelope: authentication, key or format validation failed');
  } finally {
    contentKey?.fill(0);
    unauthenticated?.fill(0);
    plaintext?.fill(0);
    envelope.fill(0);
  }
}
