import assert from 'node:assert/strict';
import { deriveNames } from './inputs.mjs';
import { canonicalJson, parseStrictJson, RESOURCE_ADDRESSES, validateBinding } from './plan-policy.mjs';

// Importing this module never obtains credentials or contacts Azure. Callers must
// complete fresh GitHub admission before constructing the scoped ARM client.
export const ARM_ORIGIN = 'https://management.azure.com';
export const API = Object.freeze({ group: '2022-09-01', resources: '2021-04-01', network: '2024-05-01', dns: '2018-09-01', web: '2024-04-01', storage: '2023-05-01' });
const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const equal = (left, right, message) => assert.equal(canonicalJson(left), canonicalJson(right), message);
const empty = value => value == null || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && Object.keys(value).length === 0);
const props = value => value?.properties ?? {};
const MAX_RESPONSE = 8 * 1024 * 1024;

export function resourceIds(binding) {
  validateBinding(binding);
  const names = deriveNames(binding.participant);
  const group = `/subscriptions/${binding.subscriptionId}/resourceGroups/${names.resourceGroup}`;
  const id = (type, name) => `${group}/providers/${type}/${name}`;
  const ids = { group, vnet: id('Microsoft.Network/virtualNetworks', names.vnet), nsg: id('Microsoft.Network/networkSecurityGroups', names.nsg),
    servicePlan: id('Microsoft.Web/serverfarms', names.servicePlan), webApp: id('Microsoft.Web/sites', names.webApp),
    storage: id('Microsoft.Storage/storageAccounts', names.storage), privateEndpoint: id('Microsoft.Network/privateEndpoints', names.privateEndpoint),
    dnsZone: id('Microsoft.Network/privateDnsZones', names.dnsZone) };
  ids.appSubnet = `${ids.vnet}/subnets/${names.appSubnet}`;
  ids.endpointSubnet = `${ids.vnet}/subnets/${names.endpointSubnet}`;
  ids.blobService = `${ids.storage}/blobServices/default`;
  ids.container = `${ids.blobService}/containers/${names.container}`;
  ids.dnsLink = `${ids.dnsZone}/virtualNetworkLinks/${names.dnsLink}`;
  ids.dnsGroup = `${ids.privateEndpoint}/privateDnsZoneGroups/${names.dnsGroup}`;
  const keys = ['group', 'vnet', 'appSubnet', 'endpointSubnet', 'nsg', 'appSubnet', 'endpointSubnet', 'servicePlan', 'webApp', 'storage', 'container', 'privateEndpoint', 'dnsZone', 'dnsLink'];
  return { names, ...ids, addresses: Object.fromEntries(RESOURCE_ADDRESSES.map((address, index) => [address, ids[keys[index]]])) };
}

