import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { sealPlan, openPlan } from '../scripts/plan-envelope.mjs';
import {
  TERRAFORM_VERSION, PROVIDER_VERSION, MAX_PLAN_AGE_MS, PROFILE, RESOURCE_ADDRESSES,
  canonicalJson, parseStrictJson, hash, validateBinding, summarizePlan, makeManifest, verifyPlan,
} from '../scripts/plan-policy.mjs';
import { deriveNames } from '../scripts/inputs.mjs';
import authorization from '../scripts/deployment-authorization.cjs';

// Every identity/value below is synthetic. No CLI, files, network, Azure, Git,
// credentials, existing state or private keys are read. Generated keys are
// ephemeral unit-test material and are never printed or written.
const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAN_CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPLY_CLIENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const PLAN_BYTES = Buffer.from('synthetic saved binary\0PRIVATE_PLAN_MARKER', 'utf8');
const PROVIDER = 'registry.terraform.io/hashicorp/azurerm';
const clone = value => structuredClone(value);
const digest = value => hash(Buffer.from(value));
// Terraform includes traversal ancestors alongside leaf references; nested
// schema blocks remain arrays, while mixed object attributes collapse to refs.
const ref = (...values) => ({ references: [...new Set(values.flatMap(value => {
  const parent = value.split('.').slice(0, 2).join('.');
  return parent === value ? [value] : [value, parent];
}))] });
const literal = value => ({ constant_value: value });
const route07 = authorization.ALLOWED_REPOSITORIES['1379149907'];
const route02 = authorization.ALLOWED_REPOSITORIES['1379147533'];
const JOBS_ROUTE = 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs';
// Opaque synthetic owner pins, NOT a recipe for deriving production subjects.
const OIDC_SUBJECTS = {
  '1379147533': {
    plan: 'repo:alvine-aurelio-org/ws2-sim-20260921-network-module-laboratory-02:repository_owner_id:9001:repository_id:1379147533:environment:workshop-plan',
    apply: 'repo:alvine-aurelio-org/ws2-sim-20260921-network-module-laboratory-02:repository_owner_id:9001:repository_id:1379147533:environment:workshop-apply',
  },
  '1379149907': {
    plan: 'repo:alvine-aurelio-org/ws2-sim-20260921-azure-delivery-laboratory-07:repository_owner_id:9001:repository_id:1379149907:environment:workshop-plan',
    apply: 'repo:alvine-aurelio-org/ws2-sim-20260921-azure-delivery-laboratory-07:repository_owner_id:9001:repository_id:1379149907:environment:workshop-apply',
  },
};
let keys;
let otherKeys;
before(() => {
  keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  otherKeys = generateKeyPairSync('rsa', { modulusLength: 3072 });
});

function participant() {
  return { participant_name: 'alex', instance_number: '001', app_message: 'Hello from alex', page_theme: 'blue', workshop_iteration: '01' };
}
function assignment(now = NOW) {
  return { schema_version: 1, mode: 'live', participant_name: 'alex', learner_user_ids: [101], instance_number: '001', network_slot: 21,
    location: 'southeastasia', allowed_web_cidr: '203.0.113.0/24', subscription_id: SUB, tenant_id: TENANT,
    app_identity_id: `/subscriptions/${SUB}/resourceGroups/rg-instructor-bootstrap/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-test-only`,
    owner: 'training-owner', cost_center: 'training', expires_at: new Date(now + 4 * 60 * 60 * 1000).toISOString() };
}
function backend() {
  return { subscriptionId: SUB, resourceGroupName: 'rg-test-bootstrap', storageAccountName: 'sttestonlybackend', containerName: 'tfstate',
    key: 'participants/alex-001.tfstate', stateLockId: 'test-alex-001' };
}
function binding({ now = NOW, operation = 'deploy', route = route07 } = {}) {
  const input = participant();
  const ownerAssignment = assignment(now);
  return { profile: PROFILE, repository: route.repository, repositoryId: String(route.id),
    workflowRef: `${route.repository}/.github/workflows/${operation === 'destroy' ? 'cleanup.yml' : 'delivery.yml'}@refs/heads/main`,
    runId: '910001', runAttempt: '1', sha: SHA, root: 'infra', operation, subscriptionId: SUB, tenant: TENANT,
    planClientId: PLAN_CLIENT, applyClientId: APPLY_CLIENT, backend: backend(), participant: input, assignment: ownerAssignment,
    terraformVersion: TERRAFORM_VERSION, providerVersion: PROVIDER_VERSION, participantSha256: hash(canonicalJson(input)),
    assignmentSha256: hash(canonicalJson(ownerAssignment)), providerLockSha256: digest('synthetic provider lock'),
    appSha256: digest('synthetic immutable ZIP'), infraSha256: digest('synthetic reviewed HCL'), workflowSha256: digest('synthetic delivery YAML'),
    ownerProfileSha256: digest('synthetic owner profile') };
}
function ids(input = participant()) {
  const names = deriveNames(input);
  const group = `/subscriptions/${SUB}/resourceGroups/${names.resourceGroup}`;
  const make = (provider, type, name) => `${group}/providers/${provider}/${type}/${name}`;
  const vnet = make('Microsoft.Network', 'virtualNetworks', names.vnet);
  const storage = make('Microsoft.Storage', 'storageAccounts', names.storage);
  const dns = make('Microsoft.Network', 'privateDnsZones', names.dnsZone);
  return {
    'azurerm_resource_group.workshop': group,
    'azurerm_virtual_network.workshop': vnet,
    'azurerm_subnet.app': `${vnet}/subnets/${names.appSubnet}`,
    'azurerm_subnet.endpoints': `${vnet}/subnets/${names.endpointSubnet}`,
    'azurerm_network_security_group.workshop': make('Microsoft.Network', 'networkSecurityGroups', names.nsg),
    'azurerm_subnet_network_security_group_association.app': `${vnet}/subnets/${names.appSubnet}`,
    'azurerm_subnet_network_security_group_association.endpoints': `${vnet}/subnets/${names.endpointSubnet}`,
    'azurerm_service_plan.workshop': make('Microsoft.Web', 'serverfarms', names.servicePlan),
    'azurerm_linux_web_app.workshop': make('Microsoft.Web', 'sites', names.webApp),
    'azurerm_storage_account.workshop': storage,
    'azurerm_storage_container.workshop': `${storage}/blobServices/default/containers/${names.container}`,
    'azurerm_private_endpoint.blob': make('Microsoft.Network', 'privateEndpoints', names.privateEndpoint),
    'azurerm_private_dns_zone.blob': dns,
    'azurerm_private_dns_zone_virtual_network_link.blob': `${dns}/virtualNetworkLinks/${names.dnsLink}`,
  };
}

function synchronize(plan) {
  plan.planned_values.root_module.resources = plan.resource_changes.filter(resource => resource.change.after !== null).map(resource => ({
    address: resource.address, name: resource.name, mode: resource.mode, type: resource.type,
    provider_name: resource.provider_name, values: clone(resource.change.after),
  }));
  return plan;
}

