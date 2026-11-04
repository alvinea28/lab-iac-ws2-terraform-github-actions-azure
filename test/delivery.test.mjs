import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, mock, test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { unzipSync } from 'fflate';
import { parseDocument } from 'yaml';
import authorization from '../scripts/deployment-authorization.cjs';
import { ROOT, deriveNames, terraformVariables } from '../scripts/inputs.mjs';
import { buildPackage } from '../scripts/package-app.mjs';
import { clean, CONTROL_FILES, controlDigests, ENVIRONMENTS, getGitHubJWT, githubAdapter, infraDigest, initArguments, planArguments, prepare, terraformEnvironment, terraformRunner, validateGitHubJWT, workflowMain } from '../scripts/delivery.mjs';
import { API, ARM_ORIGIN, createArmClient, managedState, resourceIds, validateInventory, validateReadback, verifyAbsence, verifyHealth } from '../scripts/azure-readback.mjs';
import { canonicalJson, hash, makeManifest, PROFILE, RESOURCE_ADDRESSES, summarizePlan, validateBinding, verifyPlan } from '../scripts/plan-policy.mjs';
import { sealPlan, openPlan } from '../scripts/plan-envelope.mjs';

// Every runtime adapter below is synthetic. No real subprocess, SDK credential,
// Git, HTTP server, Azure, provider, GitHub token or existing state is used.
// Files are created ONLY in an owned temporary test directory and removed.
const SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APPLY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHA = 'a'.repeat(40);
const ROUTE = authorization.ALLOWED_REPOSITORIES['1379149907'];
const RUN_ROUTE = 'GET /repos/{owner}/{repo}/actions/runs/{run_id}';
const JOBS_ROUTE = 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs';
const LIFECYCLE_JOBS = Object.freeze({ 'package-deploy': 'Package and deploy workshop app', 'verify-deployed': 'Verify deployed workshop',
  followup: 'Confirm no-change', 'verify-absence': 'Verify workload absence' });
// Opaque synthetic owner pins, NOT a recipe for deriving production subjects.
const OIDC_SUBJECTS = Object.freeze({
  plan: 'repo:alvine-aurelio-org/ws2-sim-20260921-azure-delivery-laboratory-07:repository_owner_id:201:repository_id:1379149907:environment:workshop-plan',
  apply: 'repo:alvine-aurelio-org/ws2-sim-20260921-azure-delivery-laboratory-07:repository_owner_id:201:repository_id:1379149907:environment:workshop-apply',
});
const PROVIDER = 'registry.terraform.io/hashicorp/azurerm';
const BINARY = Buffer.from('SYNTHETIC_ONLY_BINARY_PLAN\0DO_NOT_LOG_PLAN');
const input = { participant_name: 'alex', instance_number: '001', app_message: 'Hello from alex', page_theme: 'blue', workshop_iteration: '01' };
const dependencies = { '@azure/identity': '4.14.1', '@azure/storage-blob': '12.34.0', express: '5.3.0' };
const ref = (...references) => ({ references });
const literal = constant_value => ({ constant_value });
const jsonResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
let keys;
before(() => { keys = generateKeyPairSync('rsa', { modulusLength: 3072 }); });

