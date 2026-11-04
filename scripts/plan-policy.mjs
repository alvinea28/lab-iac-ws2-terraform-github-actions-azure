import { createHash, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { deriveNames, terraformVariables, validateAssignment, validateParticipant } from './inputs.mjs';

export const TERRAFORM_VERSION = '1.16.1';
export const PROVIDER_VERSION = '5.4.0';
export const MAX_PLAN_AGE_MS = 2 * 60 * 60 * 1000;
export const PROFILE = 'ws2-personal-web-v1';
const MAX_PLAN = 64 * 1024 * 1024;
const MAX_JSON = 32 * 1024 * 1024;
const MAX_MANIFEST = 128 * 1024;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const PROVIDER = 'registry.terraform.io/hashicorp/azurerm';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const empty = value => value == null || value === '' || (Array.isArray(value) && value.length === 0) ||
  (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

function insist(condition, message) {
  if (!condition) throw new Error(`Plan policy: ${message}`);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value, fields, label) {
  insist(object(value), `${label} must be an object`);
  insist(Object.keys(value).sort().join('\0') === [...fields].sort().join('\0'), `${label} has missing or unknown fields`);
}

// Shared by the owner-profile reader. Digests of JSON objects always use this
// UTF-8, sorted-key representation; file/package/lock digests use ORIGINAL bytes.
export function canonicalJson(value) {
  const active = new Set();
  let count = 0;
  function visit(item, depth) {
    insist(depth <= 64 && ++count <= 250_000, 'JSON complexity is excessive');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number') {
      insist(Number.isFinite(item), 'JSON contains a non-finite number');
      return item;
    }
    insist((object(item) || Array.isArray(item)) && !active.has(item), 'only acyclic, plain JSON is accepted');
    insist(Object.getOwnPropertySymbols(item).length === 0, 'JSON symbol properties are forbidden');
    active.add(item);
    const array = Array.isArray(item);
    const keys = Object.getOwnPropertyNames(item).filter(key => !(array && key === 'length'));
    insist(!array || keys.length === item.length, 'sparse or extended arrays are forbidden');
    const result = array ? [] : Object.create(null);
    for (const key of array ? keys : keys.sort()) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      insist(!unsafeKeys.has(key) && property.enumerable && Object.hasOwn(property, 'value'), 'unsafe JSON properties are forbidden');
      if (array) insist(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length, 'extended arrays are forbidden');
      result[key] = visit(property.value, depth + 1);
    }
    active.delete(item);
    return result;
  }
  return JSON.stringify(visit(value, 0));
}

export function parseStrictJson(bytes, maximum = MAX_MANIFEST) {
  insist(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= maximum, 'invalid JSON byte length');
  let text;
  let parsed;
  try { text = decoder.decode(bytes); parsed = JSON.parse(text); }
  catch { throw new Error('Plan policy: invalid UTF-8 JSON'); }
  // Grammar is checked by JSON.parse; token traversal additionally rejects
  // duplicate and prototype keys, even when a duplicate is Unicode-escaped.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  const stack = [];
  for (const token of tokens) {
    if (token === '{' || token === '[') {
      insist(stack.length < 64, 'JSON nesting is excessive');
      stack.push({ object: token === '{', key: token === '{', seen: new Set() });
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (stack.at(-1)?.object) stack.at(-1).key = true; }
    else if (stack.at(-1)?.object && stack.at(-1).key && token.startsWith('"')) {
      const key = JSON.parse(token);
      const frame = stack.at(-1);
      insist(!unsafeKeys.has(key) && !frame.seen.has(key), 'duplicate or unsafe JSON keys');
      frame.seen.add(key);
      frame.key = false;
    }
  }
  canonicalJson(parsed);
  return parsed;
}

export function hash(bytes) {
  insist(typeof bytes === 'string' || bytes instanceof Uint8Array, 'hash input must be bytes or UTF-8 text');
  return createHash('sha256').update(bytes).digest('hex');
}

function equal(left, right) { return canonicalJson(left) === canonicalJson(right); }
function sameDigest(left, right) {
  return typeof left === 'string' && typeof right === 'string' && DIGEST.test(left) && DIGEST.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function timestamp(value) {
  insist(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value), 'timestamp must be UTC ISO-8601');
  const result = Date.parse(value);
  insist(Number.isFinite(result) && new Date(result).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'), 'invalid timestamp');
  return result;
}
function clock(now) { insist(Number.isSafeInteger(now) && now >= 0, 'invalid clock'); return now; }
function numericString(value) { return typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)); }

function inputs(participant, assignment) {
  try {
    validateAssignment(assignment);
    validateParticipant(participant, assignment.participant_name);
  } catch { throw new Error('Plan policy: invalid participant or owner assignment'); }
  insist(participant.instance_number === assignment.instance_number, 'instance differs from owner assignment');
  insist(GUID.test(assignment.subscription_id) && GUID.test(assignment.tenant_id), 'assignment GUIDs must be canonical lowercase');
  timestamp(assignment.expires_at);
  insist(new RegExp(`^/subscriptions/${assignment.subscription_id}/resourceGroups/[A-Za-z0-9_.()-]{1,90}/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]+$`).test(assignment.app_identity_id),
    'bootstrap identity must be one exact existing user-assigned identity');
  return deriveNames(participant);
}

/* Exact manifest binding v1 (no optional fields or aliases):
 * profile, repository, repositoryId, workflowRef, runId, runAttempt, sha, root,
 * operation, subscriptionId, tenant, planClientId, applyClientId, backend,
 * participant, assignment, terraformVersion, providerVersion,
 * participantSha256, assignmentSha256, providerLockSha256, appSha256,
 * infraSha256, workflowSha256, ownerProfileSha256.
 * backend = {subscriptionId,resourceGroupName,storageAccountName,containerName,
 *            key,stateLockId}. JSON-object digests use canonicalJson().
 * infraSha256 covers ALL reviewed root HCL; workflowSha256 covers the exact
 * executing workflow; appSha256 covers the actual immutable deployment ZIP.
 * Terraform's JSON references omit expression operators. They are necessary
 * evidence, NOT an AST proof: independently check the direct HCL expressions
 * before owner-pinning their exact bytes. Never accept caller-asserted digests
 * as evidence that those files or the binary plan were actually validated.
 */
export function validateBinding(binding) {
  canonicalJson(binding);
  exact(binding, ['profile', 'repository', 'repositoryId', 'workflowRef', 'runId', 'runAttempt', 'sha', 'root', 'operation',
    'subscriptionId', 'tenant', 'planClientId', 'applyClientId', 'backend', 'participant', 'assignment', 'terraformVersion',
    'providerVersion', 'participantSha256', 'assignmentSha256', 'providerLockSha256', 'appSha256', 'infraSha256',
    'workflowSha256', 'ownerProfileSha256'], 'binding');
  insist(binding.profile === PROFILE && binding.root === 'infra', 'wrong root or profile');
  insist(typeof binding.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(binding.repository), 'invalid repository');
  insist(numericString(binding.repositoryId) && numericString(binding.runId) && binding.runAttempt === '1', 'invalid repository/run identity or rerun');
  insist(SHA.test(binding.sha), 'invalid revision');
  insist(['deploy', 'destroy', 'followup'].includes(binding.operation), 'invalid operation');
  const workflow = binding.operation === 'destroy' ? 'cleanup.yml' : 'delivery.yml';
  insist(binding.workflowRef === `${binding.repository}/.github/workflows/${workflow}@refs/heads/main`, 'workflow is not the exact main route');
  for (const field of ['subscriptionId', 'tenant', 'planClientId', 'applyClientId']) insist(typeof binding[field] === 'string' && GUID.test(binding[field]), 'invalid scope or identity GUID');
  insist(binding.planClientId !== binding.applyClientId, 'plan and apply identities must be distinct');
  insist(binding.terraformVersion === TERRAFORM_VERSION && binding.providerVersion === PROVIDER_VERSION, 'toolchain differs from the reviewed pins');
  const names = inputs(binding.participant, binding.assignment);
  insist(binding.subscriptionId === binding.assignment.subscription_id && binding.tenant === binding.assignment.tenant_id, 'assignment scope mismatch');
  exact(binding.backend, ['subscriptionId', 'resourceGroupName', 'storageAccountName', 'containerName', 'key', 'stateLockId'], 'backend');
  const backend = binding.backend;
  insist(backend.subscriptionId === binding.subscriptionId, 'backend subscription is not owner-bound');
  insist(typeof backend.resourceGroupName === 'string' && /^[A-Za-z0-9_.()-]{1,90}$/.test(backend.resourceGroupName) &&
    backend.resourceGroupName.toLowerCase() !== names.resourceGroup, 'backend must be outside the workload group');
  insist(/^[a-z0-9]{3,24}$/.test(backend.storageAccountName) && backend.storageAccountName !== names.storage, 'backend account is not isolated');
  insist(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(backend.containerName) && !backend.containerName.includes('--'), 'invalid backend container');
  insist(typeof backend.key === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,180}\.tfstate$/.test(backend.key) &&
    backend.key.split('/').every(part => part && part !== '.' && part !== '..'), 'invalid backend state key');
  insist(typeof backend.stateLockId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/.test(backend.stateLockId), 'invalid backend concurrency identity');
  for (const field of ['participantSha256', 'assignmentSha256', 'providerLockSha256', 'appSha256', 'infraSha256', 'workflowSha256', 'ownerProfileSha256'])
    insist(typeof binding[field] === 'string' && DIGEST.test(binding[field]), 'missing or malformed dependency digest');
  insist(sameDigest(binding.participantSha256, hash(canonicalJson(binding.participant))) &&
    sameDigest(binding.assignmentSha256, hash(canonicalJson(binding.assignment))), 'input object digests do not match');
  return JSON.parse(canonicalJson(binding));
}

const definitions = [
  ['azurerm_resource_group.workshop', 'resourceGroup', ''],
  ['azurerm_virtual_network.workshop', 'vnet', 'Microsoft.Network/virtualNetworks'],
  ['azurerm_subnet.app', 'appSubnet', 'subnets'],
  ['azurerm_subnet.endpoints', 'endpointSubnet', 'subnets'],
  ['azurerm_network_security_group.workshop', 'nsg', 'Microsoft.Network/networkSecurityGroups'],
  ['azurerm_subnet_network_security_group_association.app', null, 'association'],
  ['azurerm_subnet_network_security_group_association.endpoints', null, 'association'],
  ['azurerm_service_plan.workshop', 'servicePlan', 'Microsoft.Web/serverfarms'],
  ['azurerm_linux_web_app.workshop', 'webApp', 'Microsoft.Web/sites'],
  ['azurerm_storage_account.workshop', 'storage', 'Microsoft.Storage/storageAccounts'],
  ['azurerm_storage_container.workshop', 'container', 'container'],
  ['azurerm_private_endpoint.blob', 'privateEndpoint', 'Microsoft.Network/privateEndpoints'],
  ['azurerm_private_dns_zone.blob', 'dnsZone', 'Microsoft.Network/privateDnsZones'],
  ['azurerm_private_dns_zone_virtual_network_link.blob', 'dnsLink', 'dnsLink'],
];
export const RESOURCE_ADDRESSES = Object.freeze(definitions.map(([address]) => address));
const resourceDefinitions = new Map(definitions.map(([address, name, suffix]) => [address, { address, type: address.split('.')[0], name, suffix }]));
const tagged = new Set(['azurerm_resource_group', 'azurerm_virtual_network', 'azurerm_network_security_group', 'azurerm_service_plan',
  'azurerm_linux_web_app', 'azurerm_storage_account', 'azurerm_private_endpoint', 'azurerm_private_dns_zone', 'azurerm_private_dns_zone_virtual_network_link']);
const located = new Set([...tagged].filter(type => !type.startsWith('azurerm_private_dns_')));
// Containers and DNS links establish ownership through exact parent IDs, not RG-name attributes.
const groupNamed = new Set([...tagged, 'azurerm_subnet'].filter(type =>
  !['azurerm_resource_group', 'azurerm_private_dns_zone_virtual_network_link'].includes(type)));
const nameLocals = { resourceGroup: 'resource_group', vnet: 'vnet', nsg: 'nsg', appSubnet: 'app_subnet', endpointSubnet: 'pe_subnet',
  servicePlan: 'plan', webApp: 'app', storage: 'storage', container: 'container', privateEndpoint: 'blob_endpoint', dnsLink: 'dns_link' };

function expectedIds(subscriptionId, names) {
  const group = `/subscriptions/${subscriptionId}/resourceGroups/${names.resourceGroup}`; // no /providers suffix on an RG
  const result = {};
  for (const [address, name, suffix] of definitions) {
    if (!suffix) result[address] = group;
    else if (suffix === 'subnets') result[address] = `${group}/providers/Microsoft.Network/virtualNetworks/${names.vnet}/subnets/${names[name]}`;
    else if (suffix === 'association') result[address] = `${group}/providers/Microsoft.Network/virtualNetworks/${names.vnet}/subnets/${address.endsWith('.app') ? names.appSubnet : names.endpointSubnet}`;
    else if (suffix === 'container') result[address] = `${group}/providers/Microsoft.Storage/storageAccounts/${names.storage}/blobServices/default/containers/${names.container}`;
    else if (suffix === 'dnsLink') result[address] = `${group}/providers/Microsoft.Network/privateDnsZones/${names.dnsZone}/virtualNetworkLinks/${names.dnsLink}`;
    else result[address] = `${group}/providers/${suffix}/${names[name]}`;
  }
  return { group, resources: result };
}

function armEqual(actual, expected) { return typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase(); }
function get(value, path) { return path.split('.').reduce((item, part) => item?.[part], value); }
function unknownAt(unknown, path) {
  let value = unknown;
  for (const part of path.split('.')) { if (value === true) return true; value = value?.[part]; }
  return value === true;
}
function unknownPaths(value, prefix = '', result = []) {
  if (value === true) result.push(prefix);
  else if (value !== false && value != null) {
    insist(object(value) || Array.isArray(value), 'invalid unknown-value marker');
    for (const [key, item] of Object.entries(value)) unknownPaths(item, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}
function referenceAncestors(reference) {
  const parts = reference.split('.');
  return parts.slice(1).map((_, index) => parts.slice(0, parts.length - index).join('.'));
}
function referencesIn(expression, result = []) {
  if (Array.isArray(expression)) for (const item of expression) referencesIn(item, result);
  else if (object(expression)) {
    for (const [key, value] of Object.entries(expression)) {
      if (key === 'references') {
        insist(Object.keys(expression).length === 1 && Array.isArray(value) && value.every(item => typeof item === 'string'), 'malformed HCL references');
        result.push(...value);
      } else if (key !== 'constant_value') referencesIn(value, result);
    }
  }
  return result;
}
function requireReferences(expression, required, additional = []) {
  const references = referencesIn(expression);
  const allowed = new Set([...required, ...additional].flatMap(referenceAncestors));
  insist(required.every(ref => references.includes(ref)) && references.every(ref => allowed.has(ref)), 'HCL reference is missing, indirect or outside the reviewed direct wiring');
}
function constant(expression, expected) {
  insist(object(expression) && Object.keys(expression).length === 1 && Object.hasOwn(expression, 'constant_value') && equal(expression.constant_value, expected),
    'a reviewed HCL literal is required');
}

const servicePlanProfile = { os_type: 'Linux', sku_name: 'B1', worker_count: 1 };
const webProfile = { https_only: true, public_network_access_enabled: true,
  ftp_publish_basic_authentication_enabled: false, webdeploy_publish_basic_authentication_enabled: false };
const siteProfile = { always_on: true, http2_enabled: true, minimum_tls_version: '1.2', scm_minimum_tls_version: '1.2',
  ftps_state: 'Disabled', app_command_line: 'npm start', vnet_route_all_enabled: false, remote_debugging_enabled: false,
  ip_restriction_default_action: 'Deny', scm_ip_restriction_default_action: 'Deny', scm_use_main_ip_restriction: true };
const ingressProfile = { name: 'approved-workshop-network', action: 'Allow', priority: 100 };
const storageProfile = { account_kind: 'StorageV2', account_tier: 'Standard', account_replication_type: 'LRS', access_tier: 'Hot',
  min_tls_version: 'TLS1_2', https_traffic_only_enabled: true, shared_access_key_enabled: false, allow_nested_items_to_be_public: false,
  public_network_access_enabled: false, default_to_oauth_authentication: true, cross_tenant_replication_enabled: false,
  is_hns_enabled: false, sftp_enabled: false, local_user_enabled: false };

function requireLiterals(expressions, expected) {
  for (const [field, value] of Object.entries(expected)) constant(expressions?.[field], value);
}
function singleBlock(expression, fields, label) {
  // SDK attributes-as-blocks can serialize an entirely literal nested value as
  // constant_value rather than child expressions. Only known literal fields
  // and empty schema defaults are accepted; this never manufactures references.
  if (object(expression) && Object.hasOwn(expression, 'constant_value')) {
    exact(expression, ['constant_value'], `${label} HCL literal`);
    const blocks = expression.constant_value;
    insist(Array.isArray(blocks) && blocks.length === 1 && object(blocks[0]) && fields.every(field => Object.hasOwn(blocks[0], field)) &&
      Object.entries(blocks[0]).every(([key, value]) => fields.includes(key) || empty(value)), `one reviewed literal ${label} HCL block is required`);
    return Object.fromEntries(fields.map(field => [field, { constant_value: blocks[0][field] }]));
  }
  insist(Array.isArray(expression) && expression.length === 1, `one direct ${label} HCL block is required`);
  exact(expression[0], fields, `${label} HCL block`);
  return expression[0];
}

function securityConfiguration({ address, type, expressions }) {
  switch (type) {
    case 'azurerm_subnet': {
      const app = address.endsWith('.app');
      requireLiterals(expressions, { default_outbound_access_enabled: false, private_endpoint_network_policies: app ? 'Enabled' : 'Disabled' });
      insist(empty(expressions.service_endpoint), 'service endpoint HCL blocks are outside this profile');
      if (app) {
        const delegation = singleBlock(expressions.delegation, ['name', 'service_delegation'], 'app delegation');
        constant(delegation.name, 'app-service');
        const service = singleBlock(delegation.service_delegation, ['name', 'actions'], 'app service delegation');
        requireLiterals(service, { name: 'Microsoft.Web/serverFarms', actions: ['Microsoft.Network/virtualNetworks/subnets/action'] });
      } else insist(empty(expressions.delegation), 'the endpoint subnet cannot be delegated');
      break;
    }
    case 'azurerm_service_plan': requireLiterals(expressions, servicePlanProfile); break;
    case 'azurerm_linux_web_app': {
      requireLiterals(expressions, webProfile);
      const identity = singleBlock(expressions.identity, ['type', 'identity_ids'], 'app identity');
      constant(identity.type, 'UserAssigned');
      requireReferences(identity.identity_ids, ['var.assignment.app_identity_id']);
      const site = singleBlock(expressions.site_config, [...Object.keys(siteProfile), 'ip_restriction', 'application_stack'], 'site configuration');
      requireLiterals(site, siteProfile);
      // ip_restriction can be an SDK attribute expression whose known literals
      // are not exposed individually in configuration JSON. Both native forms
      // still require the direct owner CIDR reference and exact KNOWN rule values.
      if (object(site.ip_restriction) && Object.hasOwn(site.ip_restriction, 'references'))
        requireReferences(site.ip_restriction, ['var.assignment.allowed_web_cidr']);
      else {
        const rule = singleBlock(site.ip_restriction, [...Object.keys(ingressProfile), 'ip_address'], 'workshop ingress');
        requireLiterals(rule, ingressProfile);
        requireReferences(rule.ip_address, ['var.assignment.allowed_web_cidr']);
      }
      const stack = singleBlock(site.application_stack, ['node_version'], 'Node application stack');
      constant(stack.node_version, '24-lts');
      // Terraform emits a mixed object attribute as one references expression,
      // unlike nested schema blocks. Its literal package flag is checked below
      // against the complete, known app_settings value, not invented JSON keys.
      requireReferences(expressions.app_settings, ['var.app_message', 'var.page_theme', 'var.workshop_iteration',
        'azurerm_storage_account.workshop.name', 'azurerm_storage_container.workshop.name', 'var.assignment.app_identity_id']);
      break;
    }
    case 'azurerm_storage_account': requireLiterals(expressions, storageProfile); break;
    case 'azurerm_storage_container': constant(expressions.container_access_type, 'private'); break;
    case 'azurerm_private_endpoint': {
      const connection = singleBlock(expressions.private_service_connection,
        ['name', 'private_connection_resource_id', 'subresource_names', 'is_manual_connection'], 'blob private connection');
      requireReferences(connection.name, ['local.names.blob_endpoint']);
      requireReferences(connection.private_connection_resource_id, ['azurerm_storage_account.workshop.id']);
      requireLiterals(connection, { subresource_names: ['blob'], is_manual_connection: false });
      const group = singleBlock(expressions.private_dns_zone_group, ['name', 'private_dns_zone_ids'], 'blob private DNS group');
      requireReferences(group.name, ['local.names.dns_group']);
      requireReferences(group.private_dns_zone_ids, ['azurerm_private_dns_zone.blob.id']);
      break;
    }
    case 'azurerm_private_dns_zone_virtual_network_link':
      insist(!Object.hasOwn(expressions, 'resource_group_name') && !Object.hasOwn(expressions, 'private_dns_zone_name'),
        'removed DNS-link HCL attributes are forbidden');
      constant(expressions.registration_enabled, false);
      break;
  }
}

function configuration(plan, changes) {
  const config = plan.configuration;
  insist(object(config) && object(config.root_module) && object(config.provider_config), 'full Terraform configuration evidence is required');
  insist(equal(Object.keys(config.provider_config), ['azurerm']), 'provider aliases or additional providers are forbidden');
  const provider = config.provider_config.azurerm;
  insist(provider.full_name === PROVIDER && String(provider.version_constraint).replace(/\s/g, '').replace(/^=/, '') === PROVIDER_VERSION,
    'wrong provider source or constraint');
  insist(object(provider.expressions) && Object.keys(provider.expressions).every(key =>
    ['subscription_id', 'tenant_id', 'use_oidc', 'use_cli', 'storage_use_azuread', 'resource_provider_registrations', 'features'].includes(key)),
  'provider credentials, aliases and unreviewed authentication overrides are forbidden');
  requireReferences(provider.expressions?.subscription_id, ['var.assignment.subscription_id']);
  requireReferences(provider.expressions?.tenant_id, ['var.assignment.tenant_id']);
  for (const [key, value] of Object.entries({ use_oidc: true, use_cli: false, storage_use_azuread: true, resource_provider_registrations: 'none' }))
    constant(provider.expressions?.[key], value);
  insist(empty(config.root_module.module_calls), 'child modules are outside this root profile');
  const resources = config.root_module.resources;
  insist(Array.isArray(resources) && resources.length === RESOURCE_ADDRESSES.length, 'the complete reviewed root inventory is required');
  const map = new Map();
  for (const resource of resources) {
    const definition = resourceDefinitions.get(resource.address);
    insist(definition && resource.mode === 'managed' && resource.type === definition.type && resource.name === resource.address.split('.')[1] &&
      resource.provider_config_key === 'azurerm' && !map.has(resource.address), 'unapproved HCL address, type, provider or mode');
    for (const key of ['count_expression', 'for_each_expression', 'provisioners', 'module_address', 'importing', 'imports'])
      insist(empty(resource[key]), 'imports, provisioners and dynamic resource instances are forbidden');
    insist(object(resource.expressions), 'HCL expressions are missing');
    map.set(resource.address, resource);
    if (definition.name === 'dnsZone') constant(resource.expressions.name, 'privatelink.blob.core.windows.net');
    else if (definition.name) requireReferences(resource.expressions.name, [`local.names.${nameLocals[definition.name]}`]);
    if (definition.type === 'azurerm_resource_group') requireReferences(resource.expressions.location, ['var.assignment.location']);
    else if (groupNamed.has(definition.type))
      requireReferences(resource.expressions.resource_group_name, ['azurerm_resource_group.workshop.name']);
    if (located.has(definition.type) && definition.type !== 'azurerm_resource_group')
      requireReferences(resource.expressions.location, ['azurerm_resource_group.workshop.location']);
    if (tagged.has(definition.type)) requireReferences(resource.expressions.tags, ['local.tags']);
    securityConfiguration(resource);
  }
  for (const resource of changes) insist(map.has(resource.address), 'planned resource has no reviewed direct configuration');
  return map;
}

const computed = {
  azurerm_resource_group: [],
  azurerm_virtual_network: ['guid'],
  azurerm_subnet: [],
  azurerm_network_security_group: [],
  azurerm_subnet_network_security_group_association: [],
  azurerm_service_plan: ['maximum_number_of_workers', 'reserved'],
  azurerm_linux_web_app: ['custom_domain_verification_id', 'default_hostname', 'outbound_ip_address_list', 'outbound_ip_addresses',
    'possible_outbound_ip_address_list', 'possible_outbound_ip_addresses', 'site_credential', 'kind', 'hosting_environment_id',
    'identity.0.principal_id', 'identity.0.tenant_id', 'site_config.0.default_documents', 'site_config.0.linux_fx_version'],
  azurerm_storage_account: ['primary_access_key', 'secondary_access_key', 'primary_connection_string', 'secondary_connection_string',
    'primary_blob_connection_string', 'secondary_blob_connection_string', 'primary_location', 'secondary_location'],
  azurerm_storage_container: ['resource_manager_id', 'has_immutability_policy', 'has_legal_hold'],
  azurerm_private_endpoint: ['custom_dns_configs', 'network_interface', 'private_service_connection.0.private_ip_address', 'private_dns_zone_group.0.id', 'private_dns_zone_configs'],
  azurerm_private_dns_zone: ['number_of_record_sets', 'max_number_of_record_sets', 'max_number_of_virtual_network_links', 'max_number_of_virtual_network_links_with_registration'],
  // The DNS-link ID is handled separately; parent IDs are exact references, not computed-output exemptions.
  azurerm_private_dns_zone_virtual_network_link: [],
};
for (const primary of ['primary', 'secondary']) for (const service of ['blob', 'dfs', 'file', 'queue', 'table', 'web'])
  for (const endpoint of ['endpoint', 'host', 'internet_endpoint', 'internet_host', 'microsoft_endpoint', 'microsoft_host'])
    computed.azurerm_storage_account.push(`${primary}_${service}_${endpoint}`);

function referenceSpecs(address) {
  const specs = {};
  const add = (path, target, field = path.split('.')[0]) => { specs[path] = { target, field }; };
  if (address.startsWith('azurerm_subnet_network_security_group_association.')) {
    add('subnet_id', `azurerm_subnet.${address.endsWith('.app') ? 'app' : 'endpoints'}`);
    add('network_security_group_id', 'azurerm_network_security_group.workshop');
  } else if (address === 'azurerm_linux_web_app.workshop') {
    add('service_plan_id', 'azurerm_service_plan.workshop');
    add('virtual_network_subnet_id', 'azurerm_subnet.app');
  } else if (address === 'azurerm_storage_container.workshop') add('storage_account_id', 'azurerm_storage_account.workshop');
  else if (address === 'azurerm_private_endpoint.blob') {
    add('subnet_id', 'azurerm_subnet.endpoints');
    add('private_service_connection.0.private_connection_resource_id', 'azurerm_storage_account.workshop', 'private_service_connection.0.private_connection_resource_id');
    add('private_dns_zone_group.0.private_dns_zone_ids.0', 'azurerm_private_dns_zone.blob', 'private_dns_zone_group.0.private_dns_zone_ids');
  } else if (address === 'azurerm_private_dns_zone_virtual_network_link.blob') {
    add('private_dns_zone_id', 'azurerm_private_dns_zone.blob');
    add('virtual_network_id', 'azurerm_virtual_network.workshop');
  }
  return specs;
}

function scanOwnedIds(value, scope, path = '') {
  if (typeof value === 'string' && /^\/subscriptions\//i.test(value)) {
    const identityPath = /(?:^|\.)identity\.0\.identity_ids\.\d+$/.test(path) || path === 'app_settings.MANAGED_IDENTITY_RESOURCE_ID';
    insist((identityPath && armEqual(value, scope.assignment.app_identity_id)) || armEqual(value, scope.ids.group) ||
      (value.toLowerCase().startsWith(`${scope.ids.group}/providers/`.toLowerCase()) && !/[?#%\\]/.test(value)), 'foreign or malformed ARM ID');
  } else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) scanOwnedIds(item, scope, path ? `${path}.${key}` : key);
}

function validateValues(resource, values, side, scope, configs, actions) {
  insist(object(values), 'resource values are missing');
  const { address, type } = resource;
  const definition = resourceDefinitions.get(address);
  const unknown = side === 'after' ? resource.change.after_unknown ?? {} : {};
  const create = resource.change.actions[0] === 'create';
  const specs = referenceSpecs(address);
  const expressions = configs.get(address).expressions;
  for (const path of unknownPaths(unknown)) {
    if (path === 'id') insist(create && side === 'after', 'an existing resource ID cannot become unknown');
    else if (specs[path]) insist(create && actions.get(specs[path].target) === 'create', 'unknown dependency must be an exact newly-created owned resource');
    else insist(computed[type].some(field => path === field || path.startsWith(`${field}.`)), 'a policy-critical or unrecognized value is unknown');
  }
  const known = (path, expected, isId = false) => {
    if (unknownAt(unknown, path)) {
      const spec = specs[path];
      insist(side === 'after' && create && spec && actions.get(spec.target) === 'create', 'critical value cannot be unknown');
      requireReferences(get(expressions, spec.field), [`${spec.target}.id`]);
      insist(get(values, path) == null, 'unknown marker contradicts a known value');
    } else {
      const actual = get(values, path);
      insist(actual !== undefined && (isId ? armEqual(actual, expected) : equal(actual, expected)), 'resource value differs from the reviewed scope, name or security profile');
    }
  };
  if (side === 'after' && create && unknownAt(unknown, 'id')) insist(values.id == null, 'unknown ID contradicts its value');
  else known('id', scope.ids.resources[address], true);
  if (definition.name) known('name', scope.names[definition.name]);
  if (groupNamed.has(type)) known('resource_group_name', scope.names.resourceGroup);
  if (located.has(type)) known('location', scope.assignment.location);
  if (tagged.has(type)) {
    const expectedTags = { owner: scope.assignment.owner, environment: 'training', cost_center: scope.assignment.cost_center, workshop: 'ws2-iac',
      participant: scope.participant.participant_name, workshop_iteration: scope.participant.workshop_iteration, expires_at: scope.assignment.expires_at };
    if (side === 'before') {
      insist(['01', '02', '03'].includes(values.tags?.workshop_iteration), 'unrecognized prior iteration');
      expectedTags.workshop_iteration = values.tags.workshop_iteration;
    }
    known('tags', expectedTags);
  }
  for (const [path, spec] of Object.entries(specs)) {
    requireReferences(get(expressions, spec.field), [`${spec.target}.id`]);
    known(path, scope.ids.resources[spec.target], true);
  }
  const noExtras = fields => { for (const field of fields) insist(empty(get(values, field)) && !unknownAt(unknown, field), 'unreviewed auxiliary resource configuration'); };
  const optionalFalse = fields => { for (const field of fields) if (values[field] != null) known(field, false); };
  switch (type) {
    case 'azurerm_resource_group': noExtras(['managed_by']); break;
    case 'azurerm_virtual_network':
      known('address_space', [`10.80.${scope.assignment.network_slot}.0/24`]);
      known('dns_servers', []);
      noExtras(['subnet', 'ddos_protection_plan', 'encryption', 'ip_address_pool', 'edge_zone', 'bgp_community']);
      requireReferences(configs.get(address).expressions.address_space, ['local.vnet_cidr']);
      break;
    case 'azurerm_subnet': {
      const app = address.endsWith('.app');
      known('virtual_network_name', scope.names.vnet);
      known('address_prefixes', [`10.80.${scope.assignment.network_slot}.${app ? '0/26' : '64/27'}`]);
      known('default_outbound_access_enabled', false);
      known('private_endpoint_network_policies', app ? 'Enabled' : 'Disabled');
      known('private_link_service_network_policies_enabled', true);
      noExtras(['service_endpoint', 'service_endpoint_policy_ids', 'ip_address_pool']);
      requireReferences(configs.get(address).expressions.virtual_network_name, ['azurerm_virtual_network.workshop.name']);
      requireReferences(configs.get(address).expressions.address_prefixes, [app ? 'local.app_cidr' : 'local.pe_cidr']);
      if (app) {
        insist(Array.isArray(values.delegation) && values.delegation.length === 1, 'one app-service delegation is required');
        known('delegation.0.name', 'app-service');
        known('delegation.0.service_delegation', [{ name: 'Microsoft.Web/serverFarms', actions: ['Microsoft.Network/virtualNetworks/subnets/action'] }]);
      } else known('delegation', []);
      break;
    }
    case 'azurerm_network_security_group': known('security_rule', []); break;
    case 'azurerm_subnet_network_security_group_association': break;
    case 'azurerm_service_plan':
      for (const [key, value] of Object.entries(servicePlanProfile)) known(key, value);
      noExtras(['app_service_environment_id']);
      optionalFalse(['zone_balancing_enabled', 'per_site_scaling_enabled', 'premium_plan_auto_scale_enabled']);
      if (values.maximum_elastic_worker_count != null) insist(values.maximum_elastic_worker_count <= 1, 'elastic scale exceeds the fixed one-worker profile');
      break;
    case 'azurerm_linux_web_app': {
      for (const [key, value] of Object.entries(webProfile)) known(key, value);
      known('enabled', true);
      known('identity.0.type', 'UserAssigned'); known('identity.0.identity_ids', [scope.assignment.app_identity_id]);
      insist(Array.isArray(values.identity) && values.identity.length === 1, 'exactly the existing user-assigned identity is required');
      // Public HTTPS ingress is owner-CIDR restricted, never an Azure-policy fallback.
      insist(Array.isArray(values.site_config) && values.site_config.length === 1, 'one reviewed site configuration is required');
      // Only private Blob traffic uses the VNet; startup's internet dependencies
      // deliberately use direct app egress, not an unpriced NAT/firewall route.
      for (const [key, value] of Object.entries(siteProfile)) known(`site_config.0.${key}`, value);
      const site = values.site_config[0];
      insist(Array.isArray(site.application_stack) && site.application_stack.length === 1 && site.application_stack[0].node_version === '24-lts' &&
        Object.entries(site.application_stack[0]).every(([key, value]) => key === 'node_version' || empty(value)), 'only the reviewed Node 24 stack is supported');
      insist(Array.isArray(site.ip_restriction) && site.ip_restriction.length === 1, 'exactly one owner-bound workshop ingress rule is required');
      for (const [key, value] of Object.entries(ingressProfile)) known(`site_config.0.ip_restriction.0.${key}`, value);
      known('site_config.0.ip_restriction.0.ip_address', scope.assignment.allowed_web_cidr);
      insist(Object.entries(site.ip_restriction[0]).every(([key, value]) => [...Object.keys(ingressProfile), 'ip_address'].includes(key) || empty(value)),
        'ingress headers, service tags and alternate subnet selectors are forbidden');
      noExtras(['site_config.0.scm_ip_restriction']);
      noExtras(['backup', 'connection_string', 'storage_account', 'sticky_settings', 'key_vault_reference_identity_id', 'zip_deploy_file', 'auth_settings_v2']);
      if (!empty(values.auth_settings)) known('auth_settings.0.enabled', false);
      const app = values.app_settings;
      const expectedSettings = { APP_MESSAGE: scope.participant.app_message, PAGE_THEME: scope.participant.page_theme,
        WORKSHOP_ITERATION: scope.participant.workshop_iteration, STORAGE_ACCOUNT_NAME: scope.names.storage,
        STORAGE_CONTAINER_NAME: scope.names.container, MANAGED_IDENTITY_RESOURCE_ID: scope.assignment.app_identity_id, WEBSITE_RUN_FROM_PACKAGE: '1' };
      exact(app, Object.keys(expectedSettings), 'application settings');
      for (const key of Object.keys(app)) {
        if (side === 'before' && ['APP_MESSAGE', 'PAGE_THEME', 'WORKSHOP_ITERATION'].includes(key)) continue;
        known(`app_settings.${key}`, expectedSettings[key]);
      }
      if (side === 'before') {
        try { validateParticipant({ ...scope.participant, app_message: app.APP_MESSAGE, page_theme: app.PAGE_THEME, workshop_iteration: app.WORKSHOP_ITERATION }); }
        catch { throw new Error('Plan policy: invalid prior application settings'); }
      }
      break;
    }
    case 'azurerm_storage_account':
      for (const [key, value] of Object.entries(storageProfile)) known(key, value);
      optionalFalse(['nfsv3_enabled', 'large_file_share_enabled']);
      noExtras(['custom_domain', 'static_website', 'customer_managed_key', 'identity', 'azure_files_authentication', 'edge_zone']);
      if (!empty(values.network_rules)) {
        known('network_rules.0.default_action', 'Deny'); known('network_rules.0.bypass', ['None']);
        known('network_rules.0.ip_rules', []); known('network_rules.0.virtual_network_subnet_ids', []);
        insist(empty(values.network_rules[0].private_link_access), 'unreviewed trusted private-link access');
      }
      break;
    case 'azurerm_storage_container':
      known('container_access_type', 'private');
      noExtras(['storage_account_name', 'metadata']);
      if (values.resource_manager_id != null) known('resource_manager_id', scope.ids.resources[address], true);
      break;
    case 'azurerm_private_endpoint':
      insist(Array.isArray(values.private_service_connection) && values.private_service_connection.length === 1 &&
        Array.isArray(values.private_dns_zone_group) && values.private_dns_zone_group.length === 1, 'exactly one blob connection and DNS group are required');
      known('private_service_connection.0.name', scope.names.privateEndpoint);
      known('private_service_connection.0.subresource_names', ['blob']);
      known('private_service_connection.0.is_manual_connection', false);
      insist(empty(values.private_service_connection[0].private_connection_resource_alias) && empty(values.private_service_connection[0].request_message), 'private-link aliases/manual requests are forbidden');
      known('private_dns_zone_group.0.name', scope.names.dnsGroup);
      insist(values.private_dns_zone_group[0].private_dns_zone_ids?.length === 1, 'only the owned blob DNS zone may be attached');
      if (values.private_dns_zone_group[0].id != null)
        known('private_dns_zone_group.0.id', `${scope.ids.resources[address]}/privateDnsZoneGroups/${scope.names.dnsGroup}`, true);
      if (values.private_service_connection[0].private_ip_address != null) {
        const ip = values.private_service_connection[0].private_ip_address;
        insist(typeof ip === 'string' && ip.startsWith(`10.80.${scope.assignment.network_slot}.`) &&
          /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip) && Number(ip.split('.')[3]) >= 68 && Number(ip.split('.')[3]) <= 94, 'private endpoint IP is outside the assigned subnet');
      }
      noExtras(['ip_configuration', 'custom_network_interface_name']);
      break;
    case 'azurerm_private_dns_zone':
      insist(scope.names.dnsZone === 'privatelink.blob.core.windows.net', 'wrong blob DNS zone');
      noExtras(['soa_record']);
      break;
    case 'azurerm_private_dns_zone_virtual_network_link':
      insist(!Object.hasOwn(values, 'resource_group_name') && !Object.hasOwn(values, 'private_dns_zone_name'),
        'removed DNS-link value attributes are forbidden');
      known('registration_enabled', false);
      if (values.resolution_policy != null) known('resolution_policy', 'Default');
      break;
    default: insist(false, 'unsupported resource type');
  }
  scanOwnedIds(values, scope);
}

function assertChange(resource, operation, seen) {
  const definition = resourceDefinitions.get(resource.address);
  insist(definition && definition.type === resource.type && resource.mode === 'managed' && resource.provider_name === PROVIDER &&
    resource.name === resource.address.split('.')[1] && !seen.has(resource.address), 'unapproved or duplicate resource address/type/mode/provider');
  seen.add(resource.address);
  for (const key of ['index', 'module_address', 'previous_address', 'deposed', 'importing', 'provisioners'])
    insist(resource[key] == null, 'instances, moved/deposed resources, imports or provisioners are forbidden');
  insist(object(resource.change), 'missing resource change');
  insist(empty(resource.change.importing) && empty(resource.change.generated_config) && empty(resource.change.replace_paths), 'import, generated configuration or replacement is forbidden');
  const actions = resource.change.actions;
  insist(Array.isArray(actions) && actions.length === 1 && ['no-op', 'create', 'update', 'delete'].includes(actions[0]), 'unknown, replacement or compound plan action');
  const action = actions[0];
  if (operation === 'destroy') insist(['delete', 'no-op'].includes(action), 'cleanup can only delete or retain its own resources');
  else if (operation === 'followup') insist(action === 'no-op', 'followup must prove no change');
  else insist(action !== 'delete', 'ordinary deployment cannot delete or replace');
  insist(action === 'create' ? resource.change.before === null : object(resource.change.before), 'missing or unexpected prior values');
  insist(action === 'delete' ? resource.change.after === null : object(resource.change.after), 'missing or unexpected planned values');
  if (action === 'no-op') insist(equal(resource.change.before, resource.change.after), 'no-op values differ');
  return action;
}

function withoutUnknown(value, unknown) {
  if (unknown === true) return undefined;
  if (Array.isArray(value)) return value.map((item, index) => withoutUnknown(item, unknown?.[index]) ?? null);
  if (object(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => unknown?.[key] !== true)
    .map(([key, item]) => [key, withoutUnknown(item, unknown?.[key])]));
  return value;
}

export function summarizePlan(plan, { subscriptionId, participant, assignment, operation }) {
  insist(Buffer.byteLength(canonicalJson(plan)) <= MAX_JSON, 'plan JSON is oversized');
  insist(object(plan) && plan.format_version === '1.2' && plan.terraform_version === TERRAFORM_VERSION, 'unsupported Terraform plan format or version');
  insist(['deploy', 'destroy', 'followup'].includes(operation), 'unsupported plan operation');
  const names = inputs(participant, assignment);
  insist(subscriptionId === assignment.subscription_id, 'plan subscription differs from assignment');
  // Provider subscription/tenant references are safe only if their actual
  // Terraform variable values match the separately supplied owner assignment.
  const expectedVariables = terraformVariables(participant, assignment);
  exact(plan.variables, Object.keys(expectedVariables), 'Terraform variables');
  for (const [key, expected] of Object.entries(expectedVariables)) {
    exact(plan.variables[key], ['value'], 'Terraform variable');
    insist(equal(plan.variables[key].value, expected), 'Terraform variable values differ from the bound participant or assignment');
  }
  insist(plan.errored !== true && plan.complete !== false && empty(plan.deferred_changes) && empty(plan.resource_drift) && empty(plan.imports), 'errored, deferred, imported or drifted plans are not admissible');
  if (plan.checks != null) insist(Array.isArray(plan.checks) && plan.checks.every(check => check.status === 'pass'), 'Terraform checks are not conclusively passing');
  const changes = plan.resource_changes;
  insist(Array.isArray(changes) && changes.length <= RESOURCE_ADDRESSES.length, 'resource changes are missing or oversized');
  const seen = new Set();
  const actions = new Map(changes.map(resource => [resource.address, assertChange(resource, operation, seen)]));
  if (operation !== 'destroy') insist(changes.length === RESOURCE_ADDRESSES.length, 'deployment must account for the complete owned inventory');
  const configs = configuration(plan, changes);
  const scope = { subscriptionId, participant, assignment, names, ids: expectedIds(subscriptionId, names) };
  const totals = { create: 0, update: 0, delete: 0, replace: 0, noChange: 0 };
  const resources = [];
  for (const resource of changes) {
    if (resource.change.before !== null) validateValues(resource, resource.change.before, 'before', scope, configs, actions);
    if (resource.change.after !== null) validateValues(resource, resource.change.after, 'after', scope, configs, actions);
    else insist(unknownPaths(resource.change.after_unknown ?? {}).length === 0, 'deleted resource has unknown after-values');
    const action = actions.get(resource.address) === 'no-op' ? 'noChange' : actions.get(resource.address);
    totals[action] += 1;
    resources.push({ address: resource.address, action });
  }
  // Planned-values evidence must agree with changes, not introduce unmanaged
  // objects absent from the policy-reviewed resource_changes array.
  const planned = plan.planned_values?.root_module;
  insist(object(planned) && empty(planned.child_modules), 'direct planned-root evidence is required');
  const plannedResources = planned.resources ?? [];
  insist(Array.isArray(plannedResources), 'invalid planned resources');
  const plannedSeen = new Set();
  for (const resource of plannedResources) {
    const change = changes.find(item => item.address === resource.address);
    insist(change && !plannedSeen.has(resource.address) && change.change.after !== null && resource.mode === 'managed' &&
      resource.type === change.type && resource.provider_name === PROVIDER &&
      equal(withoutUnknown(resource.values, change.change.after_unknown), withoutUnknown(change.change.after, change.change.after_unknown)),
    'planned values diverge from reviewed changes');
    plannedSeen.add(resource.address);
  }
  insist(plannedSeen.size === changes.filter(resource => resource.change.after !== null).length, 'planned inventory is incomplete');
  return { totals, resources: resources.sort((a, b) => a.address.localeCompare(b.address)) };
}

function planBytesCheck(bytes) { insist(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_PLAN, 'saved plan has an invalid size'); }
function planExit(exitCode) { insist(exitCode === 0 || exitCode === 2, 'Terraform plan did not succeed'); }

export function makeManifest(binding, planBytes, { now = Date.now(), exitCode = 2 } = {}) {
  clock(now); planBytesCheck(planBytes); planExit(exitCode);
  const checked = validateBinding(binding);
  const assignmentExpiry = timestamp(checked.assignment.expires_at);
  insist(assignmentExpiry > now, 'owner assignment has expired');
  return { schemaVersion: 1, binding: checked, createdAt: new Date(now).toISOString(),
    expiresAt: new Date(Math.min(now + MAX_PLAN_AGE_MS, assignmentExpiry)).toISOString(), planSha256: hash(planBytes), exitCode };
}

export function verifyPlan({ manifest, manifestBytes, planBytes, binding, expectedPlanHash, expectedManifestHash, currentSha, now = Date.now() }) {
  clock(now); planBytesCheck(planBytes);
  insist(typeof expectedPlanHash === 'string' && DIGEST.test(expectedPlanHash) && typeof expectedManifestHash === 'string' && DIGEST.test(expectedManifestHash), 'trusted expected artifact digests are required');
  insist(manifestBytes instanceof Uint8Array && manifestBytes.byteLength <= MAX_MANIFEST && sameDigest(hash(manifestBytes), expectedManifestHash), 'manifest bytes were altered');
  const decoded = parseStrictJson(manifestBytes);
  insist(equal(decoded, manifest), 'manifest object differs from authenticated bytes');
  exact(decoded, ['schemaVersion', 'binding', 'createdAt', 'expiresAt', 'planSha256', 'exitCode'], 'manifest');
  insist(decoded.schemaVersion === 1, 'unsupported manifest schema');
  const expectedBinding = validateBinding(binding);
  validateBinding(decoded.binding);
  insist(equal(decoded.binding, expectedBinding), 'repository, run, scope, backend, inputs or dependency binding changed');
  insist(typeof currentSha === 'string' && SHA.test(currentSha) && currentSha === binding.sha, 'protected main moved');
  insist(sameDigest(hash(planBytes), expectedPlanHash) && sameDigest(decoded.planSha256, expectedPlanHash), 'saved plan was altered');
  const created = timestamp(decoded.createdAt);
  const expires = timestamp(decoded.expiresAt);
  const assignmentExpiry = timestamp(binding.assignment.expires_at);
  insist(created <= now && now - created <= MAX_PLAN_AGE_MS && now <= expires && assignmentExpiry > now &&
    expires === Math.min(created + MAX_PLAN_AGE_MS, assignmentExpiry), 'saved plan is stale, future-dated or beyond the owner window');
  try { validateAssignment(binding.assignment, { live: true, now }); }
  catch { throw new Error('Plan policy: a current explicit live owner assignment is required'); }
  planExit(decoded.exitCode);
  insist(['deploy', 'destroy'].includes(binding.operation), 'read-only operations cannot apply a saved plan');
  return true;
}
