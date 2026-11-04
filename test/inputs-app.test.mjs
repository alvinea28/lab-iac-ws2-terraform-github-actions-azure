import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { once } from 'node:events';
import { validateParticipant, validateAssignment, deriveNames, terraformVariables, parseParticipantJson, ROOT } from '../scripts/inputs.mjs';
import { appConfiguration, createApp, createBlobProbe, escapeHtml } from '../app/server.mjs';

const participant = () => ({ participant_name: 'alex', instance_number: '001', app_message: 'Hello from alex', page_theme: 'blue', workshop_iteration: '01' });
const assignment = () => JSON.parse(fs.readFileSync(`${ROOT}/workshop/assignment.example.json`, 'utf8'));
test('offline input parsing rejects duplicate/escaped/prototype keys like the guide and delivery', () => {
  assert.deepEqual(parseParticipantJson(Buffer.from(JSON.stringify(participant()))), participant());
  for (const value of ['{"page_theme":"purple","page_theme":"blue"}', '{"page_theme":"purple","page_\\u0074heme":"blue"}', '{"__proto__":{}}']) assert.throws(() => parseParticipantJson(Buffer.from(value)), /duplicate|unsafe/);
  assert.throws(() => parseParticipantJson(Buffer.from([0xc3, 0x28])));
  assert.throws(() => parseParticipantJson(Buffer.alloc(17 * 1024)));
});
test('one input produces the requested names and Azure exceptions', () => {
  const names = deriveNames(participant());
  assert.equal(names.resourceGroup, 'rg-alex-001');
  assert.equal(names.vnet, 'vnet-alex-001');
  assert.equal(names.storage, 'stalex001');
  assert.equal(names.dnsZone, 'privatelink.blob.core.windows.net');
  assert.deepEqual(deriveNames({ ...participant(), page_theme: 'green', workshop_iteration: '02' }), names);
});
for (const name of ['li', 'alexl', 'alex26', 'abcdefghijkl']) test(`accept participant name ${name}`, () => validateParticipant({ ...participant(), participant_name: name }));
for (const name of ['a', 'abcdefghijklm', 'Alex', 'alex lee', 'alex_lee', 'alex-lee', '123alex', '', 'áléx']) test(`reject invalid name ${JSON.stringify(name)}`, () => assert.throws(() => validateParticipant({ ...participant(), participant_name: name })));
for (const [field, values] of Object.entries({ instance_number: ['002', 1, '01'], app_message: ['', '   ', '<script>x</script>', 'x\ny', 'a'.repeat(61)], page_theme: ['purple', 'Blue', null], workshop_iteration: [1, '04'] })) {
  for (const value of values) test(`reject ${field}=${JSON.stringify(value)}`, () => assert.throws(() => validateParticipant({ ...participant(), [field]: value })));
}
for (const field of ['resource_group_name', 'location', 'app_service_sku', 'state_key', 'storage_public_access']) test(`reject protected override ${field}`, () => assert.throws(() => validateParticipant({ ...participant(), [field]: 'override' })));
test('freeze assigned name and do not conflate state/identity ownership', () => {
  assert.throws(() => validateParticipant(participant(), 'alexl'));
  const input = terraformVariables(participant(), assignment());
  assert.equal(input.assignment.allowed_web_cidr, '203.0.113.0/24');
  assert.equal(input.assignment.participant_name, 'alex');
  assert.throws(() => validateAssignment({ ...assignment(), app_identity_id: assignment().app_identity_id.replace('rg-instructor-bootstrap', 'rg-alex-001') }));
});
test('the offline example and public CIDR cannot authorize a live deployment', () => {
  assert.throws(() => validateAssignment(assignment(), { live: true }));
  assert.throws(() => validateAssignment({ ...assignment(), allowed_web_cidr: '0.0.0.0/0' }));
  assert.throws(() => validateAssignment({ ...assignment(), allowed_web_cidr: '999.1.1.1/24' }));
});
test('supplied app accepts only safe settings and HTML-escapes output', () => {
  assert.equal(appConfiguration({}).theme, 'blue');
  assert.throws(() => appConfiguration({ APP_MESSAGE: '<script>bad</script>' }));
  assert.throws(() => appConfiguration({ PAGE_THEME: 'purple' }));
  assert.equal(escapeHtml('<a>"&'), '&lt;a&gt;&quot;&amp;');
});
test('missing private storage is pending, not fabricated successful connectivity', async () => {
  assert.equal((await createBlobProbe({})()).status, 'pending');
});
test('real HTTP app displays updates, headers and honest storage failure without Azure', async () => {
  const app = createApp({ env: { APP_MESSAGE: 'Updated by alex', PAGE_THEME: 'green', WORKSHOP_ITERATION: '02' }, probe: async () => ({ status: 'failed', reason: 'Synthetic unit-test denial.' }) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base);
    const html = await page.text();
    assert.match(html, /Updated by alex/);
    assert.match(html, /data-theme="green"/);
    assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.ok(!page.headers.has('x-powered-by'));
    const health = await fetch(`${base}/health/storage`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).status, 'failed');
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/assets/../../package.json`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