function fixture(operation = 'deploy') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-delivery-test-'));
  const put = (relative, bytes) => { const full = path.join(root, relative); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, bytes, { mode: 0o600 }); };
  const putJson = (relative, value) => put(relative, canonicalJson(value));
  putJson('exercise/participant.json', input);
  put('infra/main.tf', '# SYNTHETIC root; a fake subprocess supplies the policy fixture\n');
  put('infra/backend.tf', 'terraform { backend "azurerm" {} }\n');
  put('infra/.terraform.lock.hcl', '# synthetic test lock, not a downloaded provider\n');
  for (const file of ['delivery.yml', 'cleanup.yml']) put(`.github/workflows/${file}`, fs.readFileSync(path.join(ROOT, '.github/workflows', file)));
  const manifest = { name: 'synthetic-app', private: true, type: 'module', scripts: { start: 'node server.mjs' }, dependencies };
  putJson('app/package.json', manifest);
  put('app/server.mjs', '// supplied synthetic source\n');
  put('app/public/page.js', '// supplied synthetic page\n');
  put('app/public/style.css', ':root { color: blue }\n');
  const installed = {};
  for (const [name, version] of Object.entries(dependencies)) {
    const relative = `node_modules/${name}`;
    installed[relative] = { version, integrity: `sha512-${Buffer.from(`synthetic-${name}`).toString('base64')}`, resolved: `https://registry.npmjs.org/${name}/-/synthetic-${version}.tgz` };
    putJson(`app/${relative}/package.json`, { name, version });
    put(`app/${relative}/index.js`, '// synthetic dependency bytes, never imported\n');
  }
  putJson('app/package-lock.json', { name: 'synthetic-app', lockfileVersion: 3, packages: { '': manifest, ...installed } });
  putJson('app/node_modules/.package-lock.json', { name: 'synthetic-app', lockfileVersion: 3, packages: installed });
  const now = Date.now();
  const assignment = { schema_version: 1, mode: 'live', participant_name: 'alex', learner_user_ids: [101], instance_number: '001', network_slot: 21,
    location: 'southeastasia', allowed_web_cidr: '203.0.113.0/24', subscription_id: SUB, tenant_id: TENANT,
    app_identity_id: `/subscriptions/${SUB}/resourceGroups/rg-fixture-bootstrap/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-fixture`,
    owner: 'fixture-owner', cost_center: 'fixture-only', expires_at: new Date(now + 4 * 3_600_000).toISOString() };
  const backend = { subscriptionId: SUB, resourceGroupName: 'rg-fixture-backend', storageAccountName: 'stfixturebackend', containerName: 'tfstate', key: 'fixture/alex-001.tfstate', stateLockId: 'fixture-alex-001' };
  const profile = { schemaVersion: 1, profile: PROFILE, repository: ROUTE.repository, repositoryId: String(ROUTE.id), root: 'infra',
    subscriptionId: SUB, tenant: TENANT, planClientId: PLAN, applyClientId: APPLY, backend, assignment, terraformVersion: '1.16.1', providerVersion: '5.4.0',
    assignmentSha256: hash(canonicalJson(assignment)), providerLockSha256: hash(fs.readFileSync(path.join(root, 'infra/.terraform.lock.hcl'))),
    appSha256: buildPackage({ root }).sha256,
    infraSha256: infraDigest(['main.tf', 'backend.tf'].map(name => ({ name, bytes: fs.readFileSync(path.join(root, 'infra', name)) }))),
    deliveryWorkflowSha256: hash(fs.readFileSync(path.join(root, '.github/workflows/delivery.yml'))), cleanupWorkflowSha256: hash(fs.readFileSync(path.join(root, '.github/workflows/cleanup.yml'))),
    owner: { id: '201', login: 'fixture-owner' }, budget: { currency: 'USD', limitMinorUnits: 100, maxLifetimeHours: 8 },
    approvedAt: new Date(now - 60_000).toISOString(), expiresAt: assignment.expires_at,
    ruleset: { id: ROUTE.rulesetId, updatedAt: new Date(now - 120_000).toISOString(), verifiedAt: new Date(now - 90_000).toISOString(), bypassActors: [] },
    environments: ENVIRONMENTS, oidcSubjects: { ...OIDC_SUBJECTS }, requiredChecks: ['Workshop quality'] };
  const env = { PATH: process.env.PATH, WORKSHOP_OWNER_PROFILE_JSON: canonicalJson(profile), WORKSHOP_OWNER_PROFILE_SHA256: hash(canonicalJson(profile)),
    WORKSHOP_AZURE_ENABLED: 'true', WORKSHOP_RG_CREATION_APPROVED: 'true', WORKSHOP_BUDGET_CURRENCY: 'USD', WORKSHOP_BUDGET_LIMIT_MINOR: '100', WORKSHOP_EXPIRES_AT: profile.expiresAt,
    ARM_SUBSCRIPTION_ID: SUB, ARM_TENANT_ID: TENANT, PLAN_CLIENT_ID: PLAN, APPLY_CLIENT_ID: APPLY, ARM_CLIENT_ID: PLAN,
    STATE_RESOURCE_GROUP: backend.resourceGroupName, STATE_STORAGE_ACCOUNT: backend.storageAccountName, STATE_CONTAINER: backend.containerName, STATE_KEY: backend.key,
    WS2_STATE_LOCK_ID: backend.stateLockId, WORKSHOP_CONCURRENCY_GROUP: `ws2-state-${backend.stateLockId}`, WORKSHOP_CANCEL_IN_PROGRESS: 'false',
    GITHUB_REPOSITORY: ROUTE.repository, GITHUB_REPOSITORY_ID: String(ROUTE.id), GITHUB_RUN_ID: '910001', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: SHA, GITHUB_WORKFLOW_SHA: SHA,
    GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_EVENT_NAME: operation === 'deploy' ? 'push' : 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: `${ROUTE.repository}/.github/workflows/${operation === 'destroy' ? 'cleanup.yml' : 'delivery.yml'}@refs/heads/main`,
    GITHUB_ACTOR: 'fixture-learner', GITHUB_ACTOR_ID: '101', GITHUB_TRIGGERING_ACTOR: 'fixture-learner', OPERATION: operation,
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/fixture/_apis/distributedtask/hubs/build/plans/fixture/jobs/fixture/idtoken?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-request-token-not-issued',
    PLAN_ENCRYPTION_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
  const eventPayload = operation === 'deploy'
    ? { ref: 'refs/heads/main', after: SHA, deleted: false, forced: false }
    : { inputs: operation === 'destroy' ? { authorization: `destroy:${ROUTE.id}:${SHA}:${backend.stateLockId}` } : { operation } };
  const context = { repo: { owner: 'alvine-aurelio-org', repo: ROUTE.repository.split('/')[1] }, runId: 910001, sha: SHA, ref: 'refs/heads/main', actor: 'fixture-learner', eventName: env.GITHUB_EVENT_NAME,
    payload: { repository: { id: ROUTE.id, full_name: ROUTE.repository, name: ROUTE.repository.split('/')[1], owner: { login: 'alvine-aurelio-org' }, private: true, visibility: 'private', is_template: false, fork: false, archived: false, disabled: false },
      sender: { type: 'User', id: 101, login: 'fixture-learner' }, ...eventPayload } };
  const prepared = prepare({ root, env });
  const binding = validateBinding({ profile: PROFILE, repository: ROUTE.repository, repositoryId: String(ROUTE.id), workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: env.GITHUB_RUN_ID, runAttempt: '1', sha: SHA, root: 'infra', operation, subscriptionId: SUB, tenant: TENANT, planClientId: PLAN, applyClientId: APPLY,
    backend, participant: input, assignment, terraformVersion: '1.16.1', providerVersion: '5.4.0', participantSha256: prepared.env.WORKSHOP_PARTICIPANT_SHA256,
    assignmentSha256: profile.assignmentSha256, providerLockSha256: profile.providerLockSha256, appSha256: profile.appSha256,
    infraSha256: profile.infraSha256, workflowSha256: prepared.env.WORKSHOP_WORKFLOW_SHA256, ownerProfileSha256: env.WORKSHOP_OWNER_PROFILE_SHA256 });
  return { root, env, context, profile, binding, put, putJson, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function pinProfile(f) {
  f.env.WORKSHOP_OWNER_PROFILE_JSON = canonicalJson(f.profile);
  f.env.WORKSHOP_OWNER_PROFILE_SHA256 = hash(canonicalJson(f.profile));
}

function jwt(binding, environment, subject, changes = {}) {
  const seconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: 'SYNTHETIC-UNISSUED' };
  const claims = { iss: 'https://token.actions.githubusercontent.com', aud: 'api://AzureADTokenExchange', repository: binding.repository, repository_id: binding.repositoryId,
    repository_visibility: 'private', ref: 'refs/heads/main', sha: SHA, run_id: binding.runId, run_attempt: '1', workflow_ref: binding.workflowRef, workflow_sha: SHA,
    environment, sub: subject, event_name: binding.operation === 'deploy' ? 'push' : 'workflow_dispatch',
    iat: seconds - 1, nbf: seconds - 1, exp: seconds + 299, ...changes };
  return [header, claims].map(value => Buffer.from(canonicalJson(value)).toString('base64url')).concat(Buffer.from('UNISSUED-TEST-SIGNATURE').toString('base64url')).join('.');
}

function nativePlan(binding, action = 'create') {
  const ids = resourceIds(binding);
  const n = deriveNames(binding.participant);
  const tags = { owner: binding.assignment.owner, environment: 'training', cost_center: binding.assignment.cost_center, workshop: 'ws2-iac', participant: 'alex', workshop_iteration: '01', expires_at: binding.assignment.expires_at };
  const shared = { resource_group_name: n.resourceGroup, location: binding.assignment.location, tags };
  const site = { always_on: true, http2_enabled: true, minimum_tls_version: '1.2', scm_minimum_tls_version: '1.2', ftps_state: 'Disabled', app_command_line: 'npm start',
    vnet_route_all_enabled: false, remote_debugging_enabled: false, ip_restriction_default_action: 'Deny', scm_ip_restriction_default_action: 'Deny', scm_use_main_ip_restriction: true };
  const storage = { account_kind: 'StorageV2', account_tier: 'Standard', account_replication_type: 'LRS', access_tier: 'Hot', min_tls_version: 'TLS1_2',
    https_traffic_only_enabled: true, shared_access_key_enabled: false, allow_nested_items_to_be_public: false, public_network_access_enabled: false,
    default_to_oauth_authentication: true, cross_tenant_replication_enabled: false, is_hns_enabled: false, sftp_enabled: false, local_user_enabled: false };
  const web = { https_only: true, public_network_access_enabled: true, ftp_publish_basic_authentication_enabled: false, webdeploy_publish_basic_authentication_enabled: false };
  const values = {
    'azurerm_resource_group.workshop': { name: n.resourceGroup, location: shared.location, tags },
    'azurerm_virtual_network.workshop': { ...shared, name: n.vnet, address_space: ['10.80.21.0/24'], dns_servers: [] },
    'azurerm_network_security_group.workshop': { ...shared, name: n.nsg, security_rule: [] },
    'azurerm_service_plan.workshop': { ...shared, name: n.servicePlan, os_type: 'Linux', sku_name: 'B1', worker_count: 1 },
    'azurerm_linux_web_app.workshop': { ...shared, name: n.webApp, ...web, enabled: true, service_plan_id: ids.servicePlan, virtual_network_subnet_id: ids.appSubnet,
      identity: [{ type: 'UserAssigned', identity_ids: [binding.assignment.app_identity_id] }], site_config: [{ ...site, scm_ip_restriction: [],
        ip_restriction: [{ name: 'approved-workshop-network', action: 'Allow', priority: 100, ip_address: binding.assignment.allowed_web_cidr }], application_stack: [{ node_version: '24-lts' }] }],
      app_settings: { APP_MESSAGE: input.app_message, PAGE_THEME: input.page_theme, WORKSHOP_ITERATION: '01', STORAGE_ACCOUNT_NAME: n.storage, STORAGE_CONTAINER_NAME: n.container,
        MANAGED_IDENTITY_RESOURCE_ID: binding.assignment.app_identity_id, WEBSITE_RUN_FROM_PACKAGE: '1' } },
    'azurerm_storage_account.workshop': { ...shared, name: n.storage, ...storage },
    'azurerm_storage_container.workshop': { name: n.container, storage_account_id: ids.storage, container_access_type: 'private' },
    'azurerm_private_endpoint.blob': { ...shared, name: n.privateEndpoint, subnet_id: ids.endpointSubnet,
      private_service_connection: [{ name: n.privateEndpoint, private_connection_resource_id: ids.storage, subresource_names: ['blob'], is_manual_connection: false, private_ip_address: '10.80.21.68' }],
      private_dns_zone_group: [{ name: n.dnsGroup, private_dns_zone_ids: [ids.dnsZone] }] },
    'azurerm_private_dns_zone.blob': { name: n.dnsZone, resource_group_name: n.resourceGroup, tags },
    'azurerm_private_dns_zone_virtual_network_link.blob': { name: n.dnsLink, tags, private_dns_zone_id: ids.dnsZone,
      virtual_network_id: ids.vnet, registration_enabled: false },
  };
  for (const [suffix, app] of [['app', true], ['endpoints', false]]) {
    values[`azurerm_subnet.${suffix}`] = { name: app ? n.appSubnet : n.endpointSubnet, resource_group_name: n.resourceGroup, virtual_network_name: n.vnet,
      address_prefixes: [app ? '10.80.21.0/26' : '10.80.21.64/27'], default_outbound_access_enabled: false, private_endpoint_network_policies: app ? 'Enabled' : 'Disabled', private_link_service_network_policies_enabled: true,
      delegation: app ? [{ name: 'app-service', service_delegation: [{ name: 'Microsoft.Web/serverFarms', actions: ['Microsoft.Network/virtualNetworks/subnets/action'] }] }] : [] };
    values[`azurerm_subnet_network_security_group_association.${suffix}`] = { subnet_id: app ? ids.appSubnet : ids.endpointSubnet, network_security_group_id: ids.nsg };
  }
  const localNames = { 'azurerm_resource_group.workshop': 'resource_group', 'azurerm_virtual_network.workshop': 'vnet', 'azurerm_subnet.app': 'app_subnet', 'azurerm_subnet.endpoints': 'pe_subnet',
    'azurerm_network_security_group.workshop': 'nsg', 'azurerm_service_plan.workshop': 'plan', 'azurerm_linux_web_app.workshop': 'app', 'azurerm_storage_account.workshop': 'storage',
    'azurerm_storage_container.workshop': 'container', 'azurerm_private_endpoint.blob': 'blob_endpoint', 'azurerm_private_dns_zone_virtual_network_link.blob': 'dns_link' };
  const configs = RESOURCE_ADDRESSES.map(address => {
    const type = address.split('.')[0];
    const value = values[address];
    const expressions = {};
    if (value.name) expressions.name = address === 'azurerm_private_dns_zone.blob' ? literal(n.dnsZone) : ref(`local.names.${localNames[address]}`);
    if (value.location) expressions.location = ref(type === 'azurerm_resource_group' ? 'var.assignment.location' : 'azurerm_resource_group.workshop.location');
    if (value.resource_group_name) expressions.resource_group_name = ref('azurerm_resource_group.workshop.name');
    if (value.tags) expressions.tags = ref('local.tags');
    if (type === 'azurerm_virtual_network') expressions.address_space = ref('local.vnet_cidr');
    if (type === 'azurerm_subnet') {
      expressions.virtual_network_name = ref('azurerm_virtual_network.workshop.name');
      expressions.address_prefixes = ref(address.endsWith('.app') ? 'local.app_cidr' : 'local.pe_cidr');
      expressions.default_outbound_access_enabled = literal(false); expressions.private_endpoint_network_policies = literal(value.private_endpoint_network_policies);
      if (address.endsWith('.app')) expressions.delegation = [{ name: literal('app-service'), service_delegation: [{ name: literal('Microsoft.Web/serverFarms'), actions: literal(['Microsoft.Network/virtualNetworks/subnets/action']) }] }];
    }
    if (type === 'azurerm_subnet_network_security_group_association') {
      expressions.subnet_id = ref(`azurerm_subnet.${address.endsWith('.app') ? 'app' : 'endpoints'}.id`); expressions.network_security_group_id = ref('azurerm_network_security_group.workshop.id');
    }
    if (type === 'azurerm_service_plan') for (const field of ['os_type', 'sku_name', 'worker_count']) expressions[field] = literal(value[field]);
    if (type === 'azurerm_linux_web_app') {
      for (const [field, constant] of Object.entries(web)) expressions[field] = literal(constant);
      expressions.service_plan_id = ref('azurerm_service_plan.workshop.id'); expressions.virtual_network_subnet_id = ref('azurerm_subnet.app.id');
      expressions.identity = [{ type: literal('UserAssigned'), identity_ids: ref('var.assignment.app_identity_id') }];
      expressions.site_config = [{ ...Object.fromEntries(Object.entries(site).map(([field, constant]) => [field, literal(constant)])), ip_restriction: ref('var.assignment.allowed_web_cidr'), application_stack: [{ node_version: literal('24-lts') }] }];
      expressions.app_settings = ref('var.app_message', 'var.page_theme', 'var.workshop_iteration', 'azurerm_storage_account.workshop.name', 'azurerm_storage_container.workshop.name', 'var.assignment.app_identity_id');
    }
    if (type === 'azurerm_storage_account') for (const [field, constant] of Object.entries(storage)) expressions[field] = literal(constant);
    if (type === 'azurerm_storage_container') { expressions.container_access_type = literal('private'); expressions.storage_account_id = ref('azurerm_storage_account.workshop.id'); }
    if (type === 'azurerm_private_endpoint') {
      expressions.subnet_id = ref('azurerm_subnet.endpoints.id');
      expressions.private_service_connection = [{ name: ref('local.names.blob_endpoint'), private_connection_resource_id: ref('azurerm_storage_account.workshop.id'), subresource_names: literal(['blob']), is_manual_connection: literal(false) }];
      expressions.private_dns_zone_group = [{ name: ref('local.names.dns_group'), private_dns_zone_ids: ref('azurerm_private_dns_zone.blob.id') }];
    }
    if (type === 'azurerm_private_dns_zone_virtual_network_link') {
      expressions.private_dns_zone_id = ref('azurerm_private_dns_zone.blob.id'); expressions.virtual_network_id = ref('azurerm_virtual_network.workshop.id'); expressions.registration_enabled = literal(false);
    }
    return { address, name: address.split('.')[1], type, mode: 'managed', provider_config_key: 'azurerm', expressions };
  });
  const changes = RESOURCE_ADDRESSES.map(address => {
    const value = { id: ids.addresses[address], ...values[address] };
    return { address, name: address.split('.')[1], type: address.split('.')[0], mode: 'managed', provider_name: PROVIDER,
      change: { actions: [action], before: action === 'create' ? null : structuredClone(value), after: action === 'delete' ? null : structuredClone(value), after_unknown: {} } };
  });
  return { format_version: '1.2', terraform_version: '1.16.1', complete: true, errored: false,
    variables: Object.fromEntries(Object.entries(terraformVariables(binding.participant, binding.assignment)).map(([key, value]) => [key, { value }])), resource_changes: changes,
    planned_values: { root_module: { resources: changes.filter(item => item.change.after).map(item => ({ address: item.address, name: item.name, type: item.type, mode: 'managed', provider_name: PROVIDER, values: item.change.after })) } },
    configuration: { provider_config: { azurerm: { full_name: PROVIDER, version_constraint: '= 5.4.0', expressions: { subscription_id: ref('var.assignment.subscription_id'), tenant_id: ref('var.assignment.tenant_id'),
      use_oidc: literal(true), use_cli: literal(false), storage_use_azuread: literal(true), resource_provider_registrations: literal('none'), features: [{ resource_group: [{ prevent_deletion_if_contains_resources: literal(true) }] }] } } }, root_module: { resources: configs } } };
}

for (const [operation, action, total] of [['deploy', 'create', 'create'], ['followup', 'no-op', 'noChange'], ['destroy', 'delete', 'delete']]) {
  test(`synthetic ${operation} plan fixture satisfies the full AzureRM 5.4 policy and parent-ID DNS-link contract`, () => {
    const f = fixture(operation);
    try {
      // Check the synthetic plan directly so fixture drift is localized without
      // exposing errors hidden by the production driver's fail-closed boundary.
      const plan = nativePlan(f.binding, action);
      const summary = summarizePlan(plan, { subscriptionId: f.binding.subscriptionId, participant: f.binding.participant,
        assignment: f.binding.assignment, operation });
      assert.deepEqual(summary.totals, { create: 0, update: 0, delete: 0, replace: 0, noChange: 0, [total]: RESOURCE_ADDRESSES.length });
      const address = 'azurerm_private_dns_zone_virtual_network_link.blob';
      const expressions = plan.configuration.root_module.resources.find(resource => resource.address === address).expressions;
      assert.deepEqual(expressions.private_dns_zone_id, ref('azurerm_private_dns_zone.blob.id'));
      const change = plan.resource_changes.find(resource => resource.address === address).change;
      for (const values of [change.before, change.after].filter(value => value !== null)) {
        assert.equal(values.private_dns_zone_id, resourceIds(f.binding).dnsZone);
        assert.equal(values.id, `${values.private_dns_zone_id}/virtualNetworkLinks/${values.name}`);
        for (const field of ['resource_group_name', 'private_dns_zone_name']) {
          assert.equal(Object.hasOwn(values, field), false);
          assert.equal(Object.hasOwn(expressions, field), false);
        }
      }
    } finally { f.close(); }
  });
}

function adapters(f, { invalidValidation = false, mainSha = SHA, mode = 'plan' } = {}) {
  const calls = [];
  const outputs = {};
  const currentName = LIFECYCLE_JOBS[mode] ?? (mode === 'apply' ? authorization.JOBS.apply : authorization.JOBS.plan);
  const model = { reads: { run: 0, jobs: 0 },
    run: { id: f.context.runId, run_attempt: 1, head_sha: SHA, head_branch: 'main', event: f.context.eventName, status: 'in_progress', conclusion: null,
      repository: { id: ROUTE.id, full_name: ROUTE.repository }, head_repository: { id: ROUTE.id, full_name: ROUTE.repository },
      path: `.github/workflows/${f.binding.operation === 'destroy' ? 'cleanup.yml' : 'delivery.yml'}`,
      actor: structuredClone(f.context.payload.sender), triggering_actor: structuredClone(f.context.payload.sender) },
    jobs: [...Object.values(authorization.JOBS), ...Object.values(LIFECYCLE_JOBS)].map(name => ({ name,
      run_id: f.context.runId, run_attempt: 1, head_sha: SHA, status: name === currentName ? 'in_progress' : 'completed',
      conclusion: name === currentName ? null : 'success', completed_at: name === currentName ? null : new Date(Date.now() - 1000).toISOString() })) };
  const github = { rest: { checks: { listForRef: () => { throw new Error('Use synthetic pagination'); } }, actions: {
    getWorkflowRun: async parameters => {
      assert.deepEqual(parameters, { ...f.context.repo, run_id: f.context.runId });
      model.reads.run += 1; calls.push({ github: RUN_ROUTE, parameters: structuredClone(parameters) });
      return { data: structuredClone(model.runRead ? model.runRead(model.reads.run) : model.run) };
    },
  } }, async paginate(route, parameters) {
    if (typeof route === 'function') return [{ name: 'Workshop quality', app: { id: 15368 }, head_sha: SHA, status: 'completed', conclusion: 'success' }];
    if (route === JOBS_ROUTE) {
      assert.deepEqual(parameters, { ...f.context.repo, run_id: f.context.runId, attempt_number: 1, per_page: 100 });
      assert.ok(model.reads.run > 0, 'Live run metadata must precede the attempt-specific jobs request');
      model.reads.jobs += 1; calls.push({ github: JOBS_ROUTE, parameters: structuredClone(parameters) });
      return structuredClone(model.jobsRead ? model.jobsRead(model.reads.jobs) : model.jobs);
    }
    if (route.endsWith('/artifacts')) return [{ id: 90001, name: f.env.EXPECTED_ARTIFACT, expired: false,
      workflow_run: { id: 910001, repository_id: ROUTE.id, head_repository_id: ROUTE.id, head_sha: SHA, head_branch: 'main' } }];
    throw new Error('An unexpected synthetic GitHub route was requested');
  } };
  return { calls, outputs, model, args: { root: f.root, env: f.env, context: f.context, github, core: { setOutput: (name, value) => { outputs[name] = value; } },
    authorize: async ({ phase, env }) => { calls.push({ authorization: phase }); assert.equal(env.WORKSHOP_APP_SHA256, f.binding.appSha256); return { binding: f.binding, operation: f.binding.operation, mainSha }; },
    deps: { sleep: async () => {}, credentialFactory: () => ({ getToken: async scope => { assert.equal(scope, `${ARM_ORIGIN}/.default`); return { token: 'UNISSUED-INITIAL-RG-READ', expiresOnTimestamp: Date.now() + 300_000 }; } }),
      fetchImpl: async (url, options) => {
        if (new URL(url).origin === ARM_ORIGIN) {
          assert.equal(new URL(url).pathname, resourceIds(f.binding).group); assert.equal(options.headers.authorization, 'Bearer UNISSUED-INITIAL-RG-READ');
          return jsonResponse({ error: { code: 'ResourceGroupNotFound' } }, 404);
        }
        assert.equal(new URL(url).hostname, 'pipelines.actions.githubusercontent.com'); assert.equal(new URL(url).searchParams.get('audience'), 'api://AzureADTokenExchange');
        assert.equal(options.redirect, 'error'); assert.ok(options.headers.authorization.endsWith('synthetic-request-token-not-issued'));
        const phase = f.env.ARM_CLIENT_ID === APPLY ? 'apply' : 'plan';
        return jsonResponse({ value: jwt(f.binding, ENVIRONMENTS[phase], f.profile.oidcSubjects[phase]) });
      },
      spawn: (_executable, args, options) => {
        calls.push({ args, options });
        let stdout = '';
        let status = 0;
        if (args[0] === 'version') stdout = canonicalJson({ terraform_version: '1.16.1' });
        else if (args[0] === 'validate') stdout = canonicalJson({ valid: !invalidValidation, error_count: invalidValidation ? 1 : 0 });
        else if (args[0] === 'plan') { fs.writeFileSync(args.find(arg => arg.startsWith('-out=')).slice(5), BINARY, { mode: 0o600 }); status = f.binding.operation === 'followup' ? 0 : 2; }
        else if (args[0] === 'show') stdout = canonicalJson(args.at(-1).endsWith('.tfplan') ? nativePlan(f.binding, f.binding.operation === 'followup' ? 'no-op' : f.binding.operation === 'destroy' ? 'delete' : 'create') :
          f.binding.operation === 'deploy' ? { format_version: '1.0', values: { root_module: { resources: [] } } } : stateFor(f.binding));
        else assert.ok(['init', 'apply'].includes(args[0]), 'No other native operation is permitted');
        return { status, stdout, stderr: '', signal: null };
      } } } };
}

test('ZIP has stable sorted source + locked production dependencies, regardless of filesystem times', () => {
  const f = fixture();
  try {
    const first = buildPackage({ root: f.root });
    fs.utimesSync(path.join(f.root, 'app/server.mjs'), new Date(0), new Date());
    const second = buildPackage({ root: f.root });
    assert.deepEqual(first.bytes, second.bytes);
    const unpacked = unzipSync(first.bytes);
    assert.ok(unpacked['node_modules/@azure/identity/index.js'] && unpacked['node_modules/express/package.json'] && unpacked['server.mjs']);
    assert.deepEqual(Object.keys(unpacked), Object.keys(unpacked).sort());
    assert.equal(first.bytes.readUInt16LE(10), 0); assert.equal(first.bytes.readUInt16LE(12), 33);
    assert.equal(first.sha256, f.binding.appSha256);
  } finally { f.close(); }
});

for (const name of ['public/.env', 'public/.env.local', 'public/private.pem', 'public/terraform.tfstate', 'public/saved.tfplan']) {
  test(`ZIP rejects ${name}`, () => { const f = fixture(); try { f.put(`app/${name}`, 'SYNTHETIC_FORBIDDEN'); assert.throws(() => buildPackage({ root: f.root })); } finally { f.close(); } });
}
test('ZIP rejects symlinks without requiring Windows symlink privileges', () => {
  const f = fixture(); const original = fs.lstatSync;
  const replacement = mock.method(fs, 'lstatSync', function (file, ...args) {
    const stat = original.call(fs, file, ...args);
    return path.resolve(String(file)) === path.join(f.root, 'app/server.mjs') ? new Proxy(stat, { get(target, key) { return key === 'isSymbolicLink' ? () => true : Reflect.get(target, key); } }) : stat;
  });
  try { assert.throws(() => buildPackage({ root: f.root }), /symlink/); } finally { replacement.mock.restore(); f.close(); }
});
test('ZIP rejects installed package version changes and extraneous dependency directories', () => {
  const f = fixture(); try {
    f.putJson('app/node_modules/express/package.json', { name: 'express', version: '5.3.1' });
    assert.throws(() => buildPackage({ root: f.root }), /version/);
    f.putJson('app/node_modules/express/package.json', { name: 'express', version: '5.3.0' });
    f.put('app/node_modules/untracked/index.js', '');
    assert.throws(() => buildPackage({ root: f.root }), /Untracked/);
  } finally { f.close(); }
});
test('ZIP retains locked Azure SDK credentials source directories but rejects credential data files', () => {
  const f = fixture();
  try {
    const source = 'node_modules/@azure/identity/dist/commonjs/credentials/clientAssertionCredential.js';
    f.put(`app/${source}`, '// synthetic SDK source, not a credential\n');
    assert.ok(unzipSync(buildPackage({ root: f.root }).bytes)[source]);
    f.put('app/node_modules/@azure/identity/dist/commonjs/credentials/secret.json', '{"synthetic":true}');
    assert.throws(() => buildPackage({ root: f.root }), /Credential\/secret data/);
  } finally { f.close(); }
});
test('prepare computes participant/assignment canonically and actual file hashes, never substitutes the owner pin', () => {
  const f = fixture(); try {
    const checked = prepare({ root: f.root, env: f.env });
    assert.equal(checked.env.WORKSHOP_PARTICIPANT_SHA256, hash(canonicalJson(input)));
    assert.equal(checked.env.WORKSHOP_OWNER_PROFILE_SHA256, f.env.WORKSHOP_OWNER_PROFILE_SHA256);
    f.put('infra/main.tf', '# changed after owner pin\n');
    assert.throws(() => prepare({ root: f.root, env: f.env }), /protected owner profile/);
  } finally { f.close(); }
});
test('duplicate participant JSON and changed workflow/profile bytes fail closed before OIDC', () => {
  const f = fixture(); try {
    f.put('exercise/participant.json', '{"participant_name":"alex","participant_name":"eve"}');
    assert.throws(() => prepare({ root: f.root, env: f.env }), /duplicate/);
    f.putJson('exercise/participant.json', input); f.put('.github/workflows/delivery.yml', 'changed workflow');
    assert.throws(() => prepare({ root: f.root, env: f.env }), /workflow bytes/);
    assert.throws(() => prepare({ root: f.root, env: { ...f.env, WORKSHOP_OWNER_PROFILE_SHA256: '0'.repeat(64) } }), /protected variable/);
  } finally { f.close(); }
});

for (const [label, mutate] of [
  ['missing subject pins', f => { delete f.profile.oidcSubjects; }],
  ['missing phase pin', f => { delete f.profile.oidcSubjects.apply; }],
  ['unknown phase pin', f => { f.profile.oidcSubjects.cleanup = f.profile.oidcSubjects.apply; }],
  ['wildcard pin', f => { f.profile.oidcSubjects.plan = `*${f.profile.oidcSubjects.plan}`; }],
  ['wrong environment suffix', f => { f.profile.oidcSubjects.plan = f.profile.oidcSubjects.apply; }],
]) test(`prepare rejects ${label} even with a recomputed owner-profile digest`, () => {
  const f = fixture(); try {
    mutate(f); pinProfile(f);
    assert.throws(() => prepare({ root: f.root, env: f.env }), /OIDC subject/);
  } finally { f.close(); }
});
test('subject changes remain inside the original protected canonical owner-profile digest', () => {
  const f = fixture(); try {
    f.profile.oidcSubjects.plan = `repo:${ROUTE.repository}:environment:workshop-plan`;
    f.env.WORKSHOP_OWNER_PROFILE_JSON = canonicalJson(f.profile);
    assert.throws(() => prepare({ root: f.root, env: f.env }), /protected variable/);
    pinProfile(f);
    assert.equal(prepare({ root: f.root, env: f.env }).profile.oidcSubjects.plan, f.profile.oidcSubjects.plan);
    assert.notEqual(f.binding.ownerProfileSha256, f.env.WORKSHOP_OWNER_PROFILE_SHA256);
  } finally { f.close(); }
});
for (const phase of ['plan', 'apply']) {
  test(`OIDC accepts the exact owner-pinned immutable-ID ${phase} subject`, async () => {
    const f = fixture(); try {
      const profile = prepare({ root: f.root, env: f.env }).profile;
      const environment = ENVIRONMENTS[phase]; const expectedSubject = profile.oidcSubjects[phase];
      const token = jwt(f.binding, environment, expectedSubject);
      assert.equal(validateGitHubJWT(token, { binding: f.binding, environment, expectedSubject }), token);
      assert.equal(await getGitHubJWT({ env: f.env, binding: f.binding, environment, expectedSubject,
        fetchImpl: async () => jsonResponse({ value: token }) }), token);
    } finally { f.close(); }
  });
  test(`OIDC ${phase} never falls back between immutable-ID and explicitly owner-pinned legacy subjects`, () => {
    const f = fixture(); try {
      const environment = ENVIRONMENTS[phase]; const expectedSubject = f.profile.oidcSubjects[phase];
      const immutable = jwt(f.binding, environment, expectedSubject);
      const legacySubject = `repo:${ROUTE.repository}:environment:${environment}`;
      const legacy = jwt(f.binding, environment, legacySubject);
      assert.throws(() => validateGitHubJWT(legacy, { binding: f.binding, environment, expectedSubject }), /claim mismatch/);
      f.profile.oidcSubjects[phase] = legacySubject; pinProfile(f);
      f.binding = validateBinding({ ...f.binding, ownerProfileSha256: f.env.WORKSHOP_OWNER_PROFILE_SHA256 });
      const legacyProfile = prepare({ root: f.root, env: f.env }).profile;
      const options = { binding: f.binding, environment, expectedSubject: legacyProfile.oidcSubjects[phase] };
      assert.equal(validateGitHubJWT(legacy, options), legacy);
      assert.throws(() => validateGitHubJWT(immutable, options), /claim mismatch/);
    } finally { f.close(); }
  });
}
for (const [claim, value] of [['iss', 'https://untrusted.invalid'], ['aud', 'https://management.azure.com'], ['repository', 'outsider/source'], ['repository_id', '123'], ['ref', 'refs/pull/1/merge'],
  ['repository_visibility', 'public'], ['run_id', '910002'], ['run_attempt', '2'], ['sha', 'b'.repeat(40)], ['workflow_ref', 'outsider/source/.github/workflows/delivery.yml@refs/heads/main'],
  ['workflow_sha', 'b'.repeat(40)], ['environment', 'workshop-apply'], ['event_name', 'pull_request'], ['sub', 'repo:wrong/subject:environment:workshop-plan']]) {
  test(`OIDC rejects mismatched ${claim}`, () => { const f = fixture(); try {
    const expectedSubject = f.profile.oidcSubjects.plan;
    assert.throws(() => validateGitHubJWT(jwt(f.binding, ENVIRONMENTS.plan, expectedSubject, { [claim]: value }),
      { binding: f.binding, environment: ENVIRONMENTS.plan, expectedSubject }), /mismatch/);
  } finally { f.close(); } });
}
test('both OIDC APIs require an explicit subject pin before parsing a token or requesting one', async () => {
  const f = fixture(); let contacted = false;
  try {
    const options = { binding: f.binding, environment: ENVIRONMENTS.plan };
    assert.throws(() => validateGitHubJWT(jwt(f.binding, ENVIRONMENTS.plan, f.profile.oidcSubjects.plan), options), /OIDC subject/);
    await assert.rejects(getGitHubJWT({ ...options, env: f.env,
      fetchImpl: async () => { contacted = true; throw new Error('must not fetch'); } }), /OIDC subject/);
    assert.equal(contacted, false);
  } finally { f.close(); }
});
test('OIDC uses the runtime request endpoint and cannot redirect/send its request secret to another host', async () => {
  const f = fixture(); let contacted = false;
  try {
    await assert.rejects(getGitHubJWT({ env: { ...f.env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.invalid/idtoken' }, binding: f.binding, environment: ENVIRONMENTS.plan,
      expectedSubject: f.profile.oidcSubjects.plan,
      fetchImpl: async () => { contacted = true; throw new Error('must not fetch'); } }));
    assert.equal(contacted, false);
    assert.throws(() => validateGitHubJWT(jwt(f.binding, ENVIRONMENTS.plan, f.profile.oidcSubjects.plan, { exp: Math.floor(Date.now() / 1000) - 1 }),
      { binding: f.binding, environment: ENVIRONMENTS.plan, expectedSubject: f.profile.oidcSubjects.plan }), /stale\/future-dated/);
  } finally { f.close(); }
});
test('native init/plan argv bind fixed backend, Entra, leases and attached -out with no shell or unsafe inherited env', async () => {
  const f = fixture(); try {
    const directory = path.resolve(f.root, 'temporary directory with spaces');
    const env = terraformEnvironment({ env: { ...f.env, ARM_ACCESS_KEY: 'UNISSUED', TF_CLI_ARGS: '-lock=false', TF_VAR_sku: 'P1v3', GITHUB_TOKEN: 'UNISSUED', AZURE_CLIENT_SECRET: 'UNISSUED' }, binding: f.binding, clientId: PLAN, token: 'SYNTHETIC-VALIDATED', directory });
    assert.equal(env.ARM_OIDC_TOKEN, 'SYNTHETIC-VALIDATED'); assert.equal(env.ARM_CLIENT_ID, PLAN);
    for (const key of ['ARM_ACCESS_KEY', 'TF_CLI_ARGS', 'TF_VAR_sku', 'GITHUB_TOKEN', 'AZURE_CLIENT_SECRET', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) assert.ok(!Object.hasOwn(env, key));
    const init = initArguments(f.binding);
    assert.ok(init.includes(`-backend-config=key=${f.binding.backend.key}`) && init.includes('-backend-config=use_azuread_auth=true') && init.includes('-lockfile=readonly'));
    assert.ok(!init.some(arg => arg.includes('client_id=') || arg.includes('token=')));
    const args = planArguments(f.binding, path.join(directory, 'saved.tfplan'));
    assert.equal(args.filter(arg => arg.startsWith('-out=')).length, 1);
    assert.equal(args.at(-1), `-out=${path.join(directory, 'saved.tfplan')}`);
    const run = terraformRunner({ directory, env, spawn: (_binary, actual, options) => { assert.deepEqual(actual, args); assert.equal(options.shell, false); assert.ok(!actual.includes('SYNTHETIC-VALIDATED')); return { status: 2, stdout: '', stderr: '' }; } });
    assert.equal((await run(args, [0, 2])).exitCode, 2);
  } finally { f.close(); }
});
test('driver rejects an unpinned legacy subject before any native operation and scrubs its session', async () => {
  const f = fixture(); const a = adapters(f);
  try {
    a.args.deps.fetchImpl = async () => jsonResponse({ value: jwt(f.binding, ENVIRONMENTS.plan, `repo:${ROUTE.repository}:environment:workshop-plan`) });
    await assert.rejects(workflowMain('plan', a.args), /failed closed/);
    assert.ok(!a.calls.some(call => call.args) && !a.outputs.result);
    assert.equal(fs.existsSync(path.join(f.root, '.work/delivery/session.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.work/delivery/sealed')), false);
  } finally { f.close(); }
});
test('driver refuses subjects from a profile digest different from its admission binding before OIDC', async () => {
  const f = fixture(); const a = adapters(f); let contacted = false;
  try {
    f.profile.oidcSubjects.plan = `repo:${ROUTE.repository}:environment:workshop-plan`; pinProfile(f);
    a.args.deps.fetchImpl = async () => { contacted = true; throw new Error('must not fetch'); };
    await assert.rejects(workflowMain('plan', a.args), /failed closed/);
    assert.equal(contacted, false); assert.ok(!a.calls.some(call => call.args) && !a.outputs.result);
  } finally { f.close(); }
});

test('driver performs native validate THEN saved plan and seals only ciphertext; apply uses that binary without replanning', async () => {
  const f = fixture(); const a = adapters(f);
  try {
    const planned = await workflowMain('plan', a.args);
    const native = a.calls.filter(call => call.args);
    assert.deepEqual(native.map(call => call.args[0]), ['version', 'init', 'validate', 'show', 'plan', 'show']);
    const ciphertext = fs.readFileSync(path.join(f.root, '.work/delivery/sealed/plan.enc'));
    assert.equal(hash(ciphertext), planned.envelope_sha256); assert.ok(!ciphertext.includes(BINARY));
    assert.equal(fs.existsSync(native[0].options.cwd), false, 'Plaintext session must be removed in finally');
    assert.equal(fs.existsSync(path.join(f.root, '.work/delivery/session.json')), false);
    Object.assign(f.env, { ARM_CLIENT_ID: APPLY, EXPECTED_ARTIFACT: planned.artifact, EXPECTED_PLAN_HASH: planned.plan_sha256, EXPECTED_MANIFEST_HASH: planned.manifest_sha256,
      EXPECTED_ENVELOPE_HASH: planned.envelope_sha256, PLAN_DECRYPTION_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const appliedAdapter = adapters(f);
    assert.equal((await workflowMain('apply', appliedAdapter.args)).result, 'applied');
    const applied = appliedAdapter.calls.filter(call => call.args);
    assert.deepEqual(applied.map(call => call.args[0]), ['version', 'init', 'show', 'apply']);
    assert.ok(path.isAbsolute(applied.at(-1).args.at(-1)) && applied.at(-1).args.at(-1).endsWith('saved.tfplan'));
    assert.equal(fs.existsSync(applied[0].options.cwd), false);
    f.put('.work/keep-owner-cache', 'retain'); clean({ root: f.root, env: f.env });
    assert.equal(fs.existsSync(path.join(f.root, '.work/delivery')), false);
    assert.equal(fs.readFileSync(path.join(f.root, '.work/keep-owner-cache'), 'utf8'), 'retain');
  } finally { f.close(); }
});
test('validation failure scrubs session, never plans, never publishes a success result', async () => {
  const f = fixture(); const a = adapters(f, { invalidValidation: true });
  try {
    await assert.rejects(workflowMain('plan', a.args), /failed closed/);
    assert.ok(!a.calls.some(call => call.args?.[0] === 'plan')); assert.ok(!a.outputs.result);
    assert.equal(fs.existsSync(a.calls.find(call => call.options)?.options.cwd), false);
  } finally { f.close(); }
});
test('real authorization rejection invokes no OIDC, SDK or native subprocess adapter', async () => {
  const f = fixture(); const a = adapters(f);
  try {
    a.args.authorize = authorization.authorize;
    a.args.env = { ...f.env, WORKSHOP_AZURE_ENABLED: 'false' };
    a.args.deps.fetchImpl = async () => { throw new Error('OIDC MUST NOT BE REQUESTED'); };
    await assert.rejects(workflowMain('plan', a.args), /failed closed/);
    assert.equal(a.calls.length, 0); assert.ok(!a.outputs.result);
    assert.equal(fs.existsSync(path.join(f.root, '.work/delivery/session.json')), false);
  } finally { f.close(); }
});
for (const fault of ['ciphertext', 'manifest', 'main', 'subject-pin']) test(`saved-plan apply rejects ${fault} mismatch and emits no applied/deployed marker`, async () => {
  const f = fixture(); try {
    const result = await workflowMain('plan', adapters(f).args);
    Object.assign(f.env, { ARM_CLIENT_ID: APPLY, EXPECTED_ARTIFACT: result.artifact, EXPECTED_PLAN_HASH: result.plan_sha256,
      EXPECTED_MANIFEST_HASH: fault === 'manifest' ? '0'.repeat(64) : result.manifest_sha256, EXPECTED_ENVELOPE_HASH: result.envelope_sha256,
      PLAN_DECRYPTION_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    if (fault === 'ciphertext') { const file = path.join(f.root, '.work/delivery/sealed/plan.enc'); const bytes = fs.readFileSync(file); bytes[50] ^= 1; fs.writeFileSync(file, bytes); }
    if (fault === 'subject-pin') {
      f.profile.oidcSubjects.apply = `repo:${ROUTE.repository}:environment:workshop-apply`; pinProfile(f);
      f.binding = validateBinding({ ...f.binding, ownerProfileSha256: f.env.WORKSHOP_OWNER_PROFILE_SHA256 });
    }
    const a = adapters(f, { mainSha: fault === 'main' ? 'b'.repeat(40) : SHA });
    await assert.rejects(workflowMain('apply', a.args), /failed closed/);
    assert.ok(!a.calls.some(call => call.args?.[0] === 'apply') && !a.outputs.result);
    assert.equal(fs.existsSync(a.calls.find(call => call.options)?.options.cwd), false);
  } finally { f.close(); }
});
test('envelope roundtrip authenticates whole run/assignment/package binding, digests and maximum age', () => {
  const f = fixture(); try {
    const now = Date.now(); const manifest = makeManifest(f.binding, BINARY, { now, exitCode: 2 });
    const bytes = Buffer.from(canonicalJson(manifest));
    const opened = openPlan(sealPlan(BINARY, bytes, keys.publicKey), keys.privateKey);
    const proof = { manifest: opened.manifest, manifestBytes: opened.manifestBytes, planBytes: opened.plan, binding: f.binding,
      expectedPlanHash: hash(BINARY), expectedManifestHash: hash(bytes), currentSha: SHA, now };
    assert.equal(verifyPlan(proof), true);
    assert.throws(() => verifyPlan({ ...proof, binding: { ...f.binding, runId: '910002' } }), /binding changed/);
    assert.throws(() => verifyPlan({ ...proof, now: now + 7_200_001 }), /stale/);
    opened.plan.fill(0); opened.manifestBytes.fill(0);
  } finally { f.close(); }
});

function snapshot(binding) {
  const ids = resourceIds(binding);
  const plan = nativePlan(binding);
  const tags = plan.resource_changes[0].change.after.tags;
  const resource = (id, type, properties = {}, options = {}) => ({ id, type, location: binding.assignment.location, tags, properties: { provisioningState: 'Succeeded', ...properties }, ...options });
  const nicId = `${ids.group}/providers/Microsoft.Network/networkInterfaces/owned-endpoint-nic`;
  const pe = resource(ids.privateEndpoint, 'Microsoft.Network/privateEndpoints', { subnet: { id: ids.endpointSubnet }, networkInterfaces: [{ id: nicId }],
    privateLinkServiceConnections: [{ name: ids.names.privateEndpoint, properties: { privateLinkServiceId: ids.storage, groupIds: ['blob'], privateLinkServiceConnectionState: { status: 'Approved' } } }] });
  const s = {
    group: resource(ids.group, 'Microsoft.Resources/resourceGroups'),
    vnet: resource(ids.vnet, 'Microsoft.Network/virtualNetworks', { addressSpace: { addressPrefixes: ['10.80.21.0/24'] }, virtualNetworkPeerings: [] }),
    nsg: resource(ids.nsg, 'Microsoft.Network/networkSecurityGroups', { securityRules: [] }),
    servicePlan: resource(ids.servicePlan, 'Microsoft.Web/serverfarms', { reserved: true }, { sku: { name: 'B1', tier: 'Basic', capacity: 1 } }),
    webApp: resource(ids.webApp, 'Microsoft.Web/sites', { serverFarmId: ids.servicePlan, virtualNetworkSubnetId: ids.appSubnet, httpsOnly: true, publicNetworkAccess: 'Enabled', enabled: true, state: 'Running', vnetRouteAllEnabled: false,
      defaultHostName: 'actual-azure-host.southeastasia-01.azurewebsites.net', enabledHostNames: ['actual-azure-host.southeastasia-01.azurewebsites.net', 'actual-azure-host.scm.southeastasia-01.azurewebsites.net'] },
      { kind: 'app,linux', identity: { type: 'UserAssigned', userAssignedIdentities: { [binding.assignment.app_identity_id]: {} } } }),
    webConfig: resource(`${ids.webApp}/config/web`, 'Microsoft.Web/sites/config', { alwaysOn: true, http20Enabled: true, minTlsVersion: '1.2', scmMinTlsVersion: '1.2', ftpsState: 'Disabled', appCommandLine: 'npm start', vnetRouteAllEnabled: false,
      remoteDebuggingEnabled: false, ipSecurityRestrictionsDefaultAction: 'Deny', scmIpSecurityRestrictionsDefaultAction: 'Deny', scmIpSecurityRestrictionsUseMain: true, linuxFxVersion: 'NODE|24-lts',
      ipSecurityRestrictions: [{ name: 'approved-workshop-network', action: 'Allow', priority: 100, ipAddress: binding.assignment.allowed_web_cidr }], scmIpSecurityRestrictions: [] }),
    settings: resource(`${ids.webApp}/config/appsettings`, 'Microsoft.Web/sites/config', plan.resource_changes.find(item => item.type === 'azurerm_linux_web_app').change.after.app_settings),
    ftpPolicy: resource(`${ids.webApp}/basicPublishingCredentialsPolicies/ftp`, 'Microsoft.Web/sites/basicPublishingCredentialsPolicies', { allow: false }),
    scmPolicy: resource(`${ids.webApp}/basicPublishingCredentialsPolicies/scm`, 'Microsoft.Web/sites/basicPublishingCredentialsPolicies', { allow: false }),
    storage: resource(ids.storage, 'Microsoft.Storage/storageAccounts', { accessTier: 'Hot', minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true, allowSharedKeyAccess: false, allowBlobPublicAccess: false,
      publicNetworkAccess: 'Disabled', defaultToOAuthAuthentication: true, allowCrossTenantReplication: false, isHnsEnabled: false, isSftpEnabled: false, isLocalUserEnabled: false,
      privateEndpointConnections: [{ id: `${ids.storage}/privateEndpointConnections/owned-generated`, properties: { privateEndpoint: { id: ids.privateEndpoint }, privateLinkServiceConnectionState: { status: 'Approved' } } }] }, { kind: 'StorageV2', sku: { name: 'Standard_LRS' } }),
    container: resource(ids.container, 'Microsoft.Storage/storageAccounts/blobServices/containers', { publicAccess: 'None' }), privateEndpoint: pe,
    dnsZone: resource(ids.dnsZone, 'Microsoft.Network/privateDnsZones', {}, { location: 'global' }),
    dnsLink: resource(ids.dnsLink, 'Microsoft.Network/privateDnsZones/virtualNetworkLinks', { virtualNetwork: { id: ids.vnet }, registrationEnabled: false }, { location: 'global' }),
    dnsGroups: [resource(ids.dnsGroup, 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups', { privateDnsZoneConfigs: [{ properties: { privateDnsZoneId: ids.dnsZone } }] })],
    dnsRecords: [resource(`${ids.dnsZone}/SOA/@`, 'Microsoft.Network/privateDnsZones/SOA'), resource(`${ids.dnsZone}/A/${ids.names.storage}`, 'Microsoft.Network/privateDnsZones/A', { aRecords: [{ ipv4Address: '10.80.21.68' }], ttl: 10 })],
    nics: [resource(nicId, 'Microsoft.Network/networkInterfaces', { privateEndpoint: { id: ids.privateEndpoint }, ipConfigurations: [{ properties: { privateIPAddress: '10.80.21.68', subnet: { id: ids.endpointSubnet } } }] })],
  };
  delete s.settings.properties.provisioningState;
  for (const [key, app] of [['appSubnet', true], ['endpointSubnet', false]]) s[key] = resource(ids[key], 'Microsoft.Network/virtualNetworks/subnets', {
    addressPrefix: app ? '10.80.21.0/26' : '10.80.21.64/27', defaultOutboundAccess: false, privateEndpointNetworkPolicies: app ? 'Enabled' : 'Disabled', privateLinkServiceNetworkPolicies: 'Enabled', networkSecurityGroup: { id: ids.nsg },
    delegations: app ? [{ name: 'app-service', properties: { serviceName: 'Microsoft.Web/serverFarms', actions: ['Microsoft.Network/virtualNetworks/subnets/action'] } }] : [] });
  return s;
}

function stateFor(binding) { const plan = nativePlan(binding); return { format_version: '1.0', terraform_version: '1.16.1', values: { root_module: { resources: plan.planned_values.root_module.resources } } }; }
function inventory(binding) {
  const s = snapshot(binding); const ids = resourceIds(binding);
  return { binding, state: stateFor(binding), group: s.group,
    resources: ['vnet', 'nsg', 'servicePlan', 'webApp', 'storage', 'privateEndpoint', 'dnsZone'].map(key => s[key]),
    endpoint: s.privateEndpoint, nics: s.nics, dnsRecords: s.dnsRecords, dnsGroups: s.dnsGroups,
    storageConnections: s.storage.properties.privateEndpointConnections, children: [s.appSubnet, s.endpointSubnet, s.container, s.dnsLink, { id: ids.blobService }] };
}

function cloudAdapters(f, mode, { absent = false, foreign = false } = {}) {
  const a = adapters(f, { mode });
  const s = snapshot(f.binding);
  const ids = resourceIds(f.binding);
  const requests = [];
  const packed = buildPackage({ root: f.root });
  const responses = new Map();
  const add = (id, value) => responses.set(id.toLowerCase(), value);
  for (const [key, id] of Object.entries({ group: ids.group, vnet: ids.vnet, appSubnet: ids.appSubnet, endpointSubnet: ids.endpointSubnet, nsg: ids.nsg, servicePlan: ids.servicePlan,
    webApp: ids.webApp, webConfig: `${ids.webApp}/config/web`, ftpPolicy: `${ids.webApp}/basicPublishingCredentialsPolicies/ftp`, scmPolicy: `${ids.webApp}/basicPublishingCredentialsPolicies/scm`,
    storage: ids.storage, container: ids.container, privateEndpoint: ids.privateEndpoint, dnsZone: ids.dnsZone, dnsLink: ids.dnsLink })) add(id, s[key]);
  add(s.nics[0].id, s.nics[0]); add(`${ids.webApp}/config/appsettings/list`, s.settings);
  add(`${ids.privateEndpoint}/privateDnsZoneGroups`, { value: s.dnsGroups }); add(`${ids.dnsZone}/recordsets`, { value: s.dnsRecords });
  const owned = inventory(f.binding);
  add(`${ids.group}/resources`, { value: [...owned.resources, ...s.nics, ...(foreign ? [{ id: `${ids.group}/providers/Microsoft.Compute/virtualMachines/unrelated` }] : [])] });
  add(`${ids.vnet}/subnets`, { value: [s.appSubnet, s.endpointSubnet] });
  add(`${ids.dnsZone}/virtualNetworkLinks`, { value: [s.dnsLink] });
  add(`${ids.blobService}/containers`, { value: [s.container] });
  add(`${ids.storage}/privateEndpointConnections`, { value: s.storage.properties.privateEndpointConnections });
  add(`${ids.webApp}/hostNameBindings`, { value: [{ id: `${ids.webApp}/hostNameBindings/${s.webApp.properties.defaultHostName}`, type: 'Microsoft.Web/sites/hostNameBindings', properties: { sslState: 'Disabled' } }] });
  for (const service of ['blobServices', 'fileServices', 'queueServices', 'tableServices']) add(`${ids.storage}/${service}`, { value: [{ id: `${ids.storage}/${service}/default` }] });
  for (const route of [`${ids.vnet}/virtualNetworkPeerings`, `${ids.nsg}/securityRules`, `${ids.webApp}/slots`, `${ids.webApp}/siteextensions`, `${ids.webApp}/hybridconnectionrelays`,
    ...['fileServices/default/shares', 'queueServices/default/queues', 'tableServices/default/tables', 'localUsers', 'managementPolicies'].map(child => `${ids.storage}/${child}`)]) add(route, { value: [] });
  a.args.deps.credentialFactory = () => {
    assert.ok(a.calls.some(call => call.authorization), 'Authorization must precede SDK credential creation');
    return { getToken: async scope => { assert.equal(scope, `${ARM_ORIGIN}/.default`); return { token: 'UNISSUED-SCOPED-ARM', expiresOnTimestamp: Date.now() + 300_000 }; } };
  };
  const originalFetch = a.args.deps.fetchImpl;
  a.args.deps.fetchImpl = async (url, options) => {
    const target = new URL(url); requests.push({ url: target, method: options.method, body: options.body });
    if (target.hostname === 'pipelines.actions.githubusercontent.com') return originalFetch(url, options);
    assert.equal(options.redirect, 'error');
    if (target.origin === ARM_ORIGIN) {
      assert.equal(options.headers.authorization, 'Bearer UNISSUED-SCOPED-ARM');
      assert.ok(target.pathname.toLowerCase().startsWith(ids.group.toLowerCase()));
      if (absent) { assert.equal(target.pathname, ids.group); return jsonResponse({ error: { code: 'ResourceGroupNotFound' } }, 404); }
      if (options.method === 'POST') { assert.equal(target.pathname, `${ids.webApp}/config/appsettings/list`); assert.equal(options.body, '{}'); }
      assert.ok(responses.has(target.pathname.toLowerCase()), `Unexpected fixture ARM route: ${target.pathname}`);
      return jsonResponse(responses.get(target.pathname.toLowerCase()));
    }
    if (target.hostname.includes('.scm.')) {
      assert.equal(options.headers.authorization, 'Bearer UNISSUED-SCOPED-ARM');
      if (target.pathname === '/api/deployments') return jsonResponse([]);
      if (target.pathname === '/api/zipdeploy') { assert.equal(options.method, 'POST'); assert.equal(hash(options.body), f.binding.appSha256); return new Response('', { status: 202, headers: { location: '/api/deployments/fixture-deployment' } }); }
      if (target.pathname === '/api/deployments/fixture-deployment') return jsonResponse({ id: 'fixture-deployment', status: 4, complete: true, active: true, received_time: new Date().toISOString() });
      if (target.pathname.endsWith('/packagename.txt')) return new Response('fixture.zip\n');
      if (target.pathname.endsWith('/fixture.zip')) return new Response(packed.bytes);
      throw new Error('Unreviewed fixture SCM route');
    }
    assert.equal(target.hostname, s.webApp.properties.defaultHostName); assert.ok(!options.headers.authorization);
    assert.ok(['/healthz', '/health/storage'].includes(target.pathname));
    return jsonResponse({ status: 'ok', ...(target.pathname === '/healthz' ? { service: 'ws2-welcome' } : {}) });
  };
  const originalSpawn = a.args.deps.spawn;
  a.args.deps.spawn = (executable, args, options) => {
    if (args[0] === 'show' && !args.at(-1).endsWith('.tfplan')) {
      a.calls.push({ args, options });
      return { status: 0, stdout: canonicalJson(absent ? { format_version: '1.0', values: { root_module: { resources: [] } } } : stateFor(f.binding)), stderr: '' };
    }
    return originalSpawn(executable, args, options);
  };
  return { ...a, requests };
}

function lifecycleFixture(mode) {
  const f = fixture(mode === 'followup' ? 'followup' : mode === 'verify-absence' ? 'destroy' : 'deploy');
  if (['package-deploy', 'verify-deployed'].includes(mode)) f.env.ARM_CLIENT_ID = APPLY;
  const a = mode === 'followup' ? adapters(f, { mode }) : cloudAdapters(f, mode, { absent: mode === 'verify-absence' });
  return { f, a };
}

for (const mode of Object.keys(LIFECYCLE_JOBS)) for (const omitted of [false, true]) {
  test(`${mode} admits ${omitted ? 'omitted' : 'explicit first'} job attempts only through bracketed same-run attempt-one GETs`, async () => {
    const { f, a } = lifecycleFixture(mode);
    try {
      if (omitted) for (const job of a.model.jobs) delete job.run_attempt;
      const expected = mode === 'followup' ? 'no-change' : mode === 'verify-absence' ? 'absent' : 'deployed';
      assert.equal((await workflowMain(mode, a.args)).result, expected);
      assert.equal(a.outputs.result, expected);
      assert.ok(a.model.reads.jobs >= 2, 'Extra lifecycle work needs admission before and after completion');
      assert.equal(a.model.reads.run, a.model.reads.jobs * 2);
      const metadata = a.calls.filter(call => call.github);
      for (let index = 0; index < metadata.length; index += 1) {
        if (metadata[index].github !== JOBS_ROUTE) continue;
        assert.deepEqual(metadata[index].parameters, { ...f.context.repo, run_id: f.context.runId, attempt_number: 1, per_page: 100 });
        for (const neighbor of [metadata[index - 1], metadata[index + 1]]) {
          assert.equal(neighbor?.github, RUN_ROUTE);
          assert.deepEqual(neighbor.parameters, { ...f.context.repo, run_id: f.context.runId });
        }
      }
      assert.ok(a.model.jobs.every(job => Object.hasOwn(job, 'run_attempt') === !omitted));
    } finally { f.close(); }
  });
}
const lifecycleRejections = [
  ['prerequisite job attempt two', a => { a.model.jobs.find(job => job.name === authorization.JOBS.validation).run_attempt = 2; }, 1],
  ['active job attempt two', (a, mode) => { a.model.jobs.find(job => job.name === LIFECYCLE_JOBS[mode]).run_attempt = 2; }, 1],
  ['an unrelated populated contradictory attempt', a => { a.model.jobs.push({ name: 'Unrelated queued job', run_id: 910001, run_attempt: 2, head_sha: SHA, status: 'queued', conclusion: null }); }, 1],
  ['different prerequisite run', a => { a.model.jobs.find(job => job.name === authorization.JOBS.validation).run_id += 1; }, 1],
  ['different active job run', (a, mode) => { a.model.jobs.find(job => job.name === LIFECYCLE_JOBS[mode]).run_id += 1; }, 1],
  ['different active job SHA', (a, mode) => { a.model.jobs.find(job => job.name === LIFECYCLE_JOBS[mode]).head_sha = 'b'.repeat(40); }, 1],
  ['failed prerequisite', a => { a.model.jobs.find(job => job.name === authorization.JOBS.validation).conclusion = 'failure'; }, 1],
  ['inactive lifecycle job', (a, mode) => { a.model.jobs.find(job => job.name === LIFECYCLE_JOBS[mode]).status = 'completed'; }, 1],
  ['missing prerequisite', a => { a.model.jobs = a.model.jobs.filter(job => job.name !== authorization.JOBS.validation); }, 1],
  ['renamed active job', (a, mode) => { a.model.jobs.find(job => job.name === LIFECYCLE_JOBS[mode]).name += ' copy'; }, 1],
  ['duplicate active job', (a, mode) => { a.model.jobs.push(structuredClone(a.model.jobs.find(job => job.name === LIFECYCLE_JOBS[mode]))); }, 1],
  ['initial live run attempt two', a => { a.model.run.run_attempt = 2; }, 0],
  ['final live run attempt two', a => { a.model.runRead = count => count === 1 ? a.model.run : { ...a.model.run, run_attempt: 2 }; }, 1],
  ['initial different live run', a => { a.model.run.id += 1; }, 0],
  ['final different live run', a => { a.model.runRead = count => count === 1 ? a.model.run : { ...a.model.run, id: a.model.run.id + 1 }; }, 1],
  ['unbound requested run', (_a, _mode, f) => { f.context.runId += 1; }, 0],
];
for (const mode of Object.keys(LIFECYCLE_JOBS)) for (const [label, mutate, jobReads] of lifecycleRejections) {
  test(`${mode} rejects ${label} despite omitted job-attempt fields before any runtime work`, async () => {
    const { f, a } = lifecycleFixture(mode);
    try {
      for (const job of a.model.jobs) delete job.run_attempt;
      mutate(a, mode, f);
      await assert.rejects(workflowMain(mode, a.args), /failed closed/);
      assert.equal(a.model.reads.jobs, jobReads);
      assert.equal(a.requests?.length ?? 0, 0);
      assert.ok(!a.calls.some(call => call.args) && !a.outputs.result);
    } finally { f.close(); }
  });
}
for (const mode of Object.keys(LIFECYCLE_JOBS)) for (const [label, mutate] of [
  ['live rerun', a => { a.model.run.run_attempt = 2; }],
  ['different live run', a => { a.model.run.id += 1; }],
  ['contradictory active job attempt', (a, currentMode) => { a.model.jobs.find(job => job.name === LIFECYCLE_JOBS[currentMode]).run_attempt = 2; }],
]) {
  test(`${mode} withholds success when ${label} appears after its runtime work`, async () => {
    const { f, a } = lifecycleFixture(mode); let workCompleted = false;
    try {
      for (const job of a.model.jobs) delete job.run_attempt;
      const complete = () => { workCompleted = true; mutate(a, mode); };
      if (mode === 'followup') {
        const spawn = a.args.deps.spawn;
        a.args.deps.spawn = (executable, args, options) => {
          const result = spawn(executable, args, options);
          if (args[0] === 'show' && args.at(-1).endsWith('.tfplan')) complete();
          return result;
        };
      } else {
        const fetchImpl = a.args.deps.fetchImpl;
        a.args.deps.fetchImpl = async (url, options) => {
          const response = await fetchImpl(url, options);
          const target = new URL(url);
          if (mode === 'verify-absence' ? target.origin === ARM_ORIGIN && target.pathname === resourceIds(f.binding).group :
            target.pathname === '/health/storage') complete();
          return response;
        };
      }
      await assert.rejects(workflowMain(mode, a.args), /failed closed/);
      assert.equal(workCompleted, true, 'The regression must reach the successful synthetic work, then fail fresh admission');
      assert.ok(!a.outputs.result);
    } finally { f.close(); }
  });
}

test('synthetic package/deploy driver uses the actual ARM-attested SCM host, OIDC bearer ZIP bytes, mounted hash and both runtime probes', async () => {
  const f = fixture(); f.env.ARM_CLIENT_ID = APPLY;
  const a = cloudAdapters(f, 'package-deploy');
  try {
    const result = await workflowMain('package-deploy', a.args);
    assert.equal(result.result, 'deployed'); assert.equal(result.package_sha256, f.binding.appSha256);
    assert.equal(a.requests.filter(request => request.url.pathname === '/api/zipdeploy').length, 1);
    assert.ok(a.requests.some(request => request.url.pathname === '/health/storage'));
    assert.ok(a.requests.every(request => !/publishprofile|ftp|listkeys/i.test(request.url.pathname) || request.url.pathname.endsWith('/basicPublishingCredentialsPolicies/ftp')));
    assert.ok(!a.calls.some(call => call.args), 'Package deployment does not execute a shell/Azure CLI/Terraform fallback');
    const verified = cloudAdapters(f, 'verify-deployed');
    assert.equal((await workflowMain('verify-deployed', verified.args)).result, 'deployed');
    assert.ok(!verified.requests.some(request => request.url.pathname === '/api/zipdeploy'), 'Verification must not upload/redeploy');
  } finally { f.close(); }
});
test('synthetic cleanup inventory enumerates child collections and refuses an unrelated resource without native apply', async () => {
  const f = fixture('destroy');
  try {
    const owned = cloudAdapters(f, 'cleanup-inventory');
    assert.equal((await workflowMain('cleanup-inventory', owned.args)).result, 'owned');
    assert.ok(owned.requests.some(request => request.url.pathname.endsWith('/recordsets')));
    assert.ok(owned.requests.some(request => request.url.pathname.endsWith('/fileServices/default/shares')));
    const foreign = cloudAdapters(f, 'cleanup-inventory', { foreign: true });
    await assert.rejects(workflowMain('cleanup-inventory', foreign.args), /failed closed/);
    assert.ok(!foreign.calls.some(call => ['plan', 'apply'].includes(call.args?.[0])) && !foreign.outputs.result);
  } finally { f.close(); }
});
test('synthetic final driver proves empty native state and known RG absence, preserving backend/identity scope', async () => {
  const f = fixture('destroy'); const a = cloudAdapters(f, 'verify-absence', { absent: true });
  try {
    assert.equal((await workflowMain('verify-absence', a.args)).result, 'absent');
    const armReads = a.requests.filter(request => request.url.origin === ARM_ORIGIN);
    assert.equal(armReads.length, 1); assert.equal(armReads[0].url.pathname, resourceIds(f.binding).group);
    assert.ok(!a.calls.some(call => call.args?.[0] === 'apply'));
  } finally { f.close(); }
});
test('synthetic dedicated cleanup seals and applies its exact destroy binary only after full native inventory in both phases', async () => {
  const f = fixture('destroy');
  try {
    const p = cloudAdapters(f, 'plan');
    const planned = await workflowMain('plan', p.args);
    assert.ok(planned.artifact.endsWith('-destroy'));
    const planning = p.calls.filter(call => call.args?.[0] === 'plan');
    assert.equal(planning.length, 1); assert.ok(planning[0].args.includes('-destroy'));
    Object.assign(f.env, { ARM_CLIENT_ID: APPLY, EXPECTED_ARTIFACT: planned.artifact, EXPECTED_PLAN_HASH: planned.plan_sha256,
      EXPECTED_MANIFEST_HASH: planned.manifest_sha256, EXPECTED_ENVELOPE_HASH: planned.envelope_sha256,
      PLAN_DECRYPTION_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    const a = cloudAdapters(f, 'apply');
    assert.equal((await workflowMain('apply', a.args)).result, 'destroyed');
    assert.ok(a.requests.some(request => request.url.pathname.endsWith('/resources')));
    assert.ok(a.calls.some(call => call.args?.[0] === 'apply' && call.args.at(-1).endsWith('saved.tfplan')));
    assert.ok(!a.calls.some(call => ['plan', 'destroy'].includes(call.args?.[0])));
  } finally { f.close(); }
});
test('synthetic followup obtains a native zero-change plan and never creates an applicable artifact', async () => {
  const f = fixture('followup'); const a = adapters(f);
  try {
    const result = await workflowMain('plan', a.args);
    assert.equal(result.exitcode, '0'); assert.equal(result.result, 'no-change');
    assert.ok(!result.artifact && !fs.existsSync(path.join(f.root, '.work/delivery/sealed')));
    assert.ok(!a.calls.some(call => call.args?.[0] === 'apply'));
  } finally { f.close(); }
});

test('actual ARM readback accepts only the full scoped topology and uses returned regional hostname', () => {
  const f = fixture(); try {
    const result = validateReadback(snapshot(f.binding), f.binding);
    assert.equal(result.defaultHostName, 'actual-azure-host.southeastasia-01.azurewebsites.net');
    assert.equal(result.scmHostName, 'actual-azure-host.scm.southeastasia-01.azurewebsites.net');
  } finally { f.close(); }
});
for (const [label, mutate] of [
  ['storage public', s => { s.storage.properties.publicNetworkAccess = 'Enabled'; }], ['shared keys', s => { s.storage.properties.allowSharedKeyAccess = true; }],
  ['larger plan', s => { s.servicePlan.sku.name = 'P1v3'; }], ['SCM default allow', s => { s.webConfig.properties.scmIpSecurityRestrictionsDefaultAction = 'Allow'; }],
  ['wrong ingress', s => { s.webConfig.properties.ipSecurityRestrictions[0].ipAddress = '0.0.0.0/0'; }], ['delegation', s => { s.appSubnet.properties.delegations = []; }],
  ['foreign PE', s => { s.privateEndpoint.properties.privateLinkServiceConnections[0].properties.privateLinkServiceId += '-foreign'; }], ['wrong DNS', s => { s.dnsRecords[1].properties.aRecords[0].ipv4Address = '10.80.21.69'; }],
  ['foreign RG', s => { s.group.id += '-foreign'; }], ['foreign identity', s => { s.webApp.identity.type = 'SystemAssigned'; }], ['FTP auth', s => { s.ftpPolicy.properties.allow = true; }],
]) test(`readback rejects ${label}`, () => { const f = fixture(); try { const s = snapshot(f.binding); mutate(s); assert.throws(() => validateReadback(s, f.binding)); } finally { f.close(); } });
test('inventory permits only exact state-owned IDs plus bidirectionally correlated PE/DNS children', () => {
  const f = fixture(); try { assert.equal(validateInventory(inventory(f.binding)).status, 'owned'); } finally { f.close(); }
});
for (const fault of ['unknown-resource', 'unknown-dns', 'foreign-nic-backlink', 'foreign-state', 'foreign-storage-connection']) test(`inventory rejects ${fault}`, () => {
  const f = fixture(); try {
    const value = inventory(f.binding);
    if (fault === 'unknown-resource') value.resources.push({ id: `${resourceIds(f.binding).group}/providers/Microsoft.Compute/virtualMachines/unrelated` });
    if (fault === 'unknown-dns') value.dnsRecords.push({ id: `${resourceIds(f.binding).dnsZone}/A/foreign`, properties: { aRecords: [{ ipv4Address: '10.80.21.68' }] } });
    if (fault === 'foreign-nic-backlink') value.nics[0].properties.privateEndpoint.id += '-foreign';
    if (fault === 'foreign-state') value.state.values.root_module.resources[0].values.id += '-foreign';
    if (fault === 'foreign-storage-connection') value.storageConnections[0].properties.privateEndpoint.id += '-foreign';
    assert.throws(() => validateInventory(value));
  } finally { f.close(); }
});
test('ARM pagination is bounded, stays on the exact RG route and sends only the ARM-scoped bearer', async () => {
  const f = fixture(); const visited = []; const ids = resourceIds(f.binding);
  try {
    const credential = { getToken: async scope => { assert.equal(scope, `${ARM_ORIGIN}/.default`); return { token: 'UNISSUED-ARM-FIXTURE', expiresOnTimestamp: Date.now() + 300_000 }; } };
    const arm = createArmClient({ binding: f.binding, credential, fetchImpl: async (url, options) => { visited.push(url); assert.equal(options.headers.authorization, 'Bearer UNISSUED-ARM-FIXTURE');
      return jsonResponse(visited.length === 1 ? { value: [{ id: ids.vnet }], nextLink: `${ARM_ORIGIN}${ids.group}/resources?api-version=${API.resources}&$skiptoken=fixture` } : { value: [{ id: ids.storage }] }); } });
    assert.equal((await arm.list(`${ids.group}/resources`, API.resources)).length, 2); assert.equal(visited.length, 2);
    const foreign = createArmClient({ binding: f.binding, credential, fetchImpl: async () => jsonResponse({ value: [], nextLink: 'https://attacker.invalid/resources?api-version=2021-04-01' }) });
    await assert.rejects(foreign.list(`${ids.group}/resources`, API.resources), /fixed cloud target/);
    const repeated = createArmClient({ binding: f.binding, credential, fetchImpl: async () => jsonResponse({ value: [], nextLink: `${ARM_ORIGIN}${ids.group}/resources?api-version=${API.resources}` }) });
    await assert.rejects(repeated.list(`${ids.group}/resources`, API.resources), /repeated/);
  } finally { f.close(); }
});
test('absence requires a native ResourceGroupNotFound 404 AND empty managed state, never permission failure', async () => {
  const f = fixture('destroy'); try {
    const state = { format_version: '1.0', values: { root_module: { resources: [] } } };
    const credential = { getToken: async () => ({ token: 'UNISSUED', expiresOnTimestamp: Date.now() + 300_000 }) };
    const arm = createArmClient({ binding: f.binding, credential, fetchImpl: async () => jsonResponse({ error: { code: 'ResourceGroupNotFound' } }, 404) });
    assert.equal((await verifyAbsence({ arm, binding: f.binding, state })).status, 'absent');
    await assert.rejects(verifyAbsence({ arm, binding: f.binding, state: stateFor(f.binding) }), /not empty/);
    const denied = createArmClient({ binding: f.binding, credential, fetchImpl: async () => jsonResponse({ error: { code: 'AuthorizationFailed' } }, 403) });
    await assert.rejects(verifyAbsence({ arm: denied, binding: f.binding, state }));
    assert.throws(() => managedState({ format_version: '1.0', values: { root_module: { child_modules: [{}] } } }, f.binding));
  } finally { f.close(); }
});
test('runtime success needs two real read-only 200/ok responses; pending/403 never become success', async () => {
  const target = { defaultHostName: 'actual-azure-host.azurewebsites.net' }; const paths = [];
  const result = await verifyHealth({ target, attempts: 1, fetchImpl: async (url, options) => { paths.push(new URL(url).pathname); assert.equal(options.method, 'GET'); assert.ok(!options.headers.authorization); return jsonResponse({ status: 'ok', ...(url.endsWith('healthz') ? { service: 'ws2-welcome' } : {}) }); } });
  assert.equal(result.storage, 'read-only-200'); assert.deepEqual(paths, ['/healthz', '/health/storage']);
  for (const status of [403, 503]) await assert.rejects(verifyHealth({ target, attempts: 1, fetchImpl: async () => jsonResponse({ status: 'pending' }, status), sleep: async () => {} }), /failed or pending/);
});

test('CLI GitHub adapter supports only bounded scoped GETs, without credential-bearing redirects', async () => {
  const seen = [];
  const github = githubAdapter({ token: 'UNISSUED', fetchImpl: async (url, options) => { seen.push(url); assert.equal(options.redirect, 'error'); return jsonResponse({ check_runs: [] }); } });
  assert.deepEqual(await github.paginate(github.rest.checks.listForRef, { owner: 'fixture', repo: 'fixture', ref: SHA }), []);
  assert.ok(seen[0].startsWith('https://api.github.com/repos/fixture/fixture/'));
  await assert.rejects(github.request('POST /repos/{owner}/{repo}', { owner: 'fixture', repo: 'fixture' }));
});
test('CLI jobs pagination uses the actual attempt-one URL and preserves legitimate job DTO omissions on every page', async () => {
  const pages = [];
  const source = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, name: `Synthetic job ${index + 1}`,
    run_id: 910001, head_sha: SHA, status: 'completed', conclusion: 'success' }));
  const github = githubAdapter({ token: 'UNISSUED', fetchImpl: async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.github.com');
    assert.equal(target.pathname, '/repos/fixture/fixture/actions/runs/910001/attempts/1/jobs');
    assert.equal(target.searchParams.get('per_page'), '100');
    assert.equal(target.searchParams.has('attempt_number'), false, 'Attempt number belongs in the route, not a generic jobs query');
    assert.equal(target.searchParams.has('filter'), false);
    assert.equal(options.redirect, 'error');
    const page = Number(target.searchParams.get('page')); pages.push(page);
    return jsonResponse({ total_count: source.length, jobs: source.slice((page - 1) * 100, page * 100) });
  } });
  const jobs = await github.paginate(JOBS_ROUTE, { owner: 'fixture', repo: 'fixture', run_id: 910001, attempt_number: 1, per_page: 100 });
  assert.deepEqual(jobs, source); assert.deepEqual(pages, [1, 2]);
  assert.ok(jobs.every(job => !Object.hasOwn(job, 'run_attempt')), 'Transport must not fabricate a job-attempt field');
});
test('real admission rejects the new source, public/private ordinary copies, PR events and false/unset flags before OIDC', async () => {
  const f = fixture(); try {
    for (const enabled of [undefined, 'false', 'TRUE']) await assert.rejects(authorization.authorize({ github: {}, context: f.context, core: {}, env: { ...prepare({ root: f.root, env: f.env }).env, WORKSHOP_AZURE_ENABLED: enabled } }), /explicit owner enablement/);
    const unapproved = structuredClone(f.context.payload.repository); unapproved.id = 900000001; unapproved.full_name = 'alvinea28/lab-iac-ws2-terraform-github-actions-azure';
    assert.throws(() => authorization.assertRepository(unapproved), /two immutable/);
    assert.throws(() => authorization.operationFor('pull_request', undefined, f.env.GITHUB_WORKFLOW_REF, ROUTE.repository), /followup-only/);
    assert.throws(() => authorization.operationFor('push', undefined, f.env.GITHUB_WORKFLOW_REF.replace('delivery.yml', 'cleanup.yml'), ROUTE.repository), /separate explicit/);
  } finally { f.close(); }
});

function workflow(file) {
  const source = fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
  const document = parseDocument(source); assert.deepEqual(document.errors, []);
  return { source, value: document.toJS({ maxAliasCount: 1000 }) };
}
test('protected control pins include all executable helpers and root dependency locks, before import/install and even on cleanup paths', () => {
  const pins = controlDigests();
  assert.deepEqual(Object.keys(pins).sort(), [...CONTROL_FILES].sort());
  for (const digest of Object.values(pins)) assert.match(digest, /^[a-f0-9]{64}$/);
  for (const file of ['delivery.yml', 'cleanup.yml']) for (const job of Object.values(workflow(file).value.jobs)) {
    if (job.name === authorization.JOBS.validation) continue;
    const index = job.steps.findIndex(step => step.id === 'controls');
    assert.ok(index > 0, 'Only the pinned checkout may precede the owner control-byte check');
    assert.equal(job.steps[index].env.WORKSHOP_CONTROL_SHA256_JSON, '${{ vars.WORKSHOP_CONTROL_SHA256_JSON }}');
    for (const source of CONTROL_FILES) assert.ok(job.steps[index].with.script.includes(`'${source}'`));
    assert.ok(index < job.steps.findIndex(step => step.with?.script?.includes('workflowMain')));
    for (const step of job.steps) if (step.run?.includes('scripts/delivery.mjs clean')) assert.ok(step.if.includes("steps.controls.outputs.verified == 'true'"), 'A failed byte pin must not execute a modified cleanup driver');
  }
});
test('workflows have only main delivery/followup and dedicated cleanup dispatch; no schedule, auto-destroy or unsafe secret interpolation', () => {
  const delivery = workflow('delivery.yml'); const cleanup = workflow('cleanup.yml');
  assert.deepEqual(Object.keys(delivery.value.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(delivery.value.on.push.branches, ['main']);
  assert.deepEqual(delivery.value.on.workflow_dispatch.inputs.operation.options, ['followup']);
  assert.deepEqual(Object.keys(cleanup.value.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(cleanup.value.on.workflow_dispatch.inputs), ['authorization']);
  for (const { source, value } of [delivery, cleanup]) {
    assert.deepEqual(value.permissions, {}); assert.equal(value.concurrency['cancel-in-progress'], false);
    assert.equal(value.concurrency.group, 'ws2-state-${{ vars.WS2_STATE_LOCK_ID }}');
    assert.equal(value.env.WORKSHOP_OWNER_PROFILE_SHA256, '${{ vars.WORKSHOP_OWNER_PROFILE_SHA256 }}');
    assert.ok(!/pull_request_target:|schedule:|force-unlock|echo\s+['"]?approved/i.test(source));
    assert.equal(value.jobs.preflight.name, authorization.JOBS.preflight);
    assert.equal(value.jobs.validation.name, authorization.JOBS.validation);
    assert.equal(value.jobs.plan.name, authorization.JOBS.plan); assert.equal(value.jobs.apply.name, authorization.JOBS.apply);
    assert.ok(!value.jobs.validation.permissions['id-token'] && !JSON.stringify(value.jobs.validation).includes('${{ secrets.'));
    for (const job of Object.values(value.jobs)) {
      if (job.permissions?.['id-token'] === 'write') { assert.ok(Array.isArray(job['runs-on']) && job['runs-on'].includes('ws2-trusted')); assert.ok(Object.values(ENVIRONMENTS).includes(job.environment)); }
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
        if (step.run) assert.ok(!step.run.includes('${{'), 'No shell interpolation of tokens, inputs, identity or secrets');
        if (step.uses?.startsWith('actions/checkout@')) { assert.equal(step.with.ref, '${{ github.sha }}'); assert.equal(step.with['persist-credentials'], false); }
        if (step.uses?.startsWith('actions/upload-artifact@')) assert.equal(step.with.path, '.work/delivery/sealed/plan.enc');
        if (step.with?.script?.includes('workflowMain')) { assert.ok(step.with.script.includes('authorize: require(\'./scripts/deployment-authorization.cjs\').authorize')); assert.equal(job.permissions.actions, 'read'); assert.equal(job.permissions['pull-requests'], 'read'); assert.equal(job.permissions.checks, 'read'); }
      }
    }
  }
  assert.equal(delivery.value.jobs.package.name, 'Package and deploy workshop app'); assert.equal(delivery.value.jobs.verification.name, 'Verify deployed workshop');
  assert.equal(delivery.value.jobs.followup.name, 'Confirm no-change'); assert.equal(cleanup.value.jobs.final.name, 'Verify workload absence');
  assert.ok(cleanup.value.jobs.plan.steps.some(step => step.name === 'Create encrypted workshop destroy plan'));
  assert.ok(cleanup.value.jobs.apply.steps.some(step => step.name === 'Apply exact authorized workshop destroy plan'));
});
test('outer guards skip new source, dev/PR/public/template/rerun/false/unset without allocating cloud jobs', () => {
  const { value } = workflow('delivery.yml');
  const evaluate = new Function('vars', 'github', 'inputs', 'format', `return (${value.jobs.preflight.if});`);
  const vars = { WORKSHOP_AZURE_ENABLED: 'true', WORKSHOP_RG_CREATION_APPROVED: 'true' };
  const github = { repository_id: String(ROUTE.id), repository: ROUTE.repository, ref: 'refs/heads/main', ref_protected: true, run_attempt: 1,
    workflow_ref: `${ROUTE.repository}/.github/workflows/delivery.yml@refs/heads/main`, event_name: 'push', event: { repository: { private: true, is_template: false, fork: false } } };
  const run = (v, g) => evaluate(v, g, {}, (pattern, repository) => pattern.replace('{0}', repository));
  assert.equal(run(vars, github), true);
  const cases = [ { repository_id: '900000001', repository: 'alvinea28/lab-iac-ws2-terraform-github-actions-azure' }, { ref: 'refs/heads/dev' },
    { event_name: 'pull_request' }, { run_attempt: 2 }, { event: { repository: { private: false, is_template: false, fork: false } } }, { event: { repository: { private: true, is_template: true, fork: false } } } ];
  for (const change of cases) assert.equal(Boolean(run(vars, { ...github, ...change })), false);
  for (const flag of [undefined, 'false', 'TRUE']) assert.equal(Boolean(run({ ...vars, WORKSHOP_AZURE_ENABLED: flag }, github)), false);
});
test('AgentAlvine marker steps occur only AFTER successful real drivers and bind actual digest outputs', () => {
  for (const file of ['delivery.yml', 'cleanup.yml']) for (const job of Object.values(workflow(file).value.jobs)) {
    const index = job.steps.findIndex(step => step.name?.startsWith('AgentAlvine readback root=infra'));
    if (index < 0) continue;
    const marker = job.steps[index];
    assert.ok(marker.if.startsWith('success()') && marker.if.includes('steps.checked.outputs.result'));
    assert.ok(job.steps.slice(0, index).some(step => step.id === 'checked' && step.with?.script?.includes('workflowMain')));
    assert.ok(marker.name.includes('owner=${{ steps.checked.outputs.owner_profile_sha256 }} participant=${{ steps.checked.outputs.participant_sha256 }}'));
    assert.ok(marker.name.endsWith('operation=${{ steps.checked.outputs.operation }} result=${{ steps.checked.outputs.result }}'));
  }
});