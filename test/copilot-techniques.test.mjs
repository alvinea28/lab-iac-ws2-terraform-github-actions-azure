import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import guide from '../.github/agentalvine/guide.cjs';
import { FIELDS, parseParticipantJson, validateParticipant, deriveNames } from '../scripts/inputs.mjs';

// Source-content/production-validator regressions only. Deterministic candidates
// below are NOT actual Copilot output or proof of Copilot use. These tests invoke
// no LLM, Copilot/license service, live GitHub/Azure, shell or deployment workflow.
const read = filename => readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const course = guide.loadCourse();
const lessons = new Map(course.sections.flatMap(section => section.steps.map(step => [step.id, read(step.lesson)])));
const activities = ['s2-1', 's2-2', 's2-3', 's3-1', 's3-2', 's3-3'];
const fallbackMarker = '**Fallback — no Copilot needed.**';
const digest = value => createHash('sha256').update(guide.canonicalJson(value)).digest('hex');
const parse = text => parseParticipantJson(Buffer.from(text));
const fences = text => [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)]
  .map(match => ({ language: match[1], code: match[2] }));
function example(id, language) {
  const blocks = fences(lessons.get(id));
  assert.equal(blocks.length, 1, `${id} must retain one complete published example.`);
  assert.equal(blocks[0].language, language);
  return blocks[0].code;
}
const materialize = id => example(id, 'json').replaceAll('<name>', 'li');

test('Copilot activities occupy exactly the first three existing steps of Sections 2/3 and none of Sections 1/4', () => {
  assert.equal(course.sections.length, 4);
  assert.deepEqual(course.sections.map(section => section.steps.length), [4, 4, 4, 4]);
  const actual = [];
  for (const section of course.sections) for (const [index, step] of section.steps.entries()) {
    const markers = [...lessons.get(step.id).matchAll(/^\*\*Copilot ([1-3])\/3 — optional:/gm)];
    if ([2, 3].includes(section.number) && index < 3) {
      assert.equal(markers.length, 1, step.id);
      assert.equal(Number(markers[0][1]), index + 1, step.id);
      actual.push(step.id);
    } else assert.doesNotMatch(lessons.get(step.id), /\bCopilot\b/i, step.id);
  }
  assert.deepEqual(actual, activities);
  assert.deepEqual(course.sections.map(section => section.steps.filter(step => /\*\*Copilot /.test(lessons.get(step.id))).length), [0, 3, 3, 0]);
  assert.equal([...lessons.values()].join('\n').match(/^\*\*Copilot /gm).length, 6);
});

for (const id of activities) test(`${id} retains a read-only optional prompt, immediate recovery and a complete no-Copilot path`, () => {
  const lesson = lessons.get(id);
  assert.equal(lesson.split(fallbackMarker).length - 1, 1);
  assert.match(lesson, /read-only Chat/);
  assert.match(lesson, /[Nn]o (?:extra fields or )?file\/tool actions|[Nn]o edits or commands|do not edit files or run commands|[Nn]o extra fields, edits or commands/);
  const fallback = lesson.split(fallbackMarker)[1].split('**How / why**')[0];
  assert.ok(fallback.trim().length > 40, 'Supply an actual answer/checklist, not a link-only placeholder.');
  assert.doesNotMatch(fallback, /\b(?:ask Chat|open Chat|subscribe|purchase|sign in|submit a transcript|upload a screenshot)\b/i);
  assert.match(lesson.split('**Fix**')[1], /fallback immediately|Skip unavailable|Use the sequence if Chat fails/);
});

test('the published routine makes licensing, service success, AI evidence and screenshots non-gates', () => {
  const parameters = read('docs/parameters.md').replace(/\s+/g, ' ');
  assert.match(parameters, /Participants already have GitHub Copilot licenses/);
  assert.match(parameters, /there is no purchase, premium-model choice, additional seat, successful chat request or AI-usage submission required/);
  assert.match(parameters, /two minutes per activity/);
  assert.match(parameters, /limit, sign-in problem, slow response, bad answer or unavailable Copilot means use the fallback immediately/);
  assert.match(parameters, /No extra branch, AI-generated commit, transcript, screenshot, Copilot badge, prompt answer, license check or manual evidence form is graded/);
  assert.match(parameters, /A participant who never opens Chat can complete the same course/);
  assert.match(parameters, /not claims of an actual model session or guaranteed Copilot output/);
  assert.match(parameters, /Do not use Agent\/Edit mode, grant auto-approval/);
  assert.match(parameters, /Never attach tokens, device codes, private logs, owner assignments\/profiles, plans, state, actual resource inventories or cleanup authorization/);
  const gates = course.sections.flatMap(section => section.steps.map(step => step.gate));
  assert.deepEqual(gates, ['task-push', 'installed-workflow', 'open-pr', 'current-ci', 'participant-change', 'input-pr-ci',
    'initial-delivery', 'initial-verification', 'initial-receipt', 'purple-rejection', 'updated-delivery', 'updated-verification',
    'updated-receipt', 'no-change', 'authorized-destroy', 'workload-absence']);
  assert.doesNotMatch(gates.join(' '), /copilot|license|chat|transcript|screenshot|llm/i);
});

test('the actual four fenced examples retain their language and whole-file versus one-line purpose', () => {
  const actual = [...lessons].filter(([, lesson]) => fences(lesson).length).map(([id, lesson]) => [id, fences(lesson).map(block => block.language)]);
  assert.deepEqual(actual, [['s2-1', ['json']], ['s2-2', ['hcl']], ['s3-2', ['json']], ['s3-3', ['json']]]);
  for (const id of ['s2-1', 's3-3']) {
    const code = example(id, 'json');
    assert.equal((code.match(/<name>/g) ?? []).length, 2, id);
    const value = parse(code);
    assert.deepEqual(Object.keys(value).sort(), [...FIELDS].sort());
    assert.ok(FIELDS.every(field => typeof value[field] === 'string'));
    assert.throws(() => validateParticipant(value), /participant_name/, 'Literal placeholders are not approved names.');
  }
});

test('the complete initial published JSON passes the real parser/validator and derives fixed li/001 names', () => {
  const value = validateParticipant(parse(materialize('s2-1')), 'li');
  assert.deepEqual(value, { participant_name: 'li', instance_number: '001', app_message: 'Hello from li', page_theme: 'blue', workshop_iteration: '01' });
  assert.deepEqual(guide.validateParticipant(value, 'li'), value);
  assert.deepEqual(deriveNames(value), {
    resourceGroup: 'rg-li-001', vnet: 'vnet-li-001', nsg: 'nsg-li-001', appSubnet: 'snet-app-li-001',
    endpointSubnet: 'snet-pe-li-001', servicePlan: 'asp-li-001', webApp: 'app-li-001', storage: 'stli001',
    container: 'cnt-li-001', privateEndpoint: 'pep-blob-li-001', dnsLink: 'dnslink-blob-li-001',
    dnsGroup: 'dzg-blob-li-001', dnsZone: 'privatelink.blob.core.windows.net',
  });
});