function planFixture({ action = 'create', input = participant(), ownerAssignment = assignment() } = {}) {
  const names = deriveNames(input);
  const ownIds = ids(input);
  const tags = { owner: ownerAssignment.owner, environment: 'training', cost_center: ownerAssignment.cost_center, workshop: 'ws2-iac',
    participant: input.participant_name, workshop_iteration: input.workshop_iteration, expires_at: ownerAssignment.expires_at };
  const shared = { resource_group_name: names.resourceGroup, location: ownerAssignment.location, tags };
  const values = {
    'azurerm_resource_group.workshop': { name: names.resourceGroup, location: shared.location, tags },
    'azurerm_virtual_network.workshop': { ...shared, name: names.vnet, address_space: ['10.80.21.0/24'], dns_servers: [], subnet: [] },
    'azurerm_subnet.app': { name: names.appSubnet, resource_group_name: names.resourceGroup, virtual_network_name: names.vnet,
      address_prefixes: ['10.80.21.0/26'], private_endpoint_network_policies: 'Enabled', private_link_service_network_policies_enabled: true,
      default_outbound_access_enabled: false, service_endpoint: [], delegation: [{ name: 'app-service', service_delegation: [
        { name: 'Microsoft.Web/serverFarms', actions: ['Microsoft.Network/virtualNetworks/subnets/action'] },
      ] }] },
    'azurerm_subnet.endpoints': { name: names.endpointSubnet, resource_group_name: names.resourceGroup, virtual_network_name: names.vnet,
      address_prefixes: ['10.80.21.64/27'], private_endpoint_network_policies: 'Disabled', private_link_service_network_policies_enabled: true,
      default_outbound_access_enabled: false, service_endpoint: [], delegation: [] },
    'azurerm_network_security_group.workshop': { ...shared, name: names.nsg, security_rule: [] },
    'azurerm_subnet_network_security_group_association.app': { subnet_id: ownIds['azurerm_subnet.app'], network_security_group_id: ownIds['azurerm_network_security_group.workshop'] },
    'azurerm_subnet_network_security_group_association.endpoints': { subnet_id: ownIds['azurerm_subnet.endpoints'], network_security_group_id: ownIds['azurerm_network_security_group.workshop'] },
    'azurerm_service_plan.workshop': { ...shared, name: names.servicePlan, os_type: 'Linux', sku_name: 'B1', worker_count: 1 },
    'azurerm_linux_web_app.workshop': { ...shared, name: names.webApp, https_only: true, enabled: true,
      ftp_publish_basic_authentication_enabled: false, webdeploy_publish_basic_authentication_enabled: false, public_network_access_enabled: true,
      service_plan_id: ownIds['azurerm_service_plan.workshop'], virtual_network_subnet_id: ownIds['azurerm_subnet.app'],
      identity: [{ type: 'UserAssigned', identity_ids: [ownerAssignment.app_identity_id] }],
      site_config: [{ minimum_tls_version: '1.2', scm_minimum_tls_version: '1.2', ftps_state: 'Disabled', always_on: true,
        http2_enabled: true, app_command_line: 'npm start', vnet_route_all_enabled: false, remote_debugging_enabled: false,
        ip_restriction_default_action: 'Deny', scm_ip_restriction_default_action: 'Deny', scm_use_main_ip_restriction: true,
        ip_restriction: [{ name: 'approved-workshop-network', action: 'Allow', priority: 100, ip_address: ownerAssignment.allowed_web_cidr,
          description: null, service_tag: null, virtual_network_subnet_id: null, headers: [] }],
        scm_ip_restriction: [], application_stack: [{ node_version: '24-lts' }] }],
      app_settings: { APP_MESSAGE: input.app_message, PAGE_THEME: input.page_theme, WORKSHOP_ITERATION: input.workshop_iteration,
        STORAGE_ACCOUNT_NAME: names.storage, STORAGE_CONTAINER_NAME: names.container, MANAGED_IDENTITY_RESOURCE_ID: ownerAssignment.app_identity_id,
        WEBSITE_RUN_FROM_PACKAGE: '1' } },
    'azurerm_storage_account.workshop': { ...shared, name: names.storage, account_kind: 'StorageV2', account_tier: 'Standard',
      account_replication_type: 'LRS', access_tier: 'Hot', min_tls_version: 'TLS1_2', https_traffic_only_enabled: true,
      shared_access_key_enabled: false, allow_nested_items_to_be_public: false, public_network_access_enabled: false,
      default_to_oauth_authentication: true, cross_tenant_replication_enabled: false, is_hns_enabled: false, sftp_enabled: false, local_user_enabled: false },
    'azurerm_storage_container.workshop': { name: names.container, storage_account_id: ownIds['azurerm_storage_account.workshop'], container_access_type: 'private' },
    'azurerm_private_endpoint.blob': { ...shared, name: names.privateEndpoint, subnet_id: ownIds['azurerm_subnet.endpoints'],
      private_service_connection: [{ name: names.privateEndpoint, private_connection_resource_id: ownIds['azurerm_storage_account.workshop'],
        subresource_names: ['blob'], is_manual_connection: false, private_ip_address: '10.80.21.68' }],
      private_dns_zone_group: [{ name: names.dnsGroup, private_dns_zone_ids: [ownIds['azurerm_private_dns_zone.blob']] }] },
    'azurerm_private_dns_zone.blob': { name: names.dnsZone, resource_group_name: names.resourceGroup, tags },
    'azurerm_private_dns_zone_virtual_network_link.blob': { name: names.dnsLink, tags,
      private_dns_zone_id: ownIds['azurerm_private_dns_zone.blob'], virtual_network_id: ownIds['azurerm_virtual_network.workshop'], registration_enabled: false },
  };
  const nameExpressions = { resource_group: 'resource_group', virtual_network: 'vnet', network_security_group: 'nsg',
    service_plan: 'plan', linux_web_app: 'app', storage_account: 'storage', storage_container: 'container', private_endpoint: 'blob_endpoint',
    private_dns_zone_virtual_network_link: 'dns_link' };
  const resources = RESOURCE_ADDRESSES.map(address => {
    const type = address.split('.')[0];
    const expressions = {};
    const value = values[address];
    if (value.name) {
      const local = type === 'azurerm_subnet' ? (address.endsWith('.app') ? 'app_subnet' : 'pe_subnet') : nameExpressions[type.replace('azurerm_', '')];
      expressions.name = type === 'azurerm_private_dns_zone' ? literal(names.dnsZone) : ref(`local.names.${local}`);
    }
    if (value.resource_group_name) expressions.resource_group_name = ref('azurerm_resource_group.workshop.name');
    if (value.location) expressions.location = ref(type === 'azurerm_resource_group' ? 'var.assignment.location' : 'azurerm_resource_group.workshop.location');
    if (value.tags) expressions.tags = ref('local.tags');
    if (type === 'azurerm_virtual_network') expressions.address_space = ref('local.vnet_cidr');
    if (type === 'azurerm_subnet') {
      expressions.virtual_network_name = ref('azurerm_virtual_network.workshop.name');
      expressions.address_prefixes = ref(address.endsWith('.app') ? 'local.app_cidr' : 'local.pe_cidr');
      expressions.default_outbound_access_enabled = literal(false);
      expressions.private_endpoint_network_policies = literal(address.endsWith('.app') ? 'Enabled' : 'Disabled');
      if (address.endsWith('.app')) expressions.delegation = [{ name: literal('app-service'), service_delegation: [{
        name: literal('Microsoft.Web/serverFarms'), actions: literal(['Microsoft.Network/virtualNetworks/subnets/action']),
      }] }];
    }
    if (type === 'azurerm_subnet_network_security_group_association') {
      expressions.subnet_id = ref(`azurerm_subnet.${address.endsWith('.app') ? 'app' : 'endpoints'}.id`);
      expressions.network_security_group_id = ref('azurerm_network_security_group.workshop.id');
    }
    if (type === 'azurerm_service_plan') for (const field of ['os_type', 'sku_name', 'worker_count']) expressions[field] = literal(value[field]);
    if (type === 'azurerm_linux_web_app') {
      expressions.service_plan_id = ref('azurerm_service_plan.workshop.id');
      expressions.virtual_network_subnet_id = ref('azurerm_subnet.app.id');
      for (const field of ['https_only', 'public_network_access_enabled', 'ftp_publish_basic_authentication_enabled', 'webdeploy_publish_basic_authentication_enabled'])
        expressions[field] = literal(value[field]);
      expressions.identity = [{ type: literal('UserAssigned'), identity_ids: ref('var.assignment.app_identity_id') }];
      const site = value.site_config[0];
      expressions.site_config = [{
        ...Object.fromEntries(['always_on', 'http2_enabled', 'minimum_tls_version', 'scm_minimum_tls_version', 'ftps_state', 'app_command_line',
          'vnet_route_all_enabled', 'remote_debugging_enabled', 'ip_restriction_default_action', 'scm_ip_restriction_default_action',
          'scm_use_main_ip_restriction'].map(field => [field, literal(site[field])])),
        ip_restriction: [{ name: literal('approved-workshop-network'), ip_address: ref('var.assignment.allowed_web_cidr'), action: literal('Allow'), priority: literal(100) }],
        application_stack: [{ node_version: literal('24-lts') }],
      }];
      expressions.app_settings = ref('var.app_message', 'var.page_theme', 'var.workshop_iteration', 'azurerm_storage_account.workshop.name',
        'azurerm_storage_container.workshop.name', 'var.assignment.app_identity_id');
    }
    if (type === 'azurerm_storage_account') {
      for (const field of ['account_kind', 'account_tier', 'account_replication_type', 'access_tier', 'min_tls_version', 'https_traffic_only_enabled',
        'shared_access_key_enabled', 'allow_nested_items_to_be_public', 'public_network_access_enabled', 'default_to_oauth_authentication',
        'cross_tenant_replication_enabled', 'is_hns_enabled', 'sftp_enabled', 'local_user_enabled']) expressions[field] = literal(value[field]);
    }
    if (type === 'azurerm_storage_container') {
      expressions.storage_account_id = ref('azurerm_storage_account.workshop.id');
      expressions.container_access_type = literal('private');
    }
    if (type === 'azurerm_private_endpoint') {
      expressions.subnet_id = ref('azurerm_subnet.endpoints.id');
      expressions.private_service_connection = [{ name: ref('local.names.blob_endpoint'), private_connection_resource_id: ref('azurerm_storage_account.workshop.id'),
        subresource_names: literal(['blob']), is_manual_connection: literal(false) }];
      expressions.private_dns_zone_group = [{ name: ref('local.names.dns_group'), private_dns_zone_ids: ref('azurerm_private_dns_zone.blob.id') }];
    }
    if (type === 'azurerm_private_dns_zone_virtual_network_link') {
      expressions.virtual_network_id = ref('azurerm_virtual_network.workshop.id');
      expressions.private_dns_zone_id = ref('azurerm_private_dns_zone.blob.id');
      expressions.registration_enabled = literal(false);
    }
    return { address, name: address.split('.')[1], mode: 'managed', type, provider_config_key: 'azurerm', expressions };
  });
  const rootVariables = { ...input, assignment: Object.fromEntries(['participant_name', 'subscription_id', 'tenant_id', 'location', 'allowed_web_cidr', 'network_slot',
    'app_identity_id', 'owner', 'cost_center', 'expires_at'].map(key => [key, ownerAssignment[key]])) };
  const plan = { format_version: '1.2', terraform_version: TERRAFORM_VERSION, complete: true, errored: false,
    variables: Object.fromEntries(Object.entries(rootVariables).map(([key, value]) => [key, { value }])),
    resource_changes: RESOURCE_ADDRESSES.map(address => {
      const value = { id: ownIds[address], ...clone(values[address]) };
      return { address, name: address.split('.')[1], type: address.split('.')[0], mode: 'managed', provider_name: PROVIDER,
        change: { actions: [action], before: action === 'create' ? null : clone(value), after: action === 'delete' ? null : clone(value), after_unknown: {} } };
    }),
    planned_values: { root_module: { resources: [] } },
    configuration: { provider_config: { azurerm: { full_name: PROVIDER, version_constraint: '= 5.4.0', expressions: {
      subscription_id: ref('var.assignment.subscription_id'), tenant_id: ref('var.assignment.tenant_id'), use_oidc: literal(true), use_cli: literal(false),
      storage_use_azuread: literal(true), resource_provider_registrations: literal('none'),
      features: [{ resource_group: [{ prevent_deletion_if_contains_resources: literal(true) }] }],
    } } }, root_module: { resources } } };
  return { plan: synchronize(plan), options: { subscriptionId: SUB, participant: input, assignment: ownerAssignment, operation: action === 'delete' ? 'destroy' : 'deploy' } };
}
const change = (plan, address) => plan.resource_changes.find(resource => resource.address === address);
const config = (plan, address) => plan.configuration.root_module.resources.find(resource => resource.address === address);
function markUnknown(plan, address, path) {
  const resource = change(plan, address);
  const parts = path.split('.');
  let value = resource.change.after;
  let unknown = resource.change.after_unknown;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]; value = value[key];
    unknown[key] ??= /^\d+$/.test(parts[index + 1]) ? [] : {};
    unknown = unknown[key];
  }
  value[parts.at(-1)] = null; unknown[parts.at(-1)] = true;
}
function rejectedPlan(mutator, operation, reason = /Plan policy:/) {
  const { plan, options } = planFixture();
  mutator(plan, options);
  synchronize(plan);
  if (operation) options.operation = operation;
  assert.throws(() => summarizePlan(plan, options), reason);
}

test('pinned Terraform and provider versions and two-hour freshness contract', () => {
  assert.equal(TERRAFORM_VERSION, '1.16.1'); assert.equal(PROVIDER_VERSION, '5.4.0');
  assert.equal(MAX_PLAN_AGE_MS, 7_200_000); assert.equal(RESOURCE_ADDRESSES.length, 14);
});

test('envelope roundtrips binary plan and exact noncanonical manifest bytes', () => {
  const manifestBytes = Buffer.from('{ "z": 1, "binding": { "synthetic": true } }\n');
  const envelope = sealPlan(PLAN_BYTES, manifestBytes, keys.publicKey);
  assert.ok(!envelope.includes(Buffer.from('PRIVATE_PLAN_MARKER')));
  const opened = openPlan(envelope, keys.privateKey);
  assert.deepEqual(opened.plan, PLAN_BYTES);
  assert.deepEqual(opened.manifestBytes, manifestBytes);
  assert.deepEqual(opened.manifest, JSON.parse(manifestBytes));
  assert.notDeepEqual(envelope, sealPlan(PLAN_BYTES, manifestBytes, keys.publicKey));
});
test('envelope accepts an object and PEM keys without mutating caller data', () => {
  const manifest = { binding: { run: '1' }, schemaVersion: 1 };
  const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const original = Buffer.from(PLAN_BYTES);
  const opened = openPlan(sealPlan(original, manifest, publicPem), privatePem);
  assert.deepEqual(opened.plan, original); assert.deepEqual(opened.manifest, manifest);
  assert.deepEqual(original, PLAN_BYTES);
});
for (const [label, offset] of [['magic', 0], ['version', 8], ['cipher', 9], ['wrap', 10], ['reserved', 11], ['length', 16],
  ['IV', 28], ['wrapped key', 40], ['GCM tag', 28 + 12 + 384], ['ciphertext', 28 + 12 + 384 + 16]]) {
  test(`envelope rejects tampering with ${label}`, () => {
    const envelope = sealPlan(PLAN_BYTES, { test: true }, keys.publicKey);
    envelope[offset] ^= 1;
    assert.throws(() => openPlan(envelope, keys.privateKey), /Plan envelope:/);
  });
}
test('envelope rejects wrong keys, truncation, extension, weak RSA and wrong key kinds', () => {
  const envelope = sealPlan(PLAN_BYTES, { test: true }, keys.publicKey);
  assert.throws(() => openPlan(envelope, otherKeys.privateKey), /Plan envelope:/);
  assert.throws(() => openPlan(envelope.subarray(0, -1), keys.privateKey), /Plan envelope:/);
  assert.throws(() => openPlan(Buffer.concat([envelope, Buffer.from([0])]), keys.privateKey), /Plan envelope:/);
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => sealPlan(PLAN_BYTES, {}, weak.publicKey), /3072/);
  assert.throws(() => sealPlan(PLAN_BYTES, {}, keys.privateKey), /public key/);
  assert.throws(() => openPlan(envelope, keys.publicKey), /Plan envelope:/);
});
for (const [label, manifest] of [['duplicate', Buffer.from('{"x":1,"x":2}')], ['escaped duplicate', Buffer.from('{"x":1,"\\u0078":2}')],
  ['prototype', Buffer.from('{"__proto__":{}}')], ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])], ['array', []],
  ['excessive size', { text: 'x'.repeat(128 * 1024) }]]) {
  test(`envelope rejects ${label} manifest`, () => assert.throws(() => sealPlan(PLAN_BYTES, manifest, keys.publicKey), /Plan envelope:/));
}
test('envelope rejects empty/non-byte plans, deep/cyclic JSON and accessor objects', () => {
  assert.throws(() => sealPlan(Buffer.alloc(0), {}, keys.publicKey), /Plan envelope:/);
  assert.throws(() => sealPlan('not bytes', {}, keys.publicKey), /Plan envelope:/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => sealPlan(PLAN_BYTES, cycle, keys.publicKey), /Plan envelope:/);
  let deep = {}; for (let index = 0; index < 34; index += 1) deep = { child: deep };
  assert.throws(() => sealPlan(PLAN_BYTES, deep, keys.publicKey), /Plan envelope:/);
  const getter = Object.defineProperty({}, 'sensitive', { enumerable: true, get() { throw new Error('must not evaluate getters'); } });
  assert.throws(() => sealPlan(PLAN_BYTES, getter, keys.publicKey), /unsafe property/);
  const arrayGetter = [];
  Object.defineProperty(arrayGetter, '0', { enumerable: true, get() { throw new Error('must not evaluate array getters'); } });
  assert.throws(() => sealPlan(PLAN_BYTES, { items: arrayGetter }, keys.publicKey), /unsafe array property/);
});