function safeId(value) {
  assert.ok(typeof value === 'string' && /^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[A-Za-z0-9_.()-]+(?:\/providers\/[A-Za-z0-9_.@()/~-]+)?$/i.test(value), 'Malformed workload ARM ID');
  assert.ok(!value.split('/').some(part => part === '.' || part === '..') && !/[?#%\\\x00-\x20]/.test(value), 'Unsafe workload ARM ID');
  return value;
}

export async function boundedBytes(response, maximum = MAX_RESPONSE) {
  const announced = response.headers.get('content-length');
  if (announced !== null) assert.ok(/^\d+$/.test(announced) && Number(announced) <= maximum, 'HTTP response exceeds its limit');
  assert.ok(response.body, 'HTTP response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert.ok(length <= maximum, 'HTTP response exceeds its limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export function createArmClient({ binding, credential, fetchImpl = globalThis.fetch }) {
  const ids = resourceIds(binding);
  function target(value) {
    const url = new URL(value, ARM_ORIGIN);
    assert.ok(url.origin === ARM_ORIGIN && !url.username && !url.password && !url.hash && !/[\\%]/.test(url.pathname), 'ARM request escaped its fixed cloud target');
    assert.ok(same(url.pathname, ids.group) || url.pathname.toLowerCase().startsWith(`${ids.group}/`.toLowerCase()), 'ARM request escaped the assigned workload RG');
    assert.ok(url.searchParams.getAll('api-version').length === 1 && Object.values(API).includes(url.searchParams.get('api-version')), 'Unreviewed ARM API version');
    return url;
  }
  function urlFor(id, apiVersion) {
    if (!same(id, `${ids.group}/resources`)) safeId(id);
    return target(`${id}?api-version=${apiVersion}`);
  }
  async function request(url, { method = 'GET', allow404 = false } = {}) {
    url = target(url);
    assert.ok(method === 'GET' || (method === 'POST' && same(url.pathname, `${ids.webApp}/config/appsettings/list`)), 'Only scoped ARM reads are supported');
    let response;
    try {
      const access = await credential.getToken(`${ARM_ORIGIN}/.default`);
      assert.ok(access?.token && access.expiresOnTimestamp > Date.now() + 30_000, 'ARM access token is not ready');
      response = await fetchImpl(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${access.token}`, accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}) });
    } catch { throw new Error('ARM read failed; no network, identity or policy fallback is permitted'); }
    const bytes = await boundedBytes(response);
    let data;
    try { data = parseStrictJson(bytes, MAX_RESPONSE); }
    catch { throw new Error('ARM returned an invalid bounded JSON response'); }
    if (allow404 && response.status === 404 && same(url.pathname, ids.group)) {
      assert.equal(data.error?.code, 'ResourceGroupNotFound', 'A generic/masked 404 is not workload absence proof');
      return null;
    }
    assert.equal(response.status, 200, 'ARM read was not successful; response bodies are deliberately not logged');
    return data;
  }
  return {
    get: (id, version, options) => request(urlFor(id, version), options),
    settings: () => request(urlFor(`${ids.webApp}/config/appsettings/list`, API.web), { method: 'POST' }),
    async list(id, version) {
      let url = urlFor(id, version);
      const route = url.pathname.toLowerCase();
      const seenLinks = new Set();
      const seenIds = new Set();
      const result = [];
      for (let page = 0; page < 20; page += 1) {
        assert.ok(!seenLinks.has(url.href), 'ARM pagination repeated a page');
        seenLinks.add(url.href);
        const data = await request(url);
        assert.ok(Array.isArray(data.value), 'ARM list did not return a value array');
        for (const resource of data.value) {
          safeId(resource.id);
          const key = resource.id.toLowerCase();
          assert.ok(!seenIds.has(key), 'ARM list returned duplicate resource identities');
          seenIds.add(key); result.push(resource);
        }
        assert.ok(result.length <= 2_000, 'ARM inventory exceeds its bounded scope');
        if (!data.nextLink) return result;
        url = target(data.nextLink);
        assert.equal(url.pathname.toLowerCase(), route, 'ARM pagination changed its inventory route');
        assert.equal(url.searchParams.get('api-version'), version, 'ARM pagination changed API version');
      }
      throw new Error('ARM pagination was not exhausted; inventory is incomplete');
    },
  };
}

export function managedState(state, binding, { allowEmpty = false } = {}) {
  const ids = resourceIds(binding);
  assert.ok(state && /^1\./.test(state.format_version ?? '') && !state.resource_changes, 'Require native Terraform show state JSON, not a plan or raw state');
  const root = state.values?.root_module;
  assert.ok(empty(root?.child_modules), 'Child modules are outside this workload state');
  const resources = root?.resources ?? [];
  assert.ok(Array.isArray(resources) && resources.length <= RESOURCE_ADDRESSES.length, 'Unexpected managed-state size');
  const addresses = new Set();
  const managed = new Set();
  for (const resource of resources) {
    assert.ok(Object.hasOwn(ids.addresses, resource.address) && !addresses.has(resource.address) && resource.mode === 'managed' &&
      resource.provider_name === 'registry.terraform.io/hashicorp/azurerm' && resource.type === resource.address.split('.')[0] &&
      resource.index == null && resource.deposed == null && same(resource.values?.id, ids.addresses[resource.address]), 'Unapproved address, provider, mode or ARM identity in workload state');
    addresses.add(resource.address); managed.add(resource.values.id.toLowerCase());
  }
  assert.ok(allowEmpty || resources.length > 0, 'Workload state is empty; it cannot authorize adoption/deletion');
  if (managed.size > 0) assert.ok(addresses.has('azurerm_resource_group.workshop'), 'The group must be explicitly owned in this state');
  return { addresses, ids: managed, count: resources.length };
}

function ownedTags(value, binding, { current = true } = {}) {
  const expected = { owner: binding.assignment.owner, environment: 'training', cost_center: binding.assignment.cost_center, workshop: 'ws2-iac',
    participant: binding.participant.participant_name, workshop_iteration: binding.participant.workshop_iteration, expires_at: binding.assignment.expires_at };
  if (!current) {
    assert.ok(['01', '02', '03'].includes(value.tags?.workshop_iteration), 'Unknown prior workload iteration');
    expected.workshop_iteration = value.tags.workshop_iteration;
  }
  equal(value.tags, expected, 'Workload ownership/configuration tags changed');
}

function exactResource(value, id, type, binding, { tagged = true, global = false } = {}) {
  assert.ok(value && same(value.id, id) && same(value.type, type), 'ARM read returned the wrong resource identity/type');
  assert.ok(!props(value).provisioningState || props(value).provisioningState === 'Succeeded', 'ARM resource is not ready');
  if (tagged) ownedTags(value, binding);
  if (value.location !== undefined) assert.equal(value.location, global ? 'global' : binding.assignment.location, 'ARM location changed');
}

export function validateEndpointNics(endpoint, nics, binding) {
  const ids = resourceIds(binding);
  assert.ok(same(endpoint?.id, ids.privateEndpoint) && Array.isArray(nics) && nics.length === 1, 'Require exactly the owned endpoint NIC');
  const refs = props(endpoint).networkInterfaces;
  assert.ok(Array.isArray(refs) && refs.length === 1 && same(refs[0].id, nics[0].id), 'Endpoint/NIC forward association changed');
  const nic = nics[0];
  safeId(nic.id);
  assert.ok(nic.id.toLowerCase().startsWith(`${ids.group}/providers/Microsoft.Network/networkInterfaces/`.toLowerCase()) &&
    same(nic.type, 'Microsoft.Network/networkInterfaces') && same(props(nic).privateEndpoint?.id, ids.privateEndpoint), 'NIC is not a correlated platform child of the owned endpoint');
  assert.ok(empty(props(nic).virtualMachine) && props(nic).enableIPForwarding !== true && empty(props(nic).networkSecurityGroup), 'Endpoint NIC has unrelated attachments');
  const configurations = props(nic).ipConfigurations;
  assert.ok(Array.isArray(configurations) && configurations.length === 1, 'Unexpected endpoint NIC configuration');
  const config = props(configurations[0]);
  assert.ok(same(config.subnet?.id, ids.endpointSubnet) && empty(config.publicIPAddress), 'Endpoint NIC escaped its private subnet');
  const ip = config.privateIPAddress;
  assert.ok(typeof ip === 'string' && ip.startsWith(`10.80.${binding.assignment.network_slot}.`) && /^\d+\.\d+\.\d+\.\d+$/.test(ip) &&
    Number(ip.split('.')[3]) >= 68 && Number(ip.split('.')[3]) <= 94, 'Endpoint IP is outside the owner-assigned subnet');
  return { nicId: nic.id, privateIp: ip };
}

function validateDns(records, groups, endpoint, nics, binding) {
  const ids = resourceIds(binding);
  const { privateIp } = validateEndpointNics(endpoint, nics, binding);
  assert.ok(Array.isArray(groups) && groups.length === 1 && same(groups[0].id, ids.dnsGroup), 'Unexpected endpoint private DNS group');
  const configs = props(groups[0]).privateDnsZoneConfigs;
  assert.ok(Array.isArray(configs) && configs.length === 1 && same(props(configs[0]).privateDnsZoneId, ids.dnsZone), 'Endpoint DNS group points outside the workload');
  assert.ok(Array.isArray(records) && records.length === 2, 'Require only the platform SOA and correlated Blob A record');
  const soa = records.find(record => same(record.id, `${ids.dnsZone}/SOA/@`));
  const address = records.find(record => same(record.id, `${ids.dnsZone}/A/${ids.names.storage}`));
  assert.ok(soa && address && same(soa.type, 'Microsoft.Network/privateDnsZones/SOA') && same(address.type, 'Microsoft.Network/privateDnsZones/A'), 'Unknown private DNS child');
  equal(props(address).aRecords, [{ ipv4Address: privateIp }], 'Blob DNS must resolve exactly the correlated endpoint IP');
  assert.ok(Number.isInteger(props(address).ttl) && props(address).ttl > 0, 'Blob DNS TTL is not ready');
}

export function validateReadback(snapshot, binding) {
  const ids = resourceIds(binding);
  const resources = [
    ['group', ids.group, 'Microsoft.Resources/resourceGroups'], ['vnet', ids.vnet, 'Microsoft.Network/virtualNetworks'],
    ['nsg', ids.nsg, 'Microsoft.Network/networkSecurityGroups'], ['servicePlan', ids.servicePlan, 'Microsoft.Web/serverfarms'],
    ['webApp', ids.webApp, 'Microsoft.Web/sites'], ['storage', ids.storage, 'Microsoft.Storage/storageAccounts'],
    ['privateEndpoint', ids.privateEndpoint, 'Microsoft.Network/privateEndpoints'],
    ['dnsZone', ids.dnsZone, 'Microsoft.Network/privateDnsZones'], ['dnsLink', ids.dnsLink, 'Microsoft.Network/privateDnsZones/virtualNetworkLinks'],
    ['appSubnet', ids.appSubnet, 'Microsoft.Network/virtualNetworks/subnets'], ['endpointSubnet', ids.endpointSubnet, 'Microsoft.Network/virtualNetworks/subnets'],
    ['container', ids.container, 'Microsoft.Storage/storageAccounts/blobServices/containers'],
  ];
  for (const [key, id, type] of resources) exactResource(snapshot[key], id, type, binding,
    { tagged: !['appSubnet', 'endpointSubnet', 'container'].includes(key), global: ['dnsZone', 'dnsLink'].includes(key) });
  assert.ok(empty(snapshot.group.managedBy), 'A managed/shared RG is not a disposable workshop group');
  for (const [key, suffix] of [['webConfig', 'config/web'], ['settings', 'config/appsettings'], ['ftpPolicy', 'basicPublishingCredentialsPolicies/ftp'], ['scmPolicy', 'basicPublishingCredentialsPolicies/scm']])
    assert.ok(same(snapshot[key]?.id, `${ids.webApp}/${suffix}`), 'Web child read returned a different resource ID');
  const vnet = props(snapshot.vnet);
  equal(vnet.addressSpace?.addressPrefixes, [`10.80.${binding.assignment.network_slot}.0/24`], 'VNet address space changed');
  assert.ok(empty(vnet.dhcpOptions?.dnsServers) && empty(vnet.virtualNetworkPeerings), 'Unreviewed DNS/peering on the workload VNet');
  for (const [key, app] of [['appSubnet', true], ['endpointSubnet', false]]) {
    const subnet = props(snapshot[key]);
    const prefixes = subnet.addressPrefixes ?? (subnet.addressPrefix ? [subnet.addressPrefix] : []);
    equal(prefixes, [`10.80.${binding.assignment.network_slot}.${app ? '0/26' : '64/27'}`], 'Subnet prefix changed');
    assert.equal(subnet.defaultOutboundAccess, false, 'Default subnet outbound access must remain disabled');
    assert.equal(subnet.privateEndpointNetworkPolicies, app ? 'Enabled' : 'Disabled');
    assert.equal(subnet.privateLinkServiceNetworkPolicies, 'Enabled');
    assert.ok(same(subnet.networkSecurityGroup?.id, ids.nsg) && empty(subnet.routeTable) && empty(subnet.natGateway) && empty(subnet.serviceEndpoints), 'Subnet attachments changed');
    if (app) {
      assert.ok(Array.isArray(subnet.delegations) && subnet.delegations.length === 1 && subnet.delegations[0].name === 'app-service', 'App delegation changed');
      equal(props(subnet.delegations[0]).actions, ['Microsoft.Network/virtualNetworks/subnets/action'], 'App delegation permissions changed');
      assert.equal(props(subnet.delegations[0]).serviceName, 'Microsoft.Web/serverFarms');
      for (const link of subnet.serviceAssociationLinks ?? []) assert.ok(props(link).linkedResourceType === 'Microsoft.Web/serverfarms' && same(props(link).link, ids.servicePlan), 'Unrelated subnet service association');
    } else assert.ok(empty(subnet.delegations) && empty(subnet.serviceAssociationLinks), 'Endpoint subnet must not be delegated');
  }
  assert.ok(empty(props(snapshot.nsg).securityRules), 'Custom NSG rules are outside this profile');
  const plan = props(snapshot.servicePlan);
  assert.equal(snapshot.servicePlan.sku?.name, 'B1'); assert.equal(snapshot.servicePlan.sku?.tier, 'Basic');
  assert.equal(snapshot.servicePlan.sku?.capacity, 1); assert.equal(plan.reserved, true);
  assert.ok(plan.zoneRedundant !== true && plan.perSiteScaling !== true && empty(plan.hostingEnvironmentProfile), 'Service plan no longer matches one Linux B1 worker');
  const web = props(snapshot.webApp);
  assert.ok(snapshot.webApp.kind?.split(',').includes('linux') && same(web.serverFarmId, ids.servicePlan) && same(web.virtualNetworkSubnetId, ids.appSubnet), 'App compute/VNet binding changed');
  assert.equal(web.httpsOnly, true); assert.equal(web.publicNetworkAccess, 'Enabled');
  assert.equal(web.enabled, true); assert.equal(web.state, 'Running'); assert.equal(web.vnetRouteAllEnabled, false);
  assert.equal(snapshot.webApp.identity?.type, 'UserAssigned');
  equal(Object.keys(snapshot.webApp.identity?.userAssignedIdentities ?? {}).map(id => id.toLowerCase()), [binding.assignment.app_identity_id.toLowerCase()], 'App identity changed');
  const site = props(snapshot.webConfig);
  const expectedSite = { alwaysOn: true, http20Enabled: true, minTlsVersion: '1.2', scmMinTlsVersion: '1.2', ftpsState: 'Disabled',
    appCommandLine: 'npm start', vnetRouteAllEnabled: false, remoteDebuggingEnabled: false, ipSecurityRestrictionsDefaultAction: 'Deny',
    scmIpSecurityRestrictionsDefaultAction: 'Deny', scmIpSecurityRestrictionsUseMain: true, linuxFxVersion: 'NODE|24-lts' };
  for (const [key, value] of Object.entries(expectedSite)) assert.equal(site[key], value, 'Web runtime/security configuration changed');
  const rules = site.ipSecurityRestrictions;
  assert.ok(Array.isArray(rules) && rules.length === 1, 'App ingress requires exactly its assigned CIDR rule');
  for (const [key, value] of Object.entries({ name: 'approved-workshop-network', action: 'Allow', priority: 100, ipAddress: binding.assignment.allowed_web_cidr })) assert.equal(rules[0][key], value, 'App ingress rule changed');
  assert.ok(empty(rules[0].headers) && empty(rules[0].vnetSubnetResourceId) && (!rules[0].tag || rules[0].tag === 'Default') && empty(site.scmIpSecurityRestrictions), 'Unreviewed web/SCM ingress selector');
  assert.equal(props(snapshot.ftpPolicy).allow, false); assert.equal(props(snapshot.scmPolicy).allow, false);
  equal(snapshot.settings?.properties, { APP_MESSAGE: binding.participant.app_message, PAGE_THEME: binding.participant.page_theme,
    WORKSHOP_ITERATION: binding.participant.workshop_iteration, STORAGE_ACCOUNT_NAME: ids.names.storage, STORAGE_CONTAINER_NAME: ids.names.container,
    MANAGED_IDENTITY_RESOURCE_ID: binding.assignment.app_identity_id, WEBSITE_RUN_FROM_PACKAGE: '1' }, 'App settings differ from the bound revision');
  const storage = props(snapshot.storage);
  assert.equal(snapshot.storage.kind, 'StorageV2'); assert.equal(snapshot.storage.sku?.name, 'Standard_LRS');
  const expectedStorage = { accessTier: 'Hot', minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true, allowSharedKeyAccess: false,
    allowBlobPublicAccess: false, publicNetworkAccess: 'Disabled', defaultToOAuthAuthentication: true, allowCrossTenantReplication: false,
    isHnsEnabled: false, isSftpEnabled: false, isLocalUserEnabled: false };
  for (const [key, value] of Object.entries(expectedStorage)) assert.equal(storage[key], value, 'Private LRS Blob security configuration changed');
  // The actual HCL does not configure network_rules. Azure may return its
  // dormant platform Allow/AzureServices defaults. They do NOT enable ingress
  // when publicNetworkAccess is Disabled; do not invent a Deny HCL requirement.
  if (storage.networkAcls) assert.ok(['Allow', 'Deny'].includes(storage.networkAcls.defaultAction) && ['None', 'AzureServices'].includes(storage.networkAcls.bypass) &&
    empty(storage.networkAcls.ipRules) && empty(storage.networkAcls.virtualNetworkRules) && empty(storage.networkAcls.resourceAccessRules), 'Storage has unreviewed network selectors');
  const storageConnections = storage.privateEndpointConnections;
  assert.ok(Array.isArray(storageConnections) && storageConnections.length === 1 && same(props(storageConnections[0]).privateEndpoint?.id, ids.privateEndpoint) &&
    props(storageConnections[0]).privateLinkServiceConnectionState?.status === 'Approved', 'Storage has an unrelated/unready private endpoint connection');
  assert.equal(props(snapshot.container).publicAccess, 'None');
  const endpoint = props(snapshot.privateEndpoint);
  assert.ok(same(endpoint.subnet?.id, ids.endpointSubnet) && empty(endpoint.manualPrivateLinkServiceConnections), 'Endpoint subnet/manual connection changed');
  const connections = endpoint.privateLinkServiceConnections;
  assert.ok(Array.isArray(connections) && connections.length === 1 && connections[0].name === ids.names.privateEndpoint, 'Unexpected private endpoint connection');
  assert.ok(same(props(connections[0]).privateLinkServiceId, ids.storage), 'Endpoint targets foreign storage');
  equal(props(connections[0]).groupIds, ['blob'], 'Endpoint targets a different storage service');
  assert.equal(props(connections[0]).privateLinkServiceConnectionState?.status, 'Approved', 'Blob private connection is not approved/ready');
  assert.ok(same(props(snapshot.dnsLink).virtualNetwork?.id, ids.vnet) && props(snapshot.dnsLink).registrationEnabled === false, 'Private DNS link changed');
  validateDns(snapshot.dnsRecords, snapshot.dnsGroups, snapshot.privateEndpoint, snapshot.nics, binding);
  const host = web.defaultHostName;
  assert.match(host ?? '', /^[a-z0-9-]+\.(?:[a-z0-9-]+\.)?azurewebsites\.net$/, 'Azure did not return a supported actual default hostname');
  const dot = host.indexOf('.');
  const scmHost = `${host.slice(0, dot)}.scm${host.slice(dot)}`;
  equal([...(web.enabledHostNames ?? [])].sort(), [host, scmHost].sort(), 'Azure app/SCM hostnames include an unattested/custom binding');
  return { webAppId: ids.webApp, defaultHostName: host, scmHostName: scmHost, url: `https://${host}`, ids };
}

export async function readSnapshot({ arm, binding }) {
  const ids = resourceIds(binding);
  const snapshot = {};
  const reads = [ ['group', ids.group, API.group], ['vnet', ids.vnet, API.network], ['appSubnet', ids.appSubnet, API.network],
    ['endpointSubnet', ids.endpointSubnet, API.network], ['nsg', ids.nsg, API.network], ['servicePlan', ids.servicePlan, API.web],
    ['webApp', ids.webApp, API.web], ['webConfig', `${ids.webApp}/config/web`, API.web],
    ['ftpPolicy', `${ids.webApp}/basicPublishingCredentialsPolicies/ftp`, API.web], ['scmPolicy', `${ids.webApp}/basicPublishingCredentialsPolicies/scm`, API.web],
    ['storage', ids.storage, API.storage], ['container', ids.container, API.storage], ['privateEndpoint', ids.privateEndpoint, API.network],
    ['dnsZone', ids.dnsZone, API.dns], ['dnsLink', ids.dnsLink, API.dns] ];
  for (const [key, id, api] of reads) snapshot[key] = await arm.get(id, api);
  snapshot.settings = await arm.settings();
  snapshot.dnsGroups = await arm.list(`${ids.privateEndpoint}/privateDnsZoneGroups`, API.network);
  snapshot.dnsRecords = await arm.list(`${ids.dnsZone}/recordsets`, API.dns);
  const interfaces = props(snapshot.privateEndpoint).networkInterfaces;
  assert.ok(Array.isArray(interfaces) && interfaces.length === 1, 'Owned endpoint NIC is not ready');
  assert.ok(interfaces[0].id?.toLowerCase().startsWith(`${ids.group}/providers/Microsoft.Network/networkInterfaces/`.toLowerCase()), 'Endpoint returned a foreign NIC');
  snapshot.nics = [await arm.get(interfaces[0].id, API.network)];
  return snapshot;
}

// Pure inventory policy. A name/prefix alone never attributes a platform child:
// NICs require PE forward + reverse links and Blob A records require its IP.
export function validateInventory({ binding, state, group, resources, endpoint, nics = [], dnsRecords = [], dnsGroups = [], children = [], storageConnections = [], hostBindings = [], webApp }) {
  const ids = resourceIds(binding);
  const managed = managedState(state, binding);
  assert.ok(group && same(group.id, ids.group), 'Workload group is not the expected state-owned group');
  ownedTags(group, binding, { current: false });
  const allowed = new Set(managed.ids);
  if (endpoint) {
    assert.ok(managed.ids.has(ids.privateEndpoint.toLowerCase()), 'Endpoint is not owned by this Terraform state');
    const nic = validateEndpointNics(endpoint, nics, binding);
    allowed.add(nic.nicId.toLowerCase());
    if (dnsGroups.length || dnsRecords.some(record => same(record.id, `${ids.dnsZone}/A/${ids.names.storage}`))) {
      assert.ok(managed.ids.has(ids.dnsZone.toLowerCase()), 'DNS zone is not owned by this state');
      validateDns(dnsRecords, dnsGroups, endpoint, nics, binding);
      allowed.add(ids.dnsGroup.toLowerCase()); allowed.add(`${ids.dnsZone}/A/${ids.names.storage}`.toLowerCase());
    }
  } else assert.ok(nics.length === 0 && dnsGroups.length === 0, 'Unattributed platform network child');
  if (managed.ids.has(ids.dnsZone.toLowerCase())) allowed.add(`${ids.dnsZone}/SOA/@`.toLowerCase());
  if (managed.ids.has(ids.storage.toLowerCase())) for (const service of ['blobServices', 'fileServices', 'queueServices', 'tableServices']) allowed.add(`${ids.storage}/${service}/default`.toLowerCase());
  assert.ok(Array.isArray(storageConnections) && storageConnections.length <= 1, 'Unknown storage private endpoint connections');
  for (const connection of storageConnections) {
    assert.ok(endpoint && connection.id?.toLowerCase().startsWith(`${ids.storage}/privateEndpointConnections/`.toLowerCase()) &&
      same(props(connection).privateEndpoint?.id, ids.privateEndpoint), 'Unattributed storage private connection');
    allowed.add(connection.id.toLowerCase());
  }
  if (hostBindings.length > 0) {
    assert.ok(managed.ids.has(ids.webApp.toLowerCase()) && same(webApp?.id, ids.webApp), 'Cannot attribute web hostname children');
    const host = props(webApp).defaultHostName;
    assert.match(host ?? '', /^[a-z0-9-]+\.(?:[a-z0-9-]+\.)?azurewebsites\.net$/);
    const dot = host.indexOf('.');
    const accepted = [host, `${host.slice(0, dot)}.scm${host.slice(dot)}`].map(name => `${ids.webApp}/hostNameBindings/${name}`.toLowerCase());
    for (const child of hostBindings) {
      assert.ok(accepted.includes(child.id?.toLowerCase()) && same(child.type, 'Microsoft.Web/sites/hostNameBindings') &&
        (!props(child).sslState || props(child).sslState === 'Disabled') && empty(props(child).thumbprint), 'Unrelated/custom hostname/certificate child blocks deletion');
      allowed.add(child.id.toLowerCase());
    }
  }
  assert.ok(Array.isArray(resources) && Array.isArray(children), 'Complete native inventory arrays are required');
  for (const resource of [...resources, ...children, ...nics, ...dnsRecords, ...dnsGroups, ...storageConnections, ...hostBindings]) {
    safeId(resource.id);
    assert.ok(allowed.has(resource.id.toLowerCase()), 'Unknown/unrelated object in workload RG; deletion refused');
  }
  // Every top-level managed object must appear in the native RG enumeration.
  for (const id of managed.ids) {
    if (same(id, ids.group) || id.slice(ids.group.length + 1).split('/').length !== 4) continue;
    assert.ok(resources.some(resource => same(resource.id, id)), 'Native RG inventory omitted a state-owned top-level resource');
  }
  return { status: 'owned', managedResources: managed.count, inventoriedObjects: new Set([...resources, ...children, ...nics, ...dnsRecords, ...dnsGroups, ...storageConnections, ...hostBindings].map(item => item.id.toLowerCase())).size };
}

export async function cleanupInventory({ arm, binding, state }) {
  const ids = resourceIds(binding);
  const managed = managedState(state, binding);
  const group = await arm.get(ids.group, API.group);
  const resources = await arm.list(`${ids.group}/resources`, API.resources);
  const children = [];
  const append = async (id, version) => { const items = await arm.list(id, version); children.push(...items); return items; };
  let endpoint;
  let nics = [];
  let dnsRecords = [];
  let dnsGroups = [];
  let storageConnections = [];
  let hostBindings = [];
  let webApp;
  if (managed.ids.has(ids.vnet.toLowerCase())) {
    await append(`${ids.vnet}/subnets`, API.network);
    assert.equal((await append(`${ids.vnet}/virtualNetworkPeerings`, API.network)).length, 0, 'Unowned peering blocks RG deletion');
  }
  if (managed.ids.has(ids.nsg.toLowerCase())) assert.equal((await append(`${ids.nsg}/securityRules`, API.network)).length, 0, 'Unowned NSG rules block RG deletion');
  if (managed.ids.has(ids.webApp.toLowerCase())) {
    webApp = await arm.get(ids.webApp, API.web);
    hostBindings = await arm.list(`${ids.webApp}/hostNameBindings`, API.web);
    assert.ok(hostBindings.length > 0, 'App hostname inventory is incomplete');
    assert.equal((await append(`${ids.webApp}/slots`, API.web)).length, 0, 'Unowned App Service slots block RG deletion');
    assert.equal((await append(`${ids.webApp}/siteextensions`, API.web)).length, 0, 'Unowned site extensions block RG deletion');
    assert.equal((await append(`${ids.webApp}/hybridconnectionrelays`, API.web)).length, 0, 'Unowned hybrid connections block RG deletion');
  }
  if (managed.ids.has(ids.storage.toLowerCase())) {
    for (const service of ['blobServices', 'fileServices', 'queueServices', 'tableServices']) await append(`${ids.storage}/${service}`, API.storage);
    await append(`${ids.blobService}/containers`, API.storage);
    for (const route of ['fileServices/default/shares', 'queueServices/default/queues', 'tableServices/default/tables', 'localUsers', 'managementPolicies'])
      assert.equal((await append(`${ids.storage}/${route}`, API.storage)).length, 0, 'Unowned storage children block RG deletion');
    storageConnections = await arm.list(`${ids.storage}/privateEndpointConnections`, API.storage);
  }
  if (managed.ids.has(ids.privateEndpoint.toLowerCase())) {
    endpoint = await arm.get(ids.privateEndpoint, API.network);
    const refs = props(endpoint).networkInterfaces;
    assert.ok(Array.isArray(refs) && refs.length === 1 && refs[0].id?.toLowerCase().startsWith(`${ids.group}/providers/Microsoft.Network/networkInterfaces/`.toLowerCase()), 'Endpoint NIC provenance missing');
    nics = [await arm.get(refs[0].id, API.network)];
    dnsGroups = await arm.list(`${ids.privateEndpoint}/privateDnsZoneGroups`, API.network);
  }
  if (managed.ids.has(ids.dnsZone.toLowerCase())) {
    await append(`${ids.dnsZone}/virtualNetworkLinks`, API.dns);
    dnsRecords = await arm.list(`${ids.dnsZone}/recordsets`, API.dns);
  }
  return validateInventory({ binding, state, group, resources, children, endpoint, nics, dnsRecords, dnsGroups, storageConnections, hostBindings, webApp });
}

export async function verifyAbsence({ arm, binding, state }) {
  assert.equal(managedState(state, binding, { allowEmpty: true }).count, 0, 'Managed workload state is not empty');
  assert.equal(await arm.get(resourceIds(binding).group, API.group, { allow404: true }), null, 'Workload RG still exists');
  return { status: 'absent', retainedBootstrap: true };
}

export async function verifyHealth({ target, fetchImpl = globalThis.fetch, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), attempts = 12 }) {
  assert.match(target.defaultHostName, /^[a-z0-9-]+\.(?:[a-z0-9-]+\.)?azurewebsites\.net$/);
  assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= 20, 'Invalid bounded health retry count');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let ready = true;
    for (const route of ['/healthz', '/health/storage']) {
      try {
        const response = await fetchImpl(`https://${target.defaultHostName}${route}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
        assert.ok(response.status !== 401 && response.status !== 403, 'Assigned ingress/network is not ready');
        const body = parseStrictJson(await boundedBytes(response, 16 * 1024), 16 * 1024);
        if (response.status !== 200 || body.status !== 'ok' || (route === '/healthz' && body.service !== 'ws2-welcome')) ready = false;
      } catch { ready = false; }
    }
    if (ready) return { status: 'healthy', url: `https://${target.defaultHostName}`, storage: 'read-only-200' };
    if (attempt + 1 < attempts) await sleep(Math.min(1_000 * 2 ** attempt, 15_000));
  }
  throw new Error('Runtime health/private Blob read is failed or pending; no deployment success is claimed');
}