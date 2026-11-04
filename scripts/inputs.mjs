import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIELDS = Object.freeze(['participant_name', 'instance_number', 'app_message', 'page_theme', 'workshop_iteration']);
export const THEMES = Object.freeze(['blue', 'green', 'orange']);
export const ITERATIONS = Object.freeze(['01', '02', '03']);
const namePattern = /^[a-z][a-z0-9]{1,11}$/;
const guidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseParticipantJson(bytes) {
  assert.ok(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 16 * 1024, 'Participant JSON is missing or oversized');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  // JSON.parse alone silently keeps the last duplicate key. Inspect decoded
  // keys after grammar validation, including Unicode-escaped duplicate names.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  const frames = [];
  for (const token of tokens) {
    if (token === '{' || token === '[') frames.push({ object: token === '{', key: token === '{', seen: new Set() });
    else if (token === '}' || token === ']') frames.pop();
    else if (token === ',') { if (frames.at(-1)?.object) frames.at(-1).key = true; }
    else if (frames.at(-1)?.object && frames.at(-1).key && token.startsWith('"')) {
      const key = JSON.parse(token);
      const frame = frames.at(-1);
      assert.ok(!['__proto__', 'prototype', 'constructor'].includes(key) && !frame.seen.has(key), 'Participant JSON has duplicate or unsafe keys');
      frame.seen.add(key); frame.key = false;
    }
  }
  return value;
}

export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unknown fields`);
}

export function validateParticipant(value, expectedName) {
  exactKeys(value, FIELDS, 'Participant input');
  for (const field of FIELDS) assert.equal(typeof value[field], 'string', `${field} must be a string`);
  assert.match(value.participant_name, namePattern, 'participant_name: use 2–12 lowercase letters/digits, starting with a letter');
  if (expectedName !== undefined) assert.equal(value.participant_name, expectedName, 'participant_name differs from the frozen owner assignment');
  assert.equal(value.instance_number, '001', 'instance_number must remain the string 001');
  assert.match(value.app_message, /^[A-Za-z0-9 .,!-]{1,60}$/, 'app_message: use 1–60 letters, digits, spaces or . , ! -; no HTML/newlines');
  assert.ok(value.app_message.trim(), 'app_message cannot be blank');
  assert.ok(THEMES.includes(value.page_theme), 'page_theme must be blue, green or orange');
  assert.ok(ITERATIONS.includes(value.workshop_iteration), 'workshop_iteration must be the string 01, 02 or 03');
  return structuredClone(value);
}

export function deriveNames(input) {
  validateParticipant(input);
  const suffix = `${input.participant_name}-${input.instance_number}`;
  return Object.freeze({
    resourceGroup: `rg-${suffix}`,
    vnet: `vnet-${suffix}`,
    nsg: `nsg-${suffix}`,
    appSubnet: `snet-app-${suffix}`,
    endpointSubnet: `snet-pe-${suffix}`,
    servicePlan: `asp-${suffix}`,
    webApp: `app-${suffix}`,
    storage: `st${input.participant_name}${input.instance_number}`,
    container: `cnt-${suffix}`,
    privateEndpoint: `pep-blob-${suffix}`,
    dnsLink: `dnslink-blob-${suffix}`,
    dnsGroup: `dzg-blob-${suffix}`,
    dnsZone: 'privatelink.blob.core.windows.net',
  });
}

export function validateAssignment(value, { live = false, now = Date.now() } = {}) {
  exactKeys(value, ['schema_version', 'mode', 'participant_name', 'learner_user_ids', 'instance_number', 'network_slot', 'location', 'allowed_web_cidr', 'subscription_id', 'tenant_id', 'app_identity_id', 'owner', 'cost_center', 'expires_at'], 'Assignment');
  assert.equal(value.schema_version, 1);
  assert.ok(['offline', 'live'].includes(value.mode));
  assert.match(value.participant_name, namePattern);
  assert.equal(value.instance_number, '001');
  assert.ok(Array.isArray(value.learner_user_ids) && value.learner_user_ids.every(id => Number.isSafeInteger(id) && id > 0));
  assert.equal(new Set(value.learner_user_ids).size, value.learner_user_ids.length);
  assert.ok(Number.isInteger(value.network_slot) && value.network_slot >= 0 && value.network_slot <= 199, 'network_slot must be owner-assigned 0–199');
  assert.match(value.location, /^[a-z][a-z0-9]{2,30}$/);
  assert.match(value.allowed_web_cidr, /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[1-9]|[12]\d|3[0-2])$/, 'Assign a restricted IPv4 workshop access CIDR, never 0.0.0.0/0');
  assert.ok(value.allowed_web_cidr.split('/')[0].split('.').every(octet => Number(octet) <= 255), 'Invalid web access CIDR');
  assert.match(value.subscription_id, guidPattern);
  assert.match(value.tenant_id, guidPattern);
  const identityPrefix = `/subscriptions/${value.subscription_id}/resourceGroups/`;
  assert.ok(typeof value.app_identity_id === 'string' && value.app_identity_id.toLowerCase().startsWith(identityPrefix.toLowerCase()));
  assert.match(value.app_identity_id, /\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[a-zA-Z0-9_-]+$/);
  const workload = `rg-${value.participant_name}-001`;
  assert.notEqual(value.app_identity_id.split('/')[4].toLowerCase(), workload, 'Bootstrap identity must live outside the workload RG');
  for (const field of ['owner', 'cost_center']) assert.match(value[field], /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{1,59}$/);
  const expires = Date.parse(value.expires_at);
  assert.ok(Number.isFinite(expires), 'expires_at must be an ISO timestamp');
  if (live) {
    assert.equal(value.mode, 'live', 'The example assignment cannot authorize Azure');
    assert.ok(value.learner_user_ids.length > 0, 'Live assignment needs enrolled users');
    assert.ok(expires > now && expires - now <= 24 * 60 * 60 * 1000, 'Owner live window must be active and at most 24 hours');
    assert.notEqual(value.subscription_id, '11111111-1111-4111-8111-111111111111', 'Example subscription is offline only');
  }
  return structuredClone(value);
}

export function terraformVariables(input, assignment) {
  const copy = validateParticipant(input, assignment.mode === 'live' ? assignment.participant_name : undefined);
  const checked = validateAssignment(assignment);
  const { subscription_id, tenant_id, location, allowed_web_cidr, network_slot, app_identity_id, owner, cost_center, expires_at } = checked;
  return { ...copy, assignment: { participant_name: copy.participant_name, subscription_id, tenant_id, location, allowed_web_cidr, network_slot, app_identity_id, owner, cost_center, expires_at } };
}

export function readInputs(root = ROOT) {
  const input = parseParticipantJson(fs.readFileSync(path.join(root, 'exercise/participant.json')));
  return validateParticipant(input);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = readInputs();
  console.log(JSON.stringify({ status: 'PASS', input, names: deriveNames(input), azureAccessed: false }, null, 2));
}