test('strict JSON rejects duplicate escaped keys, unsafe properties and invalid UTF-8', () => {
  assert.throws(() => parseStrictJson(Buffer.from('{"x":1,"\\u0078":2}')), /duplicate/);
  assert.throws(() => parseStrictJson(Buffer.from('{"constructor":1}')), /unsafe/);
  assert.throws(() => parseStrictJson(Buffer.from([0xff])), /UTF-8/);
  assert.equal(canonicalJson({ z: 1, a: ['x'] }), '{"a":["x"],"z":1}');
});

test('complete exact root deployment produces only sanitized addresses/action counts', () => {
  const { plan, options } = planFixture();
  const summary = summarizePlan(plan, options);
  assert.deepEqual(summary.totals, { create: 14, update: 0, delete: 0, replace: 0, noChange: 0 });
  assert.equal(summary.resources.length, 14);
  for (const resource of summary.resources) assert.deepEqual(Object.keys(resource).sort(), ['action', 'address']);
  const output = JSON.stringify(summary);
  assert.ok(!output.includes('Hello from alex') && !output.includes(SUB) && !output.includes('PRIVATE_PLAN_MARKER') && !output.includes('tags'));
  assert.equal(change(plan, 'azurerm_resource_group.workshop').change.after.id, `/subscriptions/${SUB}/resourceGroups/rg-alex-001`);
});
test('DNS links use the AzureRM 5.4 parent-ID schema and retain the exact DNS-zone ARM scope', () => {
  const { plan, options } = planFixture();
  const address = 'azurerm_private_dns_zone_virtual_network_link.blob';
  const values = change(plan, address).change.after;
  const expressions = config(plan, address).expressions;
  assert.equal(values.private_dns_zone_id, ids()['azurerm_private_dns_zone.blob']);
  assert.deepEqual(expressions.private_dns_zone_id, ref('azurerm_private_dns_zone.blob.id'));
  assert.equal(values.id, `${values.private_dns_zone_id}/virtualNetworkLinks/${values.name}`);
  for (const field of ['resource_group_name', 'private_dns_zone_name']) {
    assert.equal(Object.hasOwn(values, field), false);
    assert.equal(Object.hasOwn(expressions, field), false);
  }
  assert.equal(summarizePlan(plan, options).totals.create, 14);
});
for (const [label, foreignId] of [
  ['another zone in the owned group', ids()['azurerm_private_dns_zone.blob'].replace('privatelink.blob.', 'privatelink.file.')],
  ['another resource group', ids()['azurerm_private_dns_zone.blob'].replace('/resourceGroups/rg-alex-001/', '/resourceGroups/rg-foreign/')],
  ['another subscription', ids()['azurerm_private_dns_zone.blob'].replace(SUB, TENANT)],
]) test(`DNS links reject a foreign private_dns_zone_id from ${label}`, () => rejectedPlan(plan => {
  change(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').change.after.private_dns_zone_id = foreignId;
}, undefined, /resource value differs/));
test('DNS-link IDs cannot move out of their exact parent DNS-zone scope', () => rejectedPlan(plan => {
  const values = change(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').change.after;
  values.id = `${ids()['azurerm_virtual_network.workshop']}/virtualNetworkLinks/${values.name}`;
}, undefined, /resource value differs/));
for (const field of ['resource_group_name', 'private_dns_zone_name']) {
  test(`DNS-link configuration rejects removed ${field} even with a valid parent ID`, () => rejectedPlan(plan => {
    config(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').expressions[field] = field === 'resource_group_name'
      ? ref('azurerm_resource_group.workshop.name') : ref('azurerm_private_dns_zone.blob.name');
  }, undefined, /removed DNS-link HCL attributes/));
  test(`DNS-link values reject removed ${field} even with a valid parent ID`, () => rejectedPlan(plan => {
    change(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').change.after[field] = field === 'resource_group_name'
      ? deriveNames(participant()).resourceGroup : deriveNames(participant()).dnsZone;
  }, undefined, /removed DNS-link value attributes/));
}
test('owner web CIDR is bound into Terraform inputs and the sole inherited SCM ingress rule', () => {
  const ownerAssignment = { ...assignment(), allowed_web_cidr: '198.51.100.128/25' };
  const { plan, options } = planFixture({ ownerAssignment });
  assert.equal(summarizePlan(plan, options).totals.create, 14);
  assert.equal(plan.variables.assignment.value.allowed_web_cidr, ownerAssignment.allowed_web_cidr);
  const site = change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0];
  assert.equal(site.ip_restriction.length, 1);
  assert.equal(site.ip_restriction[0].ip_address, ownerAssignment.allowed_web_cidr);
  assert.equal(site.scm_use_main_ip_restriction, true);
  assert.deepEqual(site.scm_ip_restriction, []);
  assert.equal(site.vnet_route_all_enabled, false);
});
test('native SDK ingress attribute references and fully literal nested blocks retain the same exact value contracts', () => {
  const { plan, options } = planFixture();
  const expressions = config(plan, 'azurerm_linux_web_app.workshop').expressions;
  expressions.site_config[0].ip_restriction = ref('var.assignment.allowed_web_cidr');
  expressions.site_config[0].application_stack = literal([{ node_version: '24-lts', java_version: null, python_version: null }]);
  config(plan, 'azurerm_subnet.app').expressions.delegation = literal([
    { name: 'app-service', service_delegation: [{ name: 'Microsoft.Web/serverFarms', actions: ['Microsoft.Network/virtualNetworks/subnets/action'] }] },
  ]);
  assert.equal(summarizePlan(plan, options).totals.create, 14);
});
test('aggregate ingress references cannot conceal public CIDRs or unknown security values', () => {
  rejectedPlan(plan => {
    config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].ip_restriction = ref('var.assignment.allowed_web_cidr');
    change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].ip_address = '0.0.0.0/0';
  }, undefined, /resource value differs/);
  rejectedPlan(plan => {
    config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].ip_restriction = ref('var.assignment.allowed_web_cidr');
    markUnknown(plan, 'azurerm_linux_web_app.workshop', 'site_config.0.ip_restriction.0.ip_address');
  }, undefined, /policy-critical or unrecognized value is unknown/);
});
test('missing owner assignment CIDR is rejected even with a recomputed assignment digest', () => {
  const bound = binding(); delete bound.assignment.allowed_web_cidr;
  bound.assignmentSha256 = hash(canonicalJson(bound.assignment));
  assert.throws(() => validateBinding(bound), /invalid participant or owner assignment/);
  const { plan, options } = planFixture(); delete options.assignment.allowed_web_cidr;
  assert.throws(() => summarizePlan(plan, options), /invalid participant or owner assignment/);
});
test('only explicitly enumerated non-security computed web outputs may be unknown', () => {
  const { plan, options } = planFixture();
  for (const field of ['default_hostname', 'hosting_environment_id', 'identity.0.principal_id', 'identity.0.tenant_id',
    'site_config.0.default_documents', 'site_config.0.linux_fx_version']) markUnknown(plan, 'azurerm_linux_web_app.workshop', field);
  synchronize(plan);
  assert.equal(summarizePlan(plan, options).totals.create, 14);
});
test('absent optional service_endpoint blocks do not require a nonexistent service_endpoints attribute', () => {
  const { plan, options } = planFixture();
  for (const address of ['azurerm_subnet.app', 'azurerm_subnet.endpoints']) {
    const values = change(plan, address).change.after;
    assert.equal(Object.hasOwn(values, 'service_endpoints'), false);
    delete values.service_endpoint;
  }
  synchronize(plan);
  assert.equal(summarizePlan(plan, options).totals.create, 14);
});
test('no-op followup and separately scoped full destroy are admitted', () => {
  const followup = planFixture({ action: 'no-op' }); followup.options.operation = 'followup';
  assert.equal(summarizePlan(followup.plan, followup.options).totals.noChange, 14);
  const cleanup = planFixture({ action: 'delete' });
  assert.equal(summarizePlan(cleanup.plan, cleanup.options).totals.delete, 14);
});
test('a safe message/theme/iteration update does not require renaming resources', () => {
  const input = { ...participant(), app_message: 'Updated by alex', page_theme: 'green', workshop_iteration: '02' };
  const current = planFixture({ action: 'no-op', input });
  const previous = planFixture({ action: 'no-op' });
  for (const resource of current.plan.resource_changes) {
    resource.change.before = clone(change(previous.plan, resource.address).change.before);
    if (canonicalJson(resource.change.before) !== canonicalJson(resource.change.after)) resource.change.actions = ['update'];
  }
  synchronize(current.plan);
  const summary = summarizePlan(current.plan, current.options);
  assert.ok(summary.totals.update > 0 && summary.totals.delete === 0 && summary.totals.create === 0);
});
test('generated create IDs/dependencies are admitted only with exact direct HCL wiring', () => {
  const { plan, options } = planFixture();
  for (const resource of plan.resource_changes) { resource.change.after.id = null; resource.change.after_unknown.id = true; }
  const mark = (address, path) => markUnknown(plan, address, path);
  for (const name of ['app', 'endpoints']) {
    mark(`azurerm_subnet_network_security_group_association.${name}`, 'subnet_id');
    mark(`azurerm_subnet_network_security_group_association.${name}`, 'network_security_group_id');
  }
  mark('azurerm_linux_web_app.workshop', 'service_plan_id'); mark('azurerm_linux_web_app.workshop', 'virtual_network_subnet_id');
  mark('azurerm_storage_container.workshop', 'storage_account_id');
  mark('azurerm_private_endpoint.blob', 'subnet_id');
  mark('azurerm_private_endpoint.blob', 'private_service_connection.0.private_connection_resource_id');
  mark('azurerm_private_endpoint.blob', 'private_service_connection.0.private_ip_address');
  mark('azurerm_private_endpoint.blob', 'private_dns_zone_group.0.private_dns_zone_ids.0');
  mark('azurerm_private_dns_zone_virtual_network_link.blob', 'private_dns_zone_id');
  mark('azurerm_private_dns_zone_virtual_network_link.blob', 'virtual_network_id');
  synchronize(plan);
  // Terraform can omit unknown attributes entirely from planned_values.
  for (const resource of plan.planned_values.root_module.resources) delete resource.values.id;
  assert.equal(summarizePlan(plan, options).totals.create, 14);
  config(plan, 'azurerm_linux_web_app.workshop').expressions.service_plan_id = literal(ids()['azurerm_service_plan.workshop']);
  assert.throws(() => summarizePlan(plan, options), /HCL reference/);
});
for (const [label, existingAddress] of [
  ['an existing parent zone', 'azurerm_private_dns_zone.blob'],
  ['an existing link', 'azurerm_private_dns_zone_virtual_network_link.blob'],
]) test(`unknown DNS parent IDs cannot be admitted for ${label}`, () => rejectedPlan(plan => {
  const existing = change(plan, existingAddress);
  existing.change.before = clone(existing.change.after);
  existing.change.actions = [existingAddress === 'azurerm_private_dns_zone.blob' ? 'no-op' : 'update'];
  markUnknown(plan, 'azurerm_private_dns_zone_virtual_network_link.blob', 'private_dns_zone_id');
}, undefined, /unknown dependency must be an exact newly-created owned resource/));
test('an update cannot adopt a prior foreign DNS parent ID', () => {
  const { plan, options } = planFixture({ action: 'no-op' });
  const resource = change(plan, 'azurerm_private_dns_zone_virtual_network_link.blob');
  resource.change.actions = ['update'];
  resource.change.before.private_dns_zone_id = resource.change.before.private_dns_zone_id.replace('privatelink.blob.', 'privatelink.file.');
  assert.throws(() => summarizePlan(plan, options), /resource value differs/);
});

const planRejections = [
  ['unsupported format', plan => { plan.format_version = '1.99'; }],
  ['wrong Terraform', plan => { plan.terraform_version = '1.15.0'; }],
  ['incomplete plan', plan => { plan.complete = false; }],
  ['deferred changes', plan => { plan.deferred_changes = [{}]; }],
  ['resource drift', plan => { plan.resource_drift = [{}]; }],
  ['failed Terraform checks', plan => { plan.checks = [{ status: 'fail' }]; }],
  ['unknown Terraform checks', plan => { plan.checks = [{ status: 'unknown' }]; }],
  ['foreign provider assignment variable', plan => { plan.variables.assignment.value.subscription_id = TENANT; }],
  ['provider tenant variable mismatch', plan => { plan.variables.assignment.value.tenant_id = SUB; }],
  ['missing Terraform assignment CIDR', plan => { delete plan.variables.assignment.value.allowed_web_cidr; }],
  ['different Terraform assignment CIDR', plan => { plan.variables.assignment.value.allowed_web_cidr = '198.51.100.0/24'; }],
  ['unrestricted owner assignment CIDR', (plan, options) => { options.assignment.allowed_web_cidr = '0.0.0.0/0'; }],
  ['unknown Terraform input', plan => { plan.variables.sku = { value: 'P1v3' }; }],
  ['provider credential override', plan => { plan.configuration.provider_config.azurerm.expressions.client_id = literal(APPLY_CLIENT); }],
  ['provider alias', plan => { plan.configuration.provider_config.other = clone(plan.configuration.provider_config.azurerm); }],
  ['wrong provider version', plan => { plan.configuration.provider_config.azurerm.version_constraint = '= 4.81.0'; }],
  ['CLI authentication', plan => { plan.configuration.provider_config.azurerm.expressions.use_cli = literal(true); }],
  ['data mode', plan => { plan.resource_changes[0].mode = 'data'; }],
  ['role assignment', plan => { plan.resource_changes[0].type = 'azurerm_role_assignment'; }],
  ['foreign resource address', plan => { plan.resource_changes[0].address = 'azurerm_resource_group.other'; }],
  ['indexed resource address', plan => { plan.resource_changes[0].address += '[0]'; }],
  ['duplicate address', plan => { plan.resource_changes[1] = clone(plan.resource_changes[0]); }],
  ['missing resource', plan => { plan.resource_changes.pop(); }],
  ['child module', plan => { plan.configuration.root_module.module_calls = { other: {} }; }],
  ['provisioner', plan => { plan.configuration.root_module.resources[0].provisioners = [{ type: 'local-exec' }]; }],
  ['for_each', plan => { plan.configuration.root_module.resources[0].for_each_expression = literal({ a: true }); }],
  ['import', plan => { plan.resource_changes[0].change.importing = { id: ids()['azurerm_resource_group.workshop'] }; }],
  ['moved resource', plan => { plan.resource_changes[0].previous_address = 'azurerm_resource_group.old'; }],
  ['foreign scope', plan => { plan.resource_changes[0].change.after.id = `/subscriptions/${TENANT}/resourceGroups/rg-alex-001`; }],
  ['RG providers suffix', plan => { plan.resource_changes[0].change.after.id += '/providers/Microsoft.Resources/resourceGroups/rg-alex-001'; }],
  ['wrong RG name', plan => { plan.resource_changes[0].change.after.name = 'rg-other-001'; }],
  ['wrong location', plan => { plan.resource_changes[0].change.after.location = 'westus'; }],
  ['unknown name', plan => { plan.resource_changes[0].change.after.name = null; plan.resource_changes[0].change.after_unknown.name = true; }],
  ['unknown RG binding', plan => { const resource = change(plan, 'azurerm_virtual_network.workshop'); resource.change.after.resource_group_name = null; resource.change.after_unknown.resource_group_name = true; }],
  ['unknown security field', plan => { const resource = change(plan, 'azurerm_storage_account.workshop'); resource.change.after.public_network_access_enabled = null; resource.change.after_unknown.public_network_access_enabled = true; }],
  ['unknown entire identity block', plan => { const resource = change(plan, 'azurerm_linux_web_app.workshop'); resource.change.after.identity = null; resource.change.after_unknown.identity = true; }],
  ['unknown action', plan => { plan.resource_changes[0].change.actions = ['forget']; }],
  ['replacement', plan => { plan.resource_changes[0].change.actions = ['delete', 'create']; }],
  ['ordinary deletion', plan => { plan.resource_changes[0].change.actions = ['delete']; plan.resource_changes[0].change.before = clone(plan.resource_changes[0].change.after); plan.resource_changes[0].change.after = null; }],
  ['unsafe tags', plan => { plan.resource_changes[0].change.after.tags.owner = 'other-owner'; }],
  ['cross-scope service plan', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.service_plan_id = ids()['azurerm_service_plan.workshop'].replace('rg-alex-001', 'rg-other'); }],
  ['wrong app subnet', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.virtual_network_subnet_id = ids()['azurerm_subnet.endpoints']; }],
  ['foreign bootstrap identity', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.identity[0].identity_ids = [assignment().app_identity_id.replace('id-test-only', 'id-other')]; }],
  ['system-assigned identity', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.identity[0].type = 'SystemAssigned, UserAssigned'; }],
  ['wrong DNS', plan => { change(plan, 'azurerm_private_dns_zone.blob').change.after.name = 'privatelink.file.core.windows.net'; }],
  ['missing DNS parent ID', plan => { delete change(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').change.after.private_dns_zone_id; }],
  ['DNS registration', plan => { change(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').change.after.registration_enabled = true; }],
  ['manual PE', plan => { change(plan, 'azurerm_private_endpoint.blob').change.after.private_service_connection[0].is_manual_connection = true; }],
  ['wrong PE subresource', plan => { change(plan, 'azurerm_private_endpoint.blob').change.after.private_service_connection[0].subresource_names = ['file']; }],
  ['wrong PE subnet', plan => { change(plan, 'azurerm_private_endpoint.blob').change.after.subnet_id = ids()['azurerm_subnet.app']; }],
  ['wrong DNS link target', plan => { change(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').change.after.virtual_network_id += '-foreign'; }],
  ['cross-scope hidden nested ID', plan => { change(plan, 'azurerm_storage_account.workshop').change.after.extra = { scope: `/subscriptions/${TENANT}/resourceGroups/foreign` }; }],
  ['unreviewed NSG rules', plan => { change(plan, 'azurerm_network_security_group.workshop').change.after.security_rule = [{ name: 'allow-all' }]; }],
  ['subnet service endpoint block', plan => { change(plan, 'azurerm_subnet.app').change.after.service_endpoint = [{ service: 'Microsoft.Storage', locations: ['*'] }]; }],
  ['public container', plan => { change(plan, 'azurerm_storage_container.workshop').change.after.container_access_type = 'blob'; }],
  ['wrong app package URL', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.app_settings.WEBSITE_RUN_FROM_PACKAGE = 'https://unreviewed.invalid/app.zip'; }],
  ['missing Node stack', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].application_stack = []; }],
  ['old TLS on SCM', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].scm_minimum_tls_version = '1.0'; }],
  ['FTP enabled', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ftps_state = 'AllAllowed'; }],
  ['route-all enabled', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].vnet_route_all_enabled = true; }],
  ['HTTP2 disabled', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].http2_enabled = false; }],
  ['always-on disabled', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].always_on = false; }],
  ['remote debugging enabled', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].remote_debugging_enabled = true; }],
  ['different startup command', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].app_command_line = 'node unreviewed'; }],
  ['different Node version', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].application_stack[0].node_version = '22-lts'; }],
  ['public web CIDR', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].ip_address = '0.0.0.0/0'; }],
  ['unassigned web CIDR', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].ip_address = '198.51.100.0/24'; }],
  ['web default allow', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction_default_action = 'Allow'; }],
  ['missing web allow rule', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction = []; }],
  ['extra web allow rule', plan => { const site = change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0]; site.ip_restriction.push(clone(site.ip_restriction[0])); }],
  ['different ingress priority', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].priority = 101; }],
  ['different ingress name', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].name = 'unreviewed-network'; }],
  ['deny instead of allow rule', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].action = 'Deny'; }],
  ['ingress service tag', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].service_tag = 'Internet'; }],
  ['ingress header selector', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction[0].headers = [{ x_forwarded_for: ['203.0.113.1'] }]; }],
  ['SCM default allow', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].scm_ip_restriction_default_action = 'Allow'; }],
  ['SCM main restriction bypass', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].scm_use_main_ip_restriction = false; }],
  ['separate SCM ingress rule', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].scm_ip_restriction = [{ name: 'public-scm', action: 'Allow', priority: 100, ip_address: '0.0.0.0/0' }]; }],
  ['ambiguous HCL expression', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.service_plan_id.constant_value = 'foreign'; }],
  ['unknown app setting', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.app_settings.AZURE_CLIENT_SECRET = 'synthetic-not-a-secret'; }],
  ['participant name app setting', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.app_settings.PARTICIPANT_NAME = 'alex'; }],
  ['optional build app setting', plan => { change(plan, 'azurerm_linux_web_app.workshop').change.after.app_settings.ENABLE_ORYX_BUILD = 'false'; }],
  ['missing package app setting', plan => { delete change(plan, 'azurerm_linux_web_app.workshop').change.after.app_settings.WEBSITE_RUN_FROM_PACKAGE; }],
];
for (const [label, mutate] of planRejections) test(`plan policy rejects ${label}`, () => rejectedPlan(mutate));
for (const [type, field, value] of [
  ['azurerm_service_plan', 'sku_name', 'F1'], ['azurerm_service_plan', 'sku_name', 'P1v3'], ['azurerm_service_plan', 'os_type', 'Windows'],
  ['azurerm_service_plan', 'worker_count', 2], ['azurerm_linux_web_app', 'https_only', false],
  ['azurerm_linux_web_app', 'ftp_publish_basic_authentication_enabled', true], ['azurerm_linux_web_app', 'webdeploy_publish_basic_authentication_enabled', true],
  ['azurerm_storage_account', 'account_kind', 'BlobStorage'], ['azurerm_storage_account', 'account_tier', 'Premium'],
  ['azurerm_storage_account', 'account_replication_type', 'GRS'], ['azurerm_storage_account', 'access_tier', 'Cool'],
  ['azurerm_storage_account', 'min_tls_version', 'TLS1_0'], ['azurerm_storage_account', 'https_traffic_only_enabled', false],
  ['azurerm_storage_account', 'shared_access_key_enabled', true], ['azurerm_storage_account', 'allow_nested_items_to_be_public', true],
  ['azurerm_storage_account', 'public_network_access_enabled', true], ['azurerm_storage_account', 'default_to_oauth_authentication', false],
  ['azurerm_storage_account', 'cross_tenant_replication_enabled', true], ['azurerm_storage_account', 'is_hns_enabled', true],
  ['azurerm_storage_account', 'sftp_enabled', true], ['azurerm_storage_account', 'local_user_enabled', true],
]) test(`fixed cost/security profile rejects ${type}.${field}=${value}`, () => rejectedPlan(plan => { change(plan, `${type}.workshop`).change.after[field] = value; }));
for (const address of ['azurerm_subnet.app', 'azurerm_subnet.endpoints']) {
  test(`subnet profile rejects default outbound access on ${address}`, () => rejectedPlan(plan => {
    change(plan, address).change.after.default_outbound_access_enabled = true;
  }));
  test(`subnet profile rejects private endpoint policy drift on ${address}`, () => rejectedPlan(plan => {
    change(plan, address).change.after.private_endpoint_network_policies = address.endsWith('.app') ? 'Disabled' : 'Enabled';
  }));
}
for (const field of ['cross_tenant_replication_enabled', 'is_hns_enabled', 'sftp_enabled', 'local_user_enabled']) {
  test(`storage profile requires explicit known false ${field}`, () => rejectedPlan(plan => {
    delete change(plan, 'azurerm_storage_account.workshop').change.after[field];
  }));
}

const configurationRejections = [
  ['literal CIDR instead of the owner reference', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].ip_restriction[0].ip_address = literal(assignment().allowed_web_cidr); }],
  ['indirect CIDR reference', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].ip_restriction[0].ip_address = ref('local.web_cidr'); }],
  ['extra CIDR reference', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].ip_restriction[0].ip_address = ref('var.assignment.allowed_web_cidr', 'var.app_message'); }],
  ['route-all literal drift', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].vnet_route_all_enabled = literal(true); }],
  ['missing route-all literal', plan => { delete config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].vnet_route_all_enabled; }],
  ['SCM default literal drift', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].scm_ip_restriction_default_action = literal('Allow'); }],
  ['SCM inheritance literal drift', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].scm_use_main_ip_restriction = literal(false); }],
  ['extra SCM block', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].scm_ip_restriction = [{ ip_address: literal('0.0.0.0/0') }]; }],
  ['flattened site block references', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config = ref('var.assignment.allowed_web_cidr'); }],
  ['literal ingress without a direct owner reference', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].ip_restriction = literal(change(plan, 'azurerm_linux_web_app.workshop').change.after.site_config[0].ip_restriction); }],
  ['unrelated aggregate ingress reference', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].ip_restriction = ref('var.assignment.app_identity_id'); }],
  ['wrong literal stack version', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].application_stack = literal([{ node_version: '22-lts' }]); }],
  ['extra literal stack runtime', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.site_config[0].application_stack = literal([{ node_version: '24-lts', java_version: '17' }]); }],
  ['literal identity instead of the owner reference', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.identity[0].identity_ids = literal([assignment().app_identity_id]); }],
  ['literal app settings instead of direct references', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.app_settings = literal(change(plan, 'azurerm_linux_web_app.workshop').change.after.app_settings); }],
  ['participant name in app settings references', plan => { config(plan, 'azurerm_linux_web_app.workshop').expressions.app_settings.references.push('var.participant_name'); }],
  ['subnet outbound literal drift', plan => { config(plan, 'azurerm_subnet.app').expressions.default_outbound_access_enabled = literal(true); }],
  ['configured service endpoint block', plan => { config(plan, 'azurerm_subnet.app').expressions.service_endpoint = [{ service: literal('Microsoft.Storage') }]; }],
  ['storage cross-tenant literal drift', plan => { config(plan, 'azurerm_storage_account.workshop').expressions.cross_tenant_replication_enabled = literal(true); }],
  ['storage local-user literal drift', plan => { config(plan, 'azurerm_storage_account.workshop').expressions.local_user_enabled = literal(true); }],
  ['missing DNS parent ID reference', plan => { delete config(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').expressions.private_dns_zone_id; }],
  ['literal DNS parent ID', plan => { config(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').expressions.private_dns_zone_id = literal(ids()['azurerm_private_dns_zone.blob']); }],
  ['indirect DNS parent ID reference', plan => { config(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').expressions.private_dns_zone_id = ref('local.dns_zone_id'); }],
  ['DNS zone name instead of its ID reference', plan => { config(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').expressions.private_dns_zone_id = ref('azurerm_private_dns_zone.blob.name'); }],
  ['foreign DNS parent ID reference', plan => { config(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').expressions.private_dns_zone_id = ref('azurerm_private_dns_zone.other.id'); }],
  ['extra DNS parent ID reference', plan => { config(plan, 'azurerm_private_dns_zone_virtual_network_link.blob').expressions.private_dns_zone_id = ref('azurerm_private_dns_zone.blob.id', 'azurerm_private_dns_zone.other.id'); }],
  ['literal private connection name', plan => { config(plan, 'azurerm_private_endpoint.blob').expressions.private_service_connection[0].name = literal(deriveNames(participant()).privateEndpoint); }],
  ['wrong private connection name reference', plan => { config(plan, 'azurerm_private_endpoint.blob').expressions.private_service_connection[0].name = ref('local.names.dns_group'); }],
  ['literal private connection resource ID', plan => { config(plan, 'azurerm_private_endpoint.blob').expressions.private_service_connection[0].private_connection_resource_id = literal(ids()['azurerm_storage_account.workshop']); }],
  ['flattened private connection references', plan => { config(plan, 'azurerm_private_endpoint.blob').expressions.private_service_connection = ref('local.names.blob_endpoint', 'azurerm_storage_account.workshop.id'); }],
  ['wrong private DNS group name reference', plan => { config(plan, 'azurerm_private_endpoint.blob').expressions.private_dns_zone_group[0].name = ref('local.names.blob_endpoint'); }],
];
for (const [label, mutate] of configurationRejections)
  test(`direct HCL configuration rejects ${label} even when planned values match`, () => rejectedPlan(mutate, undefined, /HCL|literal/));

for (const [address, field] of [
  ...['site_config', 'site_config.0.ip_restriction', 'site_config.0.ip_restriction.0.ip_address', 'site_config.0.ip_restriction.0.priority',
    'site_config.0.ip_restriction_default_action', 'site_config.0.scm_ip_restriction_default_action', 'site_config.0.scm_use_main_ip_restriction',
    'site_config.0.scm_ip_restriction', 'site_config.0.vnet_route_all_enabled', 'site_config.0.http2_enabled', 'site_config.0.app_command_line',
    'site_config.0.minimum_tls_version', 'site_config.0.scm_minimum_tls_version', 'site_config.0.application_stack.0.node_version',
    'app_settings', 'app_settings.WEBSITE_RUN_FROM_PACKAGE'].map(field => ['azurerm_linux_web_app.workshop', field]),
  ...['cross_tenant_replication_enabled', 'is_hns_enabled', 'sftp_enabled', 'local_user_enabled'].map(field => ['azurerm_storage_account.workshop', field]),
  ...['azurerm_subnet.app', 'azurerm_subnet.endpoints'].flatMap(address => ['default_outbound_access_enabled', 'private_endpoint_network_policies',
    'service_endpoint'].map(field => [address, field])),
  ...['name', 'tags', 'registration_enabled', 'resolution_policy', 'resource_group_name', 'private_dns_zone_name']
    .map(field => ['azurerm_private_dns_zone_virtual_network_link.blob', field]),
  ['azurerm_network_security_group.workshop', 'security_rule'], ['azurerm_virtual_network.workshop', 'subnet'],
]) test(`security-critical unknown ${address}.${field} is never treated as a computed output`, () => rejectedPlan(plan => {
  markUnknown(plan, address, field);
}, undefined, /policy-critical or unrecognized value is unknown/));

for (const [field, value] of [['ip_restriction_default_action', 'Allow'], ['scm_ip_restriction_default_action', 'Allow'],
  ['scm_use_main_ip_restriction', false], ['vnet_route_all_enabled', true]]) {
  test(`unsafe prior web ${field} cannot be adopted during an update`, () => {
    const { plan, options } = planFixture({ action: 'no-op' });
    const resource = change(plan, 'azurerm_linux_web_app.workshop');
    resource.change.actions = ['update']; resource.change.before.site_config[0][field] = value;
    assert.throws(() => summarizePlan(plan, options), /resource value differs/);
  });
}
test('unsafe prior public web CIDR cannot be adopted during an update', () => {
  const { plan, options } = planFixture({ action: 'no-op' });
  const resource = change(plan, 'azurerm_linux_web_app.workshop');
  resource.change.actions = ['update']; resource.change.before.site_config[0].ip_restriction[0].ip_address = '0.0.0.0/0';
  assert.throws(() => summarizePlan(plan, options), /resource value differs/);
});
test('followup cannot create and cleanup cannot update/create', () => {
  const fixture = planFixture(); fixture.options.operation = 'followup';
  assert.throws(() => summarizePlan(fixture.plan, fixture.options), /followup/);
  fixture.options.operation = 'destroy';
  assert.throws(() => summarizePlan(fixture.plan, fixture.options), /cleanup/);
});
test('before-values cannot hide an adopted foreign resource', () => {
  const fixture = planFixture({ action: 'no-op' });
  const resource = change(fixture.plan, 'azurerm_storage_account.workshop');
  resource.change.actions = ['update']; resource.change.before.id = resource.change.before.id.replace('rg-alex-001', 'rg-unrelated');
  assert.throws(() => summarizePlan(fixture.plan, fixture.options), /Plan policy:/);
});
test('planned-values inventory must exactly agree with reviewed changes', () => {
  const { plan, options } = planFixture(); plan.planned_values.root_module.resources[0].values.name = 'rg-other';
  assert.throws(() => summarizePlan(plan, options), /planned values/);
});

function proof({ operation = 'deploy', now = NOW } = {}) {
  const bound = binding({ operation, now });
  const manifest = makeManifest(bound, PLAN_BYTES, { now, exitCode: 2 });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { binding: bound, manifest, manifestBytes, planBytes: Buffer.from(PLAN_BYTES), expectedPlanHash: hash(PLAN_BYTES),
    expectedManifestHash: hash(manifestBytes), currentSha: SHA, now };
}
function reencode(value) {
  value.manifestBytes = Buffer.from(JSON.stringify(value.manifest)); value.expectedManifestHash = hash(value.manifestBytes);
}
test('exact manifest verifies both digests, complete binding and owner live window', () => {
  const value = proof(); assert.equal(verifyPlan(value), true);
  value.now += MAX_PLAN_AGE_MS; assert.equal(verifyPlan(value), true);
  const cleanup = proof({ operation: 'destroy' }); assert.equal(verifyPlan(cleanup), true);
});
for (const [label, mutate] of [
  ['plan tamper', value => { value.planBytes[0] ^= 1; }],
  ['manifest bytes tamper', value => { value.manifestBytes = Buffer.concat([value.manifestBytes, Buffer.from(' ')]); }],
  ['untrusted plan hash', value => { value.expectedPlanHash = '0'.repeat(64); }],
  ['untrusted manifest hash', value => { value.expectedManifestHash = '0'.repeat(64); }],
  ['manifest object/byte mismatch', value => { value.manifest.exitCode = 0; }],
  ['current main moved', value => { value.currentSha = OTHER_SHA; }],
  ['stale manifest', value => { value.now += MAX_PLAN_AGE_MS + 1; }],
  ['future manifest', value => { value.now -= 1; }],
  ['failed Terraform exit', value => { value.manifest.exitCode = 1; reencode(value); }],
  ['unknown schema', value => { value.manifest.schemaVersion = 2; reencode(value); }],
  ['unknown manifest field', value => { value.manifest.additional = true; reencode(value); }],
  ['altered expiry', value => { value.manifest.expiresAt = new Date(NOW + 1000).toISOString(); reencode(value); }],
  ['missing expected digest', value => { delete value.expectedManifestHash; }],
]) test(`manifest rejects ${label}`, () => { const value = proof(); mutate(value); assert.throws(() => verifyPlan(value), /Plan policy:/); });
for (const field of ['repository', 'repositoryId', 'workflowRef', 'runId', 'runAttempt', 'sha', 'root', 'operation', 'subscriptionId',
  'tenant', 'planClientId', 'applyClientId', 'providerLockSha256', 'appSha256', 'infraSha256', 'workflowSha256', 'ownerProfileSha256']) {
  test(`manifest binds ${field}`, () => {
    const value = proof();
    value.manifest.binding[field] = ['providerLockSha256', 'appSha256', 'infraSha256', 'workflowSha256', 'ownerProfileSha256'].includes(field) ? 'f'.repeat(64) : `${value.manifest.binding[field]}x`;
    reencode(value); assert.throws(() => verifyPlan(value), /Plan policy:/);
  });
}
for (const field of ['resourceGroupName', 'storageAccountName', 'containerName', 'key', 'stateLockId', 'subscriptionId']) {
  test(`manifest binds backend.${field}`, () => {
    const value = proof(); value.manifest.binding.backend[field] += 'x'; reencode(value);
    assert.throws(() => verifyPlan(value), /Plan policy:/);
  });
}
test('manifest binds full participant/assignment objects, not just digest-shaped strings', () => {
  for (const target of ['participant', 'assignment']) {
    const value = proof();
    if (target === 'participant') value.manifest.binding.participant.app_message = 'Changed input';
    else value.manifest.binding.assignment.location = 'westus';
    value.manifest.binding[`${target}Sha256`] = hash(canonicalJson(value.manifest.binding[target]));
    reencode(value); assert.throws(() => verifyPlan(value), /binding changed/);
  }
});
test('manifest binds the owner web CIDR even when the changed assignment digest is recomputed', () => {
  const value = proof();
  value.manifest.binding.assignment.allowed_web_cidr = '198.51.100.0/24';
  value.manifest.binding.assignmentSha256 = hash(canonicalJson(value.manifest.binding.assignment));
  reencode(value);
  assert.throws(() => verifyPlan(value), /binding changed/);
});
test('manifest rejects a missing owner web CIDR even with fresh artifact and assignment digests', () => {
  const value = proof(); delete value.manifest.binding.assignment.allowed_web_cidr;
  value.manifest.binding.assignmentSha256 = hash(canonicalJson(value.manifest.binding.assignment));
  reencode(value);
  assert.throws(() => verifyPlan(value), /invalid participant or owner assignment/);
});
test('manifest rejects offline assignment, read-only apply, duplicate keys and workload-owned backend', () => {
  const value = proof(); value.binding.assignment.mode = 'offline';
  value.binding.assignmentSha256 = hash(canonicalJson(value.binding.assignment));
  value.manifest = makeManifest(value.binding, value.planBytes, { now: NOW }); reencode(value);
  assert.throws(() => verifyPlan(value), /live owner assignment/);
  assert.throws(() => verifyPlan(proof({ operation: 'followup' })), /read-only/);
  const duplicate = proof(); duplicate.manifestBytes = Buffer.from('{"schemaVersion":1,"schemaVersion":1}');
  duplicate.expectedManifestHash = hash(duplicate.manifestBytes);
  assert.throws(() => verifyPlan(duplicate), /duplicate/);
  const bound = binding(); bound.backend.resourceGroupName = 'rg-alex-001';
  assert.throws(() => validateBinding(bound), /outside the workload/);
});

function rules(requiredChecks) {
  return [
    { type: 'deletion' }, { type: 'non_fast_forward' },
    { type: 'pull_request', parameters: { required_approving_review_count: 0, require_code_owner_review: false, require_last_push_approval: false,
      dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true } },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true,
      required_status_checks: requiredChecks.map(context => ({ context, integration_id: 15368 })) } },
  ];
}
function repository(route = route07) {
  return { id: route.id, full_name: route.repository, name: route.repository.split('/')[1], owner: { login: 'alvine-aurelio-org' },
    private: true, visibility: 'private', is_template: false, fork: false, archived: false, disabled: false };
}

function admissionFixture({ phase = 'preflight', operation = 'deploy', route = route07 } = {}) {
  const now = Date.now();
  const bound = binding({ now, operation, route });
  const profile = { schemaVersion: 1, profile: PROFILE, repository: route.repository, repositoryId: String(route.id), root: 'infra', subscriptionId: SUB,
    tenant: TENANT, planClientId: PLAN_CLIENT, applyClientId: APPLY_CLIENT, backend: backend(), assignment: bound.assignment,
    terraformVersion: TERRAFORM_VERSION, providerVersion: PROVIDER_VERSION, assignmentSha256: bound.assignmentSha256,
    providerLockSha256: bound.providerLockSha256, appSha256: bound.appSha256, infraSha256: bound.infraSha256,
    deliveryWorkflowSha256: digest('synthetic delivery YAML'), cleanupWorkflowSha256: digest('synthetic cleanup YAML'),
    owner: { id: '9001', login: 'test-owner' }, budget: { currency: 'USD', limitMinorUnits: 1200, maxLifetimeHours: 6 },
    approvedAt: new Date(now - 60_000).toISOString(), expiresAt: bound.assignment.expires_at,
    ruleset: { id: route.rulesetId, updatedAt: new Date(now - 180_000).toISOString(), bypassActors: [], verifiedAt: new Date(now - 120_000).toISOString() },
    environments: { plan: 'workshop-plan', apply: 'workshop-apply' }, oidcSubjects: clone(OIDC_SUBJECTS[route.id]), requiredChecks: ['Credential-free workshop checks'] };
  const actor = operation === 'destroy' ? { type: 'User', id: 9001, login: 'test-owner' } : { type: 'User', id: 101, login: 'test-learner' };
  const context = { repo: { owner: 'alvine-aurelio-org', repo: route.repository.split('/')[1] }, runId: 910001, sha: SHA,
    actor: actor.login, ref: 'refs/heads/main', eventName: operation === 'deploy' ? 'push' : 'workflow_dispatch',
    payload: { repository: repository(route), sender: clone(actor) } };
  if (operation === 'deploy') Object.assign(context.payload, { ref: 'refs/heads/main', after: SHA, deleted: false, forced: false });
  else context.payload.inputs = operation === 'destroy' ? { operation: 'destroy', authorization: `destroy:${route.id}:${SHA}:${bound.backend.stateLockId}` } : { operation: 'followup' };
  const env = { WORKSHOP_AZURE_ENABLED: 'true', WORKSHOP_RG_CREATION_APPROVED: 'true',
    WORKSHOP_OWNER_PROFILE_JSON: canonicalJson(profile), WORKSHOP_OWNER_PROFILE_SHA256: hash(canonicalJson(profile)),
    WORKSHOP_BUDGET_CURRENCY: 'USD', WORKSHOP_BUDGET_LIMIT_MINOR: '1200', WORKSHOP_EXPIRES_AT: profile.expiresAt,
    WORKSHOP_PARTICIPANT_JSON: canonicalJson(bound.participant), WORKSHOP_PARTICIPANT_SHA256: bound.participantSha256,
    WORKSHOP_ASSIGNMENT_SHA256: bound.assignmentSha256, WORKSHOP_PROVIDER_LOCK_SHA256: bound.providerLockSha256,
    WORKSHOP_APP_SHA256: bound.appSha256, WORKSHOP_INFRA_SHA256: bound.infraSha256,
    WORKSHOP_WORKFLOW_SHA256: operation === 'destroy' ? profile.cleanupWorkflowSha256 : profile.deliveryWorkflowSha256,
    ARM_SUBSCRIPTION_ID: SUB, ARM_TENANT_ID: TENANT, PLAN_CLIENT_ID: PLAN_CLIENT, APPLY_CLIENT_ID: APPLY_CLIENT,
    ARM_CLIENT_ID: phase === 'apply' ? APPLY_CLIENT : PLAN_CLIENT,
    STATE_RESOURCE_GROUP: bound.backend.resourceGroupName, STATE_STORAGE_ACCOUNT: bound.backend.storageAccountName, STATE_CONTAINER: bound.backend.containerName,
    STATE_KEY: bound.backend.key, WS2_STATE_LOCK_ID: bound.backend.stateLockId, WORKSHOP_CONCURRENCY_GROUP: `ws2-state-${bound.backend.stateLockId}`,
    WORKSHOP_CANCEL_IN_PROGRESS: 'false', GITHUB_REPOSITORY: route.repository, GITHUB_REPOSITORY_ID: String(route.id),
    GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: SHA, GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_RUN_ID: String(context.runId), GITHUB_EVENT_NAME: context.eventName, GITHUB_WORKFLOW_REF: bound.workflowRef,
    GITHUB_ACTOR_ID: String(actor.id), GITHUB_ACTOR: actor.login, GITHUB_TRIGGERING_ACTOR: actor.login };
  const completedJob = name => ({ name, run_id: context.runId, run_attempt: 1, head_sha: SHA, status: 'completed', conclusion: 'success',
    completed_at: new Date(now - 1000).toISOString() });
  const jobs = [completedJob(authorization.JOBS.preflight), completedJob(authorization.JOBS.validation)];
  if (phase === 'apply') jobs.push(completedJob(authorization.JOBS.plan));
  jobs.push({ name: phase === 'apply' ? authorization.JOBS.apply : authorization.JOBS.plan, run_id: context.runId, run_attempt: 1,
    head_sha: SHA, status: 'in_progress', conclusion: null });
  const pr = { number: 12, state: 'closed', merged: true, merged_at: new Date(now - 10_000).toISOString(), merge_commit_sha: SHA,
    base: { ref: 'main', repo: { id: route.id } }, head: { repo: { id: route.id } } };
  const model = { repository: repository(route), branch: { name: 'main', protected: true, commit: { sha: SHA } },
    run: { id: context.runId, run_attempt: 1, head_sha: SHA, head_branch: 'main', event: context.eventName, status: 'in_progress', conclusion: null,
      repository: { id: route.id, full_name: route.repository }, head_repository: { id: route.id, full_name: route.repository },
      path: `.github/workflows/${operation === 'destroy' ? 'cleanup.yml' : 'delivery.yml'}`, actor: clone(actor), triggering_actor: clone(actor) },
    ruleset: { id: route.rulesetId, updated_at: profile.ruleset.updatedAt, enforcement: 'active', target: 'branch', source_type: 'Repository',
      source: route.repository, bypass_actors: [], conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } }, rules: rules(profile.requiredChecks) },
    effectiveRules: rules(profile.requiredChecks).map(rule => ({ ...rule, ruleset_id: route.rulesetId })),
    checkRuns: [{ name: profile.requiredChecks[0], app: { id: 15368 }, head_sha: SHA, status: 'completed', conclusion: 'success' }],
    prs: [pr], pr, jobs, environments: {}, branches: [{ name: 'main', type: 'branch' }],
    ownerPermission: { permission: 'admin', user: { id: 9001, login: 'test-owner', type: 'User' } },
    actorPermission: { permission: 'admin', user: clone(actor) }, reads: { repository: 0, branch: 0, run: 0, jobs: 0 } };
  for (const name of Object.values(profile.environments)) model.environments[name] = { name, can_admins_bypass: false,
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, protection_rules: [{ type: 'branch_policy' }] };
  const calls = [];
  const response = value => ({ data: clone(value) });
  const rest = {
    repos: {
      get: async () => { calls.push('GET repository'); model.reads.repository += 1; return response(model.repository); },
      getBranch: async () => { calls.push('GET main'); model.reads.branch += 1; return response(model.branchRead ? model.branchRead(model.reads.branch) : model.branch); },
      getEnvironment: async args => { calls.push('GET environment'); return response(model.environments[args.environment_name]); },
      getCollaboratorPermissionLevel: async args => { calls.push('GET permission'); return response(args.username === profile.owner.login ? model.ownerPermission : model.actorPermission); },
      listPullRequestsAssociatedWithCommit: function prsEndpoint() {},
      listDeploymentBranchPolicies: function branchesEndpoint() {},
    },
    checks: { listForRef: function checksEndpoint() {} },
    pulls: { get: async () => { calls.push('GET merged PR'); return response(model.pr); } },
    actions: { getWorkflowRun: async () => { calls.push('GET run'); model.reads.run += 1; return response(model.runRead ? model.runRead(model.reads.run) : model.run); } },
  };
  const github = { rest,
    request: async endpoint => { assert.equal(endpoint, 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}'); calls.push(endpoint); return response(model.ruleset); },
    paginate: async (endpoint, args) => {
      if (endpoint === rest.repos.listPullRequestsAssociatedWithCommit) { calls.push('GET associated PRs'); return clone(model.prs); }
      if (endpoint === rest.repos.listDeploymentBranchPolicies) { calls.push('GET environment branches'); return clone(model.branches); }
      if (endpoint === rest.checks.listForRef) { calls.push('GET check runs'); assert.equal(args.ref, SHA); return clone(model.checkRuns); }
      if (endpoint === 'GET /repos/{owner}/{repo}/rules/branches/{branch}') { calls.push(endpoint); return clone(model.effectiveRules); }
      assert.equal(endpoint, JOBS_ROUTE);
      assert.deepEqual(args, { ...context.repo, run_id: context.runId, attempt_number: 1, per_page: 100 });
      assert.ok(model.reads.run > 0, 'Live run metadata must precede the attempt-specific jobs request');
      model.reads.jobs += 1; calls.push(endpoint); return clone(model.jobs);
    } };
  const outputs = new Map(); const summaries = [];
  const core = { setOutput(name, value) { outputs.set(name, value); }, summary: {
    addHeading(value) { summaries.push(value); return this; }, addRaw(value) { summaries.push(value); return this; }, async write() {},
  } };
  return { github, context, core, phase, env, model, profile, outputs, summaries, calls };
}
function pinProfile(fixture) {
  fixture.env.WORKSHOP_OWNER_PROFILE_JSON = canonicalJson(fixture.profile);
  fixture.env.WORKSHOP_OWNER_PROFILE_SHA256 = hash(canonicalJson(fixture.profile));
}
async function rejectedAdmission(mutator, options) {
  const fixture = admissionFixture(options); mutator(fixture);
  await assert.rejects(authorization.authorize(fixture));
  assert.equal(fixture.outputs.size, 0, 'failed admission must not emit successful outputs');
}

for (const route of [route02, route07]) for (const phase of ['preflight', 'plan', 'apply']) {
  test(`synthetic approved private ${route.id} ${phase} admission re-reads live metadata without writes`, async () => {
    const fixture = admissionFixture({ route, phase });
    const result = await authorization.authorize(fixture);
    assert.equal(result.operation, 'deploy'); assert.equal(result.mainSha, SHA);
    assert.equal(result.concurrencyGroup, 'ws2-state-test-alex-001'); assert.equal(result.binding.root, 'infra');
    assert.equal(fixture.outputs.get('state_lock_id'), 'test-alex-001');
    assert.equal(result.binding.ownerProfileSha256, hash(canonicalJson(fixture.profile)));
    assert.equal(fixture.outputs.get('owner_profile_sha256'), result.binding.ownerProfileSha256);
    assert.equal(fixture.model.reads.repository, 2); assert.equal(fixture.model.reads.branch, 2); assert.equal(fixture.model.reads.run, 2);
    assert.ok(fixture.calls.every(call => call.startsWith('GET ')));
    assert.ok(!fixture.summaries.join().includes('Hello from alex'));
  });
}
for (const route of [route02, route07]) for (const phase of ['plan', 'apply']) {
  test(`${route.id} ${phase} accepts omitted job attempts only from the verified first-attempt jobs route`, async () => {
    const fixture = admissionFixture({ route, phase });
    for (const job of fixture.model.jobs) delete job.run_attempt;
    assert.equal((await authorization.authorize(fixture)).operation, 'deploy');
    assert.equal(fixture.model.reads.jobs, 1); assert.equal(fixture.model.reads.run, 2);
    const index = fixture.calls.indexOf(JOBS_ROUTE);
    assert.ok(index > 0 && fixture.calls.slice(0, index).includes('GET run'));
    assert.ok(fixture.calls.slice(index + 1).includes('GET run'), 'The same live first attempt must be verified after reading jobs');
  });
}
for (const phase of ['plan', 'apply']) {
  test(`public ${phase} job assertion rejects omitted attempts without explicit verified-route proof`, () => {
    const fixture = admissionFixture({ phase });
    const options = { phase, runId: fixture.context.runId, sha: fixture.context.sha };
    assert.doesNotThrow(() => authorization.assertJobs(fixture.model.jobs, options));
    for (const job of fixture.model.jobs) delete job.run_attempt;
    assert.throws(() => authorization.assertJobs(fixture.model.jobs, options), /job attempt/);
    for (const attemptSpecificVerified of [false, 'true', 1])
      assert.throws(() => authorization.assertJobs(fixture.model.jobs, { ...options, attemptSpecificVerified }), /job attempt/);
    assert.doesNotThrow(() => authorization.assertJobs(fixture.model.jobs, { ...options, attemptSpecificVerified: true }));
    assert.equal(fixture.calls.length, 0, 'The public assertion cannot invent API provenance');
  });
  for (const attempt of [2, 0, '1', null, undefined]) {
    test(`${phase} rejects a populated contradictory job attempt ${String(attempt)} even with verified-route proof`, async () => {
      const fixture = admissionFixture({ phase });
      for (const job of fixture.model.jobs) delete job.run_attempt;
      fixture.model.jobs.push({ name: 'Unrelated queued job', run_id: fixture.context.runId, head_sha: SHA, run_attempt: attempt, status: 'queued', conclusion: null });
      assert.throws(() => authorization.assertJobs(fixture.model.jobs,
        { phase, runId: fixture.context.runId, sha: SHA, attemptSpecificVerified: true }), /job attempt/);
      await assert.rejects(authorization.authorize(fixture), /job attempt/);
      assert.equal(fixture.outputs.size, 0);
    });
  }
  for (const [label, mutate, jobReads] of [
    ['initial live rerun', f => { f.model.run.run_attempt = 2; }, 0],
    ['initial different live run', f => { f.model.run.id += 1; }, 0],
    ['final live rerun', f => { f.model.runRead = count => count === 1 ? f.model.run : { ...f.model.run, run_attempt: 2 }; }, 1],
    ['final different live run', f => { f.model.runRead = count => count === 1 ? f.model.run : { ...f.model.run, id: f.context.runId + 1 }; }, 1],
  ]) test(`${phase} rejects ${label} despite missing job-attempt fields`, async () => {
    const fixture = admissionFixture({ phase });
    for (const job of fixture.model.jobs) delete job.run_attempt;
    mutate(fixture);
    await assert.rejects(authorization.authorize(fixture), /workflow run metadata/);
    assert.equal(fixture.model.reads.jobs, jobReads); assert.equal(fixture.outputs.size, 0);
  });
}
test('owner-pinned legacy subjects are admitted only as part of a newly pinned full owner profile', async () => {
  for (const phase of ['preflight', 'plan', 'apply']) {
    const fixture = admissionFixture({ phase });
    const immutableProfileDigest = fixture.env.WORKSHOP_OWNER_PROFILE_SHA256;
    fixture.profile.oidcSubjects = { plan: `repo:${route07.repository}:environment:workshop-plan`, apply: `repo:${route07.repository}:environment:workshop-apply` };
    pinProfile(fixture);
    const result = await authorization.authorize(fixture);
    assert.notEqual(result.binding.ownerProfileSha256, immutableProfileDigest);
    assert.equal(result.binding.ownerProfileSha256, fixture.env.WORKSHOP_OWNER_PROFILE_SHA256);
  }
});
for (const [label, mutate] of [
  ['missing pinned subjects', f => { delete f.profile.oidcSubjects; }],
  ['null subjects', f => { f.profile.oidcSubjects = null; }],
  ['array subjects', f => { f.profile.oidcSubjects = Object.values(f.profile.oidcSubjects); }],
  ['missing plan subject', f => { delete f.profile.oidcSubjects.plan; }],
  ['missing apply subject', f => { delete f.profile.oidcSubjects.apply; }],
  ['unknown subject field', f => { f.profile.oidcSubjects.cleanup = f.profile.oidcSubjects.apply; }],
  ['non-string subject', f => { f.profile.oidcSubjects.plan = 123; }],
  ['empty subject', f => { f.profile.oidcSubjects.plan = ''; }],
  ['missing subject prefix', f => { f.profile.oidcSubjects.plan = ':environment:workshop-plan'; }],
  ['swapped phase subject', f => { f.profile.oidcSubjects.plan = f.profile.oidcSubjects.apply; }],
  ['nonliteral environment suffix', f => { f.profile.oidcSubjects.plan = f.profile.oidcSubjects.plan.replace('workshop-plan', 'dev-plan'); }],
  ['subject suffix extension', f => { f.profile.oidcSubjects.plan += ':extra'; }],
  ['renamed pinned environment', f => { f.profile.environments.plan = 'dev-plan'; }],
  ...['*', '?', '[owner]', '{owner}', '\n', '\r', '\t', '\u007f', '\u00e9'].map(value =>
    [`nonliteral or nonprintable subject prefix ${JSON.stringify(value)}`, f => { f.profile.oidcSubjects.plan = value + f.profile.oidcSubjects.plan; }]),
  ['oversized subject', f => { f.profile.oidcSubjects.plan = 'x'.repeat(601) + ':environment:workshop-plan'; }],
]) test(`owner profile rejects ${label} before any metadata reads`, async () => {
  const fixture = admissionFixture(); mutate(fixture); pinProfile(fixture);
  await assert.rejects(authorization.authorize(fixture), /owner profile|OIDC subject|environment/);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.outputs.size, 0);
});
test('subject validation is bounded without inferring or normalizing an opaque owner pin', () => {
  const suffix = ':environment:workshop-plan';
  const subject = 'x'.repeat(600 - suffix.length) + suffix;
  assert.equal(authorization.assertOidcSubject(subject, 'workshop-plan'), subject);
  assert.throws(() => authorization.assertOidcSubject(`x${subject}`, 'workshop-plan'), /OIDC subject/);
  assert.throws(() => authorization.assertOidcSubject(subject, 'workshop-apply'), /OIDC subject/);
});
test('synthetic admin cleanup and delivery followup use separate exact routes', async () => {
  for (const phase of ['preflight', 'plan', 'apply']) {
    const cleanup = admissionFixture({ operation: 'destroy', phase });
    assert.equal((await authorization.authorize(cleanup)).operation, 'destroy');
  }
  const followup = admissionFixture({ operation: 'followup', phase: 'plan' });
  assert.equal((await authorization.authorize(followup)).operation, 'followup');
});
test('admission rejects a missing owner assignment CIDR before any metadata reads', async () => {
  const fixture = admissionFixture(); delete fixture.profile.assignment.allowed_web_cidr;
  fixture.profile.assignmentSha256 = hash(canonicalJson(fixture.profile.assignment));
  fixture.env.WORKSHOP_ASSIGNMENT_SHA256 = fixture.profile.assignmentSha256;
  pinProfile(fixture);
  await assert.rejects(authorization.authorize(fixture), /invalid or inactive live owner assignment/);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.outputs.size, 0);
});
test('hidden bypass metadata is accepted only with the explicit owner-pinned rule ID/revision/readback', async () => {
  const fixture = admissionFixture(); delete fixture.model.ruleset.bypass_actors;
  assert.equal((await authorization.authorize(fixture)).operation, 'deploy');
  await rejectedAdmission(f => { delete f.model.ruleset.bypass_actors; delete f.profile.ruleset.updatedAt; pinProfile(f); });
  await rejectedAdmission(f => { delete f.model.ruleset.bypass_actors; f.model.ruleset.updated_at = new Date(Date.now() - 1000).toISOString(); });
});
test('the new source name is always rejected, even when all other flags are enabled', async () => {
  const fixture = admissionFixture(); fixture.context.payload.repository.full_name = 'alvinea28/lab-iac-ws2-terraform-github-actions-azure';
  await assert.rejects(authorization.authorize(fixture), /repository ID\/name\/owner mismatch/);
  assert.equal(fixture.calls.length, 0);
  assert.throws(() => authorization.operationFor('push', undefined,
    'alvinea28/lab-iac-ws2-terraform-github-actions-azure/.github/workflows/delivery.yml@refs/heads/main',
    'alvinea28/lab-iac-ws2-terraform-github-actions-azure'), /immutable/);
});

const admissionRejections = [
  ['wrong immutable repository', f => { f.context.payload.repository.id = 42; }],
  ['wrong repository name', f => { f.context.payload.repository.full_name += '-copy'; }],
  ['template payload', f => { f.context.payload.repository.is_template = true; }],
  ['public payload', f => { f.context.payload.repository.private = false; f.context.payload.repository.visibility = 'public'; }],
  ['live template', f => { f.model.repository.is_template = true; }],
  ['live public repository', f => { f.model.repository.private = false; }],
  ['fork', f => { f.model.repository.fork = true; }],
  ['disabled Azure flag', f => { f.env.WORKSHOP_AZURE_ENABLED = 'false'; }],
  ['missing RG authorization', f => { delete f.env.WORKSHOP_RG_CREATION_APPROVED; }],
  ['long-lived credential slot', f => { f.env.ARM_CLIENT_SECRET = 'synthetic-not-a-secret'; }],
  ['truthy nonliteral RG flag', f => { f.env.WORKSHOP_RG_CREATION_APPROVED = 'TRUE'; }],
  ['runtime rerun', f => { f.env.GITHUB_RUN_ATTEMPT = '2'; }],
  ['live rerun', f => { f.model.run.run_attempt = 2; }],
  ['unprotected runtime ref', f => { f.env.GITHUB_REF_PROTECTED = 'false'; }],
  ['stale main', f => { f.model.branch.commit.sha = OTHER_SHA; }],
  ['unprotected main', f => { f.model.branch.protected = false; }],
  ['different workflow SHA', f => { f.env.GITHUB_WORKFLOW_SHA = OTHER_SHA; }],
  ['different runtime SHA', f => { f.env.GITHUB_SHA = OTHER_SHA; }],
  ['forced push', f => { f.context.payload.forced = true; }],
  ['deleted push', f => { f.context.payload.deleted = true; }],
  ['different run repository', f => { f.model.run.head_repository.id = route02.id; }],
  ['run actor numeric mismatch', f => { f.model.run.actor.id = 102; }],
  ['sender numeric mismatch', f => { f.context.payload.sender.id = 102; }],
  ['triggering actor mismatch', f => { f.model.run.triggering_actor.id = 102; }],
  ['bot actor', f => { f.model.run.actor.type = 'Bot'; }],
  ['profile digest tamper', f => { f.env.WORKSHOP_OWNER_PROFILE_SHA256 = '0'.repeat(64); }],
  ['missing profile', f => { delete f.env.WORKSHOP_OWNER_PROFILE_JSON; }],
  ['unknown profile field', f => { f.profile.oidcSubject = f.profile.oidcSubjects.plan; pinProfile(f); }],
  ['subject changed without owner digest', f => { f.profile.oidcSubjects.plan = `repo:${route07.repository}:environment:workshop-plan`; f.env.WORKSHOP_OWNER_PROFILE_JSON = canonicalJson(f.profile); }],
  ['missing owner evidence', f => { delete f.profile.ruleset.verifiedAt; pinProfile(f); }],
  ['nonadmin profile owner', f => { f.model.ownerPermission.permission = 'write'; }],
  ['owner numeric mismatch', f => { f.model.ownerPermission.user.id = 9002; }],
  ['wrong budget', f => { f.env.WORKSHOP_BUDGET_LIMIT_MINOR = '999999'; }],
  ['wrong currency', f => { f.env.WORKSHOP_BUDGET_CURRENCY = 'EUR'; }],
  ['missing expiry pin', f => { delete f.env.WORKSHOP_EXPIRES_AT; }],
  ['expired profile', f => { f.profile.expiresAt = new Date(Date.now() - 1000).toISOString(); f.env.WORKSHOP_EXPIRES_AT = f.profile.expiresAt; pinProfile(f); }],
  ['unbounded budget', f => { f.profile.budget.limitMinorUnits = 0; pinProfile(f); }],
  ['future owner authorization', f => { f.profile.approvedAt = new Date(Date.now() + 60_000).toISOString(); pinProfile(f); }],
  ['overlong lifetime', f => { f.profile.budget.maxLifetimeHours = 25; pinProfile(f); }],
  ['participant input tamper', f => { f.env.WORKSHOP_PARTICIPANT_JSON = canonicalJson({ ...participant(), app_message: 'Changed' }); }],
  ['lock digest mismatch', f => { f.env.WORKSHOP_PROVIDER_LOCK_SHA256 = 'f'.repeat(64); }],
  ['app digest mismatch', f => { f.env.WORKSHOP_APP_SHA256 = 'f'.repeat(64); }],
  ['HCL digest mismatch', f => { f.env.WORKSHOP_INFRA_SHA256 = 'f'.repeat(64); }],
  ['workflow digest mismatch', f => { f.env.WORKSHOP_WORKFLOW_SHA256 = 'f'.repeat(64); }],
  ['changed backend key', f => { f.env.STATE_KEY = 'other.tfstate'; }],
  ['different concurrency ID', f => { f.env.WS2_STATE_LOCK_ID = 'other-state-id'; }],
  ['concurrency cancellation', f => { f.env.WORKSHOP_CANCEL_IN_PROGRESS = 'true'; }],
  ['missing rule revision', f => { delete f.model.ruleset.updated_at; }],
  ['visible rule bypass', f => { f.model.ruleset.bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }]; }],
  ['wrong rule ID', f => { f.model.ruleset.id += 1; }],
  ['force push protection removed', f => { f.model.ruleset.rules = f.model.ruleset.rules.filter(rule => rule.type !== 'non_fast_forward'); }],
  ['deletion protection removed', f => { f.model.ruleset.rules = f.model.ruleset.rules.filter(rule => rule.type !== 'deletion'); }],
  ['PR approval requirement changed', f => { f.model.ruleset.rules.find(rule => rule.type === 'pull_request').parameters.required_approving_review_count = 1; }],
  ['weakened status checks', f => { f.model.ruleset.rules.find(rule => rule.type === 'required_status_checks').parameters.strict_required_status_checks_policy = false; }],
  ['foreign check integration', f => { f.model.checkRuns[0].app.id = 42; }],
  ['failed required check', f => { f.model.checkRuns[0].conclusion = 'failure'; }],
  ['missing required check', f => { f.model.checkRuns = []; }],
  ['unexpected inherited policy', f => { f.model.effectiveRules[0].ruleset_id = 42; }],
  ['missing merged PR', f => { f.model.prs = []; }],
  ['foreign PR head', f => { f.model.prs[0].head.repo.id = 42; }],
  ['not actually merged', f => { f.model.pr.merged = false; }],
  ['environment reviewer', f => { f.model.environments['workshop-apply'].protection_rules.push({ type: 'required_reviewers' }); }],
  ['environment admin bypass', f => { f.model.environments['workshop-apply'].can_admins_bypass = true; }],
  ['environment admits other branches', f => { f.model.branches.push({ name: 'dev', type: 'branch' }); }],
  ['missing environment branch type', f => { delete f.model.branches[0].type; }],
];
for (const [label, mutate] of admissionRejections) test(`GitHub admission rejects ${label}`, () => rejectedAdmission(mutate));
test('admission catches main movement on the final read', async () => {
  await rejectedAdmission(f => { f.model.branchRead = count => count === 1 ? f.model.branch : { ...f.model.branch, commit: { sha: OTHER_SHA } }; });
});
test('admission catches run movement on the final read', async () => {
  await rejectedAdmission(f => { f.model.runRead = count => count === 1 ? f.model.run : { ...f.model.run, run_attempt: 2 }; });
});
for (const [label, mutate] of [
  ['nonadmin cleanup', f => { f.model.ownerPermission.permission = 'write'; }],
  ['wrong cleanup repository authorization', f => { f.context.payload.inputs.authorization = `destroy:${route02.id}:${SHA}:test-alex-001`; }],
  ['wrong cleanup SHA authorization', f => { f.context.payload.inputs.authorization = `destroy:${route07.id}:${OTHER_SHA}:test-alex-001`; }],
  ['wrong cleanup state authorization', f => { f.context.payload.inputs.authorization = `destroy:${route07.id}:${SHA}:other-state`; }],
  ['missing cleanup authorization', f => { delete f.context.payload.inputs.authorization; }],
  ['cleanup numeric sender mismatch', f => { f.context.payload.sender.id = 9002; }],
  ['cleanup triggering actor mismatch', f => { f.model.run.triggering_actor.id = 9002; }],
]) test(`separate cleanup rejects ${label}`, () => rejectedAdmission(mutate, { operation: 'destroy' }));
test('delivery cannot be dispatched to deploy/destroy, scheduled, or run on another workflow/ref', () => {
  const main = `${route07.repository}/.github/workflows/delivery.yml@refs/heads/main`;
  assert.equal(authorization.operationFor('push', undefined, main, route07.id), 'deploy');
  assert.equal(authorization.operationFor('workflow_dispatch', 'followup', main, route07.id), 'followup');
  for (const input of ['deploy', 'destroy', undefined]) assert.throws(() => authorization.operationFor('workflow_dispatch', input, main, route07.id));
  assert.throws(() => authorization.operationFor('schedule', undefined, main, route07.id));
  assert.throws(() => authorization.operationFor('push', undefined, main.replace('main', 'dev'), route07.id));
  assert.throws(() => authorization.operationFor('push', undefined, main.replace('delivery', 'cleanup'), route07.id));
});
test('followup cannot enter apply, and phase OIDC clients must stay separate', async () => {
  await rejectedAdmission(() => {}, { operation: 'followup', phase: 'apply' });
  await rejectedAdmission(f => { f.env.ARM_CLIENT_ID = APPLY_CLIENT; }, { phase: 'plan' });
  await rejectedAdmission(f => { f.env.ARM_CLIENT_ID = PLAN_CLIENT; }, { phase: 'apply' });
});
for (const phase of ['plan', 'apply']) for (const role of ['prerequisite', 'current']) for (const field of ['run_id', 'run_attempt', 'head_sha', 'status', 'conclusion']) {
  test(`${phase} rejects ${role} job ${field} mismatch even when other job attempts are omitted`, () => rejectedAdmission(f => {
    for (const job of f.model.jobs) delete job.run_attempt;
    const name = role === 'prerequisite' ? authorization.JOBS.validation : phase === 'apply' ? authorization.JOBS.apply : authorization.JOBS.plan;
    const job = f.model.jobs.find(item => item.name === name);
    job[field] = field === 'run_id' ? 42 : field === 'run_attempt' ? 2 : field === 'head_sha' ? OTHER_SHA :
      field === 'status' ? (role === 'current' ? 'completed' : 'in_progress') : (role === 'current' ? 'success' : 'skipped');
  }, { phase }));
}
test('apply requires the exact successful plan and preflight jobs, without duplicate names', async () => {
  await rejectedAdmission(f => { f.model.jobs = f.model.jobs.filter(job => job.name !== authorization.JOBS.plan); }, { phase: 'apply' });
  await rejectedAdmission(f => { f.model.jobs = f.model.jobs.filter(job => job.name !== authorization.JOBS.preflight); }, { phase: 'apply' });
  await rejectedAdmission(f => { f.model.jobs.push(clone(f.model.jobs[0])); }, { phase: 'apply' });
  await rejectedAdmission(f => { f.model.jobs.find(job => job.name === authorization.JOBS.apply).status = 'completed'; }, { phase: 'apply' });
});