test('the read-only HCL answer is exactly the existing RG block excluding its comment, never a new resource', () => {
  const expected = read('infra/resource-group.tf').replace(/^#[^\n]*\n/, '');
  assert.equal(example('s2-2', 'hcl'), expected, 'Even indentation must match the supplied protected block after LF normalization.');
  assert.match(lessons.get('s2-2'), /already supplied; compare it, \*\*do not add a duplicate or edit the protected blueprint\*\*/);
  assert.match(lessons.get('s2-2'), /only the parameter file changes/);
});

test('the purple JSON fence is precisely the single replacement line, not standalone participant JSON', () => {
  const fragment = example('s3-2', 'json');
  assert.equal(fragment, '  "page_theme": "purple",\n');
  assert.throws(() => parse(fragment), SyntaxError);
  assert.match(lessons.get('s3-2'), /replace only the existing theme line/);
  assert.match(lessons.get('s3-2'), /Do not copy the single-line fragment as an entire JSON file/);
});

test('applying the actual purple line changes only the theme and fails production validation for that exact reason', () => {
  const initialText = materialize('s2-1');
  const fragment = example('s3-2', 'json').replace(/\n$/, '');
  const text = initialText.replace(/^[ \t]*"page_theme": "blue",$/m, fragment);
  assert.notEqual(text, initialText);
  assert.equal(text.split('\n').filter((line, index) => line !== initialText.split('\n')[index]).length, 1);
  const value = parse(text);
  const initial = validateParticipant(parse(initialText), 'li');
  assert.deepEqual(FIELDS.filter(field => value[field] !== initial[field]), ['page_theme']);
  assert.equal(value.page_theme, 'purple');
  assert.throws(() => validateParticipant(value, 'li'), { code: 'ERR_ASSERTION', message: 'page_theme must be blue, green or orange' });
  assert.throws(() => guide.validateParticipant(value, 'li'), { code: 'theme' });
  assert.deepEqual(validateParticipant({ ...value, page_theme: 'blue' }, 'li'), initial, 'Every non-theme field must already be valid.');
  assert.match(lessons.get('s3-2'), /Learner checks → Validate workshop inputs → Validate participant input/);
  assert.match(lessons.get('s3-2'), /rejection receipt \*\*before fixing\*\*/);
});

test('the full green fix changes exactly three fields, freezing name/001 and every derived resource name', () => {
  const initial = validateParticipant(parse(materialize('s2-1')), 'li');
  const updated = validateParticipant(parse(materialize('s3-3')), initial.participant_name);
  assert.deepEqual(updated, { participant_name: 'li', instance_number: '001', app_message: 'Updated by li', page_theme: 'green', workshop_iteration: '02' });
  assert.deepEqual(FIELDS.filter(field => initial[field] !== updated[field]), ['app_message', 'page_theme', 'workshop_iteration']);
  assert.notEqual(digest(initial), digest(updated));
  assert.deepEqual(deriveNames(updated), deriveNames(initial));
  assert.ok(Object.values(deriveNames(updated)).every(name => !name.includes('002')));
  assert.throws(() => validateParticipant({ ...updated, participant_name: 'other' }, initial.participant_name), /frozen owner assignment/);
  assert.throws(() => validateParticipant({ ...updated, instance_number: '002' }, initial.participant_name), /instance_number must remain the string 001/);
});

for (const [label, change, reason] of [
  ['backend override', { backend: 'unreviewed' }, /missing or unknown fields/],
  ['subscription override', { subscription_id: '11111111-1111-4111-8111-111111111111' }, /missing or unknown fields/],
  ['SKU override', { sku: 'S1' }, /missing or unknown fields/],
  ['name change', { participant_name: 'other' }, /frozen owner assignment/],
  ['instance change', { instance_number: '002' }, /instance_number must remain the string 001/],
  ['numeric iteration', { workshop_iteration: 2 }, /workshop_iteration must be a string/],
  ['unsupported theme', { page_theme: 'purple' }, /page_theme must be blue, green or orange/],
]) test(`reject a deterministic wrong model candidate (${label}); copying the published fallback still works`, () => {
  const initial = validateParticipant(parse(materialize('s2-1')), 'li');
  const fallbackText = materialize('s3-3');
  const expected = validateParticipant(parse(fallbackText), initial.participant_name);
  const candidateText = JSON.stringify({ ...expected, ...change });
  const candidate = parse(candidateText);
  assert.throws(() => validateParticipant(candidate, initial.participant_name), reason);
  const recovered = validateParticipant(parse(fallbackText), initial.participant_name);
  assert.deepEqual(recovered, expected);
  assert.equal(digest(recovered), digest(expected));
  assert.deepEqual(deriveNames(recovered), deriveNames(initial));
});

test('a duplicate-key candidate cannot hide its override, and the actual fallback parses without repair', () => {
  const text = materialize('s3-3');
  const candidate = text.replace('"page_theme": "green"', '"page_theme": "purple", "page_\\u0074heme": "green"');
  assert.throws(() => parse(candidate), /duplicate or unsafe keys/);
  assert.equal(validateParticipant(parse(text), 'li').page_theme, 'green');
});
