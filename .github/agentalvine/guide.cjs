'use strict';

// Metadata observer only. There is deliberately no shell, learner-code import,
// artifact download, workflow dispatch, Azure client, credential or state access.
// The issue body is a replaceable VIEW, never a progress input. Immutable bot
// comments form a revision-bound journal, revalidated against GitHub on each run.
// This is an educational guide, not deployment authorization or certification.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const ROOT = path.resolve(__dirname, '../..');
const BOT_LOGIN = 'github-actions[bot]';
const COMMAND = 'proceed to next section';
const RECORD = '<!-- agentalvine:record:v1\n';
const END_RECORD = '\n-->';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CHECKS_ACTIONS = Object.freeze([
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e',
]);
// Preserve a BOM as a character so strict JSON rejects it just like JSON.parse
// on the participant's actual UTF-8 file; do not silently normalize bad input.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const APPROVED_LIVE_REPOSITORIES = Object.freeze({
  1379147533: 'alvine-aurelio-org/ws2-sim-20260921-network-module-laboratory-02',
  1379149907: 'alvine-aurelio-org/ws2-sim-20260921-azure-delivery-laboratory-07',
});
const GATES = Object.freeze([
  ['task-push', 'installed-workflow', 'open-pr', 'current-ci'],
  ['participant-change', 'input-pr-ci', 'initial-delivery', 'initial-verification'],
  ['initial-receipt', 'purple-rejection', 'updated-delivery', 'updated-verification'],
  ['updated-receipt', 'no-change', 'authorized-destroy', 'workload-absence'],
]);
const FIELDS = ['participant_name', 'instance_number', 'app_message', 'page_theme', 'workshop_iteration'];
const COMMON = ['schemaVersion', 'kind', 'courseId', 'courseDigest', 'repositoryId', 'issueNumber'];
const RECORD_FIELDS = {
  register: [...COMMON, 'defaultBranch', 'registeredRevision'],
  start: [...COMMON, 'previous', 'registrationCommentId', 'defaultBranch', 'startRevision', 'learnerIds'],
  step: [...COMMON, 'cycle', 'previous', 'stepId', 'revision', 'evidence'],
  gate: [...COMMON, 'cycle', 'previous', 'section', 'stepReceiptHash'],
  advance: [...COMMON, 'cycle', 'previous', 'fromSection', 'toSection', 'gateCommentId', 'gateId',
    'promptCreatedAt', 'commandCommentId', 'commandAuthorId', 'commandCreatedAt', 'commandBodySha256', 'nextStepId'],
};

class GuideError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function insist(condition, code, message) {
  if (!condition) throw new GuideError(code, message);
}
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function exact(value, fields, label) {
  insist(object(value) && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0'),
    'invalid-shape', `${label} has missing or unknown fields.`);
}
function canonicalJson(value) {
  const active = new Set();
  let count = 0;
  function visit(item, depth) {
    insist(depth <= 64 && ++count <= 250000, 'invalid-json', 'JSON complexity is excessive.');
    if (item === null || ['boolean', 'string'].includes(typeof item)) return item;
    if (typeof item === 'number') {
      insist(Number.isFinite(item), 'invalid-json', 'JSON numbers must be finite.');
      return item;
    }
    insist((object(item) || Array.isArray(item)) && !active.has(item), 'invalid-json', 'Plain acyclic JSON is required.');
    active.add(item);
    const result = Array.isArray(item) ? [] : Object.create(null);
    for (const key of Object.keys(item).sort()) {
      insist(!['__proto__', 'prototype', 'constructor'].includes(key), 'invalid-json', 'Unsafe JSON key.');
      result[key] = visit(item[key], depth + 1);
    }
    active.delete(item);
    return result;
  }
  return JSON.stringify(visit(value, 0));
}
function parseStrictJson(text) {
  insist(typeof text === 'string' && Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= 131072,
    'invalid-json', 'JSON is missing or too large.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new GuideError('invalid-json', 'Invalid JSON.'); }
  // JSON.parse checks grammar; this traversal also rejects duplicate keys,
  // including Unicode-escaped duplicates. A reviver alone cannot do that.
  const stack = [];
  for (const token of text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? []) {
    if (token === '{' || token === '[') {
      insist(stack.length < 64, 'invalid-json', 'JSON nesting is excessive.');
      stack.push({ object: token === '{', key: token === '{', seen: new Set() });
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (stack.at(-1)?.object) stack.at(-1).key = true; }
    else if (stack.at(-1)?.object && stack.at(-1).key && token.startsWith('"')) {
      const key = JSON.parse(token);
      const frame = stack.at(-1);
      insist(!frame.seen.has(key) && !['__proto__', 'prototype', 'constructor'].includes(key),
        'invalid-json', 'Duplicate or unsafe JSON key.');
      frame.seen.add(key);
      frame.key = false;
    }
  }
  canonicalJson(parsed);
  return parsed;
}
function time(value) {
  insist(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value),
    'invalid-time', 'A UTC server timestamp is required.');
  const result = Date.parse(value);
  insist(Number.isFinite(result) && new Date(result).toISOString() ===
    value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'), 'invalid-time', 'Invalid server timestamp.');
  return result;
}
function parseEnrollment(text) {
  let ids;
  try { ids = parseStrictJson(text); } catch { throw new GuideError('enrollment', 'Owner-managed learner enrollment is missing or invalid.'); }
  insist(Array.isArray(ids) && ids.length > 0 && ids.length <= 32 && ids.every(positive) && new Set(ids).size === ids.length,
    'enrollment', 'WORKSHOP_LEARNER_USER_IDS must be a nonempty JSON array of unique positive integer user IDs.');
  return [...ids].sort((a, b) => a - b);
}
function validateParticipant(value, expectedName) {
  exact(value, FIELDS, 'Participant input');
  for (const key of FIELDS) insist(typeof value[key] === 'string', 'participant', 'All five participant fields must be strings.');
  insist(/^[a-z][a-z0-9]{1,11}$/.test(value.participant_name), 'participant', 'Use a valid approved participant name.');
  insist(expectedName === undefined || value.participant_name === expectedName, 'participant', 'The frozen participant name changed.');
  insist(value.instance_number === '001', 'participant', 'The instance number must remain the string 001.');
  insist(/^[A-Za-z0-9 .,!-]{1,60}$/.test(value.app_message) && value.app_message.trim(), 'participant', 'The app message is not allowlisted plain text.');
  insist(['blue', 'green', 'orange'].includes(value.page_theme), 'theme', 'page_theme must be blue, green or orange.');
  insist(['01', '02', '03'].includes(value.workshop_iteration), 'participant', 'Use a supported string workshop iteration.');
  return clone(value);
}
function validateCourse(config) {
  insist(object(config) && config.schemaVersion === 1 && config.persona === 'AgentAlvine' && config.issueTitle === 'Exercise' &&
    config.command === COMMAND && config.sourceRepository === 'alvinea28/lab-iac-ws2-terraform-github-actions-azure' &&
    config.sourceDefaultBranch === 'dev' && config.root === 'infra' && config.profile === 'ws2-personal-web-v1',
  'course', 'The fixed source, persona, section command or root/profile contract changed.');
  insist(typeof config.id === 'string' && /^[a-z0-9-]{1,80}$/.test(config.id) && Array.isArray(config.sections) && config.sections.length === 4,
    'course', 'Exactly four sections are required.');
  for (let section = 1; section <= 4; section++) {
    const entry = config.sections[section - 1];
    insist(entry.number === section && entry.steps?.length === 4, 'course', 'Each section has exactly four ordered steps.');
    entry.steps.forEach((step, index) => insist(step.id === `s${section}-${index + 1}` &&
      step.lesson === `.github/steps/${step.id}.md` && step.gate === GATES[section - 1][index],
    'course', 'Step IDs, lessons and evidence gates must remain ordered.'));
  }
  for (const key of ['taskBranchPrefixes', 'permittedPullRequestBases', 'meaningfulPaths', 'ciTrustedPaths', 'readOnlyCommands']) {
    insist(Array.isArray(config[key]) && config[key].length > 0 && config[key].every(value => typeof value === 'string' && value.length > 0),
      'course', 'The evidence allowlists must be explicit.');
  }
  for (const filename of [...config.meaningfulPaths, ...config.ciTrustedPaths, config.participantPath, config.learnerWorkflowPath,
    config.canonicalWorkflowPath, config.validatorPath, ...Object.values(config.workflowPaths ?? {})]) {
    insist(typeof filename === 'string' && /^[.A-Za-z0-9_/-]+$/.test(filename) && !filename.startsWith('/') &&
      !filename.split('/').includes('..'), 'course', 'Only explicit repository-relative evidence paths are allowed.');
  }
  insist(config.workflowPaths?.guide === '.github/workflows/guide.yml' &&
    config.workflowPaths.learner === config.learnerWorkflowPath && config.participantPath === 'exercise/participant.json' &&
    config.validatorPath === 'scripts/inputs.mjs', 'course', 'The guide, learner workflow or input path changed.');
  exact(config.workflowPaths, ['guide', 'quality', 'learner', 'delivery', 'cleanup'], 'Workflow paths');
  exact(config.jobs, ['validation', 'preflight', 'liveValidation', 'plan', 'apply', 'packaging', 'verification', 'followup', 'destroyPlan', 'destroy', 'absence'], 'Job contracts');
  insist(Object.values(config.jobs).every(name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _/().-]{0,119}$/.test(name)) &&
    typeof config.inputValidationStep === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _/().-]{0,119}$/.test(config.inputValidationStep) &&
    typeof config.observationStepPrefix === 'string' && /^[A-Za-z0-9][A-Za-z0-9 -]{0,79}$/.test(config.observationStepPrefix),
  'course', 'Named job and readback contracts are required.');
  return config;
}
function loadCourse() {
  return validateCourse(parseStrictJson(fs.readFileSync(path.join(__dirname, 'course.json'), 'utf8')));
}
function human(user, container = {}) {
  return positive(user?.id) && user.type === 'User' && typeof user.login === 'string' && LOGIN.test(user.login) &&
    !container.performed_via_github_app && !container.via_app;
}
function technicalBot(value) {
  return value?.user?.login === BOT_LOGIN && value.user.type === 'Bot' && positive(value.user.id) &&
    (!value.performed_via_github_app || value.performed_via_github_app.id === 15368);
}
function sameRepo(value, repository) {
  return value?.id === repository.id && value.full_name === repository.full_name;
}
async function optional(read) {
  try { return await read(); } catch (error) { if (error.status === 404) return null; throw error; }
}
function route(repository) {
  const [owner, repo] = repository.full_name.split('/');
  return { owner, repo };
}
function repositoryIdentity(repository) {
  insist(positive(repository?.id) && typeof repository.full_name === 'string' &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository.full_name) && repository.name === repository.full_name.split('/')[1] &&
    repository.owner?.login === repository.full_name.split('/')[0] && typeof repository.default_branch === 'string' &&
    /^[A-Za-z0-9_.\/-]+$/.test(repository.default_branch) && !repository.default_branch.includes('..'), 'repository', 'Repository metadata is inconsistent.');
}
async function branchHead(github, repository, branch) {
  const result = await optional(async () => (await github.rest.repos.getBranch({ ...route(repository), branch })).data);
  if (!result) return null;
  insist(result.name === branch && SHA.test(result.commit?.sha ?? ''), 'metadata', 'Branch metadata is inconsistent.');
  return result;
}

// A comment's context.sha is the default branch, NOT a learner revision. Push,
// PR and workflow_run hints are resolved against the actual current branch and
// real run/PR metadata. Stale hints are harmless; reconciliation can find a newer
// eligible current-head run after pending events have been coalesced by Actions.
async function getEventSnapshot({ github, context, repository }) {
  const empty = { kind: 'metadata', revision: null };
  const payload = context.payload ?? {};
  let branch;
  let revision;
  let run;
  let pr;
  if (context.eventName === 'push') {
    if (payload.deleted !== false || payload.forced !== false || !human(payload.sender, payload) ||
      !/^refs\/heads\/.+/.test(payload.ref ?? '') || !SHA.test(payload.after ?? '') || !positive(context.runId)) return empty;
    branch = payload.ref.slice('refs/heads/'.length);
    revision = payload.after;
    run = (await github.rest.actions.getWorkflowRun({ ...route(repository), run_id: context.runId })).data;
    if (run.event !== 'push' || run.head_sha !== revision || run.head_branch !== branch || run.actor?.id !== payload.sender.id) return empty;
  } else if (context.eventName === 'pull_request_target') {
    if (!positive(payload.pull_request?.number)) return empty;
    pr = (await github.rest.pulls.get({ ...route(repository), pull_number: payload.pull_request.number })).data;
    if (!sameRepo(pr.head?.repo, repository) || !sameRepo(pr.base?.repo, repository) || pr.state !== 'open' || pr.draft !== false || !human(pr.user, pr)) return empty;
    branch = pr.head.ref;
    revision = pr.head.sha;
  } else if (context.eventName === 'workflow_run') {
    if (!positive(payload.workflow_run?.id)) return empty;
    run = (await github.rest.actions.getWorkflowRun({ ...route(repository), run_id: payload.workflow_run.id })).data;
    branch = run.head_branch;
    revision = run.head_sha;
  } else return empty;
  if (run && (!sameRepo(run.repository, repository) || !sameRepo(run.head_repository, repository) || run.run_attempt !== 1 ||
    !human(run.actor, run) || !human(run.triggering_actor, run) || run.actor.id !== run.triggering_actor.id ||
    run.actor.login !== run.triggering_actor.login)) return empty;
  if (typeof branch !== 'string' || !SHA.test(revision ?? '')) return empty;
  const current = await branchHead(github, repository, branch);
  if (current?.commit.sha !== revision) return { kind: 'stale', revision: null, branch };
  return { kind: pr ? 'pull-request' : context.eventName, branch, revision,
    actorId: (pr?.user ?? run.actor).id, runId: run?.id ?? null, pullNumber: pr?.number ?? null,
    observedAt: run?.created_at ?? pr.created_at };
}

function scalar(value) {
  const text = value.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}
function readOnlyCanonical(text, config) {
  // This is intentionally NOT a permissive YAML interpreter. The learner file
  // must equal the OWNER'S exact trusted reference. These additional lexical
  // restrictions make a missing/unsafe reference fail closed; exotic YAML is
  // not accepted or executed by this guide. Parent CI validates YAML semantics.
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(line => !/^\s*#/.test(line));
  const code = lines.join('\n');
  insist(!/\t|\$\{\{\s*(?:(?:secrets|vars)\.|github\.token)|(?:^|\n)\s*(?:id-token|environment|secrets|services|container|workflow_call|pull_request_target|workflow_run|workflow_dispatch|schedule)\s*:/i.test(code),
    'unsafe-workflow', 'The checks reference is not credential-free and read-only.');
  insist(!/(?:^|\s)(?:&|\*|!)[A-Za-z]/m.test(code) && !/\b(?:write-all|contents:\s*write|actions:\s*write|pull-requests:\s*write|checks:\s*write)\b/i.test(code),
    'unsafe-workflow', 'YAML aliases, tags and write permissions are not accepted.');
  insist(/^on:\s*$/m.test(code) && /^ {2}push:\s*(?:\{\})?\s*$/m.test(code) &&
    /^ {2}pull_request:\s*(?:\{\})?\s*$/m.test(code) && /^permissions:\s*\n +contents: read\s*$/m.test(code),
    'unsafe-workflow', 'The canonical checks must explicitly cover push/PR with contents: read.');
  const onBlock = code.split(/^on:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const events = [...onBlock.matchAll(/^ {2}([A-Za-z_]+):/gm)].map(match => match[1]);
  insist(events.length === 2 && events.includes('push') && events.includes('pull_request'), 'unsafe-workflow', 'Unexpected checks event.');
  const commands = [];
  for (let index = 0; index < lines.length; index++) {
    const uses = lines[index].match(/^\s*(?:-\s*)?uses:\s*(\S+)\s*$/);
    if (uses) {
      insist(CHECKS_ACTIONS.includes(uses[1]), 'unsafe-workflow', 'Checks actions must use the exact reviewed checkout, Node and Terraform setup pins.');
      if (uses[1].startsWith('actions/checkout@')) {
        const tail = [];
        for (let next = index + 1; next < lines.length && !/^\s*-\s/.test(lines[next]); next++) tail.push(lines[next]);
        insist(/persist-credentials:\s*false\s*$/m.test(tail.join('\n')), 'unsafe-workflow', 'Checkout must not persist credentials.');
      }
    }
    const run = lines[index].match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!run) continue;
    if (run[2] === '|') {
      for (let next = index + 1; next < lines.length; next++) {
        const line = lines[next];
        if (!line.trim()) continue;
        if (line.match(/^\s*/)[0].length <= run[1].length) break;
        commands.push(line.trim());
      }
    } else commands.push(scalar(run[2]));
  }
  insist(commands.length > 0 && commands.every(command => config.readOnlyCommands.includes(command) &&
    !/(?:^|\s)(?:az|azd|terraform|curl|wget|bash|pwsh|powershell)(?:\s|$)/i.test(command)) &&
    commands.includes('node scripts/inputs.mjs'), 'unsafe-workflow', 'Checks commands differ from the credential-free command allowlist.');
  return hash(Buffer.from(text.replace(/\r\n/g, '\n')));
}
function validateLearnerWorkflow(installed, canonical, config = loadCourse()) {
  insist(typeof installed === 'string' && typeof canonical === 'string' && canonical.length > 0,
    'workflow', 'The learner workflow and trusted reference must both exist.');
  const digest = readOnlyCanonical(canonical, config);
  insist(installed.replace(/\r\n/g, '\n') === canonical.replace(/\r\n/g, '\n'), 'workflow',
    'Install the exact reviewed credential-free checks reference; the guide never executes it.');
  return digest;
}

class EvidenceReader {
  constructor({ github, repository, config, env, learnerIds, now }) {
    Object.assign(this, { github, repository, config, env, learnerIds, now });
    this.params = route(repository);
  }
  async list(method, params) {
    const values = await this.github.paginate(method, { ...this.params, per_page: 100, ...params });
    insist(Array.isArray(values) && values.length <= 10000, 'metadata', 'Metadata inventory is incomplete or too large.');
    return values;
  }
  async userById(id) {
    insist(positive(id), 'identity', 'Numeric user identity is required.');
    const user = await optional(async () => (await this.github.rest.users.getById({ account_id: id })).data);
    insist(!user || user.id === id, 'identity', 'The numeric user lookup returned a different identity.');
    return user;
  }
  async eligible(user, state, { owner = false } = {}) {
    if (!human(user) || (!owner && (!this.learnerIds.includes(user.id) || !state.root.learnerIds.includes(user.id)))) return false;
    const permission = await optional(async () => (await this.github.rest.repos.getCollaboratorPermissionLevel({ ...this.params, username: user.login })).data);
    return !!permission && human(permission.user) && permission.user.id === user.id && permission.user.login === user.login &&
      (owner ? permission.permission === 'admin' : ['write', 'maintain', 'admin'].includes(permission.permission));
  }
  async activeEnrollment(ids) {
    const provisional = { root: { learnerIds: ids } };
    const result = [];
    for (const id of ids) {
      const user = await this.userById(id);
      if (user && await this.eligible(user, provisional)) result.push(id);
    }
    insist(result.length > 0, 'enrollment', 'No enrolled human currently has write access to this private copy.');
    return result;
  }
  async content(filename, revision) {
    insist(SHA.test(revision ?? ''), 'metadata', 'Content must be read at an immutable revision.');
    const data = await optional(async () => (await this.github.rest.repos.getContent({ ...this.params, path: filename, ref: revision })).data);
    insist(data && !Array.isArray(data) && data.type === 'file' && data.path === filename && data.encoding === 'base64' &&
      typeof data.content === 'string' && data.size > 0 && data.size <= 2 * 1024 * 1024,
    'content', 'Required read-only source content is missing or is not a regular file.');
    const encoded = data.content.replace(/\s/g, '');
    insist(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded), 'content', 'Invalid source content encoding.');
    const bytes = Buffer.from(encoded, 'base64');
    insist(bytes.length === data.size && bytes.toString('base64') === encoded, 'content', 'Source content bytes are inconsistent.');
    let text;
    try { text = decoder.decode(bytes); } catch { throw new GuideError('content', 'Source content must be UTF-8.'); }
    return { text, digest: hash(bytes) };
  }
  async participant(revision, expectedName) {
    const content = await this.content(this.config.participantPath, revision);
    const input = validateParticipant(parseStrictJson(content.text), expectedName);
    return { input, digest: hash(canonicalJson(input)) };
  }
  taskBranch(branch) {
    return typeof branch === 'string' && branch !== 'main' && branch !== this.repository.default_branch &&
      this.config.taskBranchPrefixes.some(prefix => branch.startsWith(prefix) && branch.length > prefix.length);
  }
  async current(branch, revision, historical) {
    if (historical) return;
    const head = await branchHead(this.github, this.repository, branch);
    insist(head?.commit.sha === revision && (branch !== 'main' || head.protected === true),
      'stale', 'Evidence is not at the current branch head (or main is not protected).');
  }
  async runs(state) {
    return (await this.list(this.github.rest.actions.listWorkflowRunsForRepo, { created: `>=${state.startedAt}` }))
      .sort((a, b) => time(b.created_at) - time(a.created_at) || b.id - a.id);
  }
  async run(id, state, { revision, branch, workflowPath, events, after = state.activeAt, at = this.now(), complete, live = false } = {}) {
    insist(positive(id), 'metadata', 'A real numeric workflow run is required.');
    const run = (await this.github.rest.actions.getWorkflowRun({ ...this.params, run_id: id })).data;
    insist(run.id === id && run.run_attempt === 1 && sameRepo(run.repository, this.repository) && sameRepo(run.head_repository, this.repository) &&
      SHA.test(run.head_sha ?? '') && human(run.actor, run) && human(run.triggering_actor, run) && run.actor.id === run.triggering_actor.id &&
      run.actor.login === run.triggering_actor.login, 'run', 'Run identity, first attempt or same-repository provenance could not be verified.');
    insist((!revision || run.head_sha === revision) && (!branch || run.head_branch === branch) &&
      (!workflowPath || run.path === workflowPath) && (!events || events.includes(run.event)), 'run', 'Workflow path, event, branch or revision does not match.');
    insist(time(run.created_at) > time(after) && time(run.created_at) <= at, 'run-time', 'Run was not created after this section became active.');
    let allowed = await this.eligible(run.actor, state);
    if (!allowed && live) {
      const profile = this.profile(state);
      allowed = String(run.actor.id) === profile.value.owner.id && run.actor.login === profile.value.owner.login &&
        await this.eligible(run.actor, state, { owner: true });
    }
    insist(allowed, 'identity', 'The run actor is not an enrolled current writer or the pinned live owner.');
    if (complete) insist(run.status === 'completed' && run.conclusion === complete, 'run-result', 'The intended run is not genuinely completed with the required result.');
    return run;
  }
  async task(state, hint, { at = this.now(), historical = false } = {}) {
    let candidates;
    if (hint) {
      insist(positive(hint.pushRunId) && SHA.test(hint.revision ?? '') && this.taskBranch(hint.branch), 'evidence', 'Invalid task-push receipt.');
      candidates = [{ id: hint.pushRunId, head_sha: hint.revision, head_branch: hint.branch }];
    } else candidates = (await this.runs(state)).filter(run => run.event === 'push' && this.taskBranch(run.head_branch) &&
      [this.config.workflowPaths.guide, this.config.workflowPaths.quality, this.config.workflowPaths.learner].includes(run.path));
    for (const candidate of candidates) {
      try {
        const run = await this.run(candidate.id, state, { revision: candidate.head_sha, branch: candidate.head_branch, events: ['push'], at });
        insist([this.config.workflowPaths.guide, this.config.workflowPaths.quality, this.config.workflowPaths.learner].includes(run.path), 'run', 'Unexpected push observer workflow.');
        await this.current(run.head_branch, run.head_sha, historical);
        const comparison = (await this.github.rest.repos.compareCommitsWithBasehead({ ...this.params,
          basehead: `${state.root.startRevision}...${run.head_sha}` })).data;
        const changedPaths = (comparison.files ?? []).filter(file => this.config.meaningfulPaths.includes(file.filename) &&
          file.status !== 'removed' && file.changes > 0).map(file => file.filename).sort();
        insist(comparison.status === 'ahead' && comparison.total_commits > 0 && changedPaths.length > 0,
          'task', 'Push a meaningful learner source change on a task branch after the course/section started.');
        return { branch: run.head_branch, revision: run.head_sha, pushRunId: run.id, actorId: run.actor.id,
          pushedAt: run.created_at, startRevision: state.root.startRevision, changedPaths };
      } catch (error) {
        if (hint || !(error instanceof GuideError)) throw error;
      }
    }
    throw new GuideError('task', 'No eligible, meaningful, current task-branch push after section activation was observed. This does not prove installation or human UI activity.');
  }
  async installed(state, revision) {
    const installed = await this.content(this.config.learnerWorkflowPath, revision);
    const canonical = await this.content(this.config.canonicalWorkflowPath, state.root.startRevision);
    return validateLearnerWorkflow(installed.text, canonical.text, this.config);
  }
  async pr(state, task, hint, { at = this.now(), historical = false } = {}) {
    const candidates = hint?.pullNumber ? [{ number: hint.pullNumber }] : await this.list(this.github.rest.pulls.list, { state: 'open' });
    for (const candidate of candidates) {
      try {
        insist(positive(candidate.number), 'pr', 'A real pull request number is required.');
        const pr = (await this.github.rest.pulls.get({ ...this.params, pull_number: candidate.number })).data;
        insist(pr.number === candidate.number && sameRepo(pr.head?.repo, this.repository) && sameRepo(pr.base?.repo, this.repository) &&
          this.config.permittedPullRequestBases.includes(pr.base.ref) && pr.head.ref === task.branch && pr.draft === false && human(pr.user, pr) &&
          await this.eligible(pr.user, state), 'pr', 'Require your same-repository, nondraft learner PR to a permitted existing base.');
        insist(time(pr.created_at) > time(state.startedAt) && time(pr.created_at) <= at, 'pr', 'The learner PR predates this course cycle.');
        const base = await branchHead(this.github, this.repository, pr.base.ref);
        insist(base, 'pr', 'The permitted PR base must actually exist.');
        if (historical) {
          insist((!pr.closed_at || time(pr.closed_at) > at) && (!pr.merged_at || time(pr.merged_at) > at), 'pr', 'The PR was not open when recorded.');
          const commits = await this.list(this.github.rest.pulls.listCommits, { pull_number: pr.number });
          insist(commits.some(commit => commit.sha === task.revision), 'pr', 'The recorded learner revision is no longer in this PR.');
        } else insist(pr.state === 'open' && pr.head.sha === task.revision, 'pr', 'The PR is closed, stale or not at the current learner head.');
        return { pullNumber: pr.number, base: pr.base.ref, authorId: pr.user.id, createdAt: pr.created_at };
      } catch (error) { if (hint?.pullNumber || !(error instanceof GuideError)) throw error; }
    }
    throw new GuideError('pr', 'No current same-repository, open nondraft learner PR to an existing permitted base was observed.');
  }
  async jobs(run, at) {
    const jobs = await this.list(this.github.rest.actions.listJobsForWorkflowRunAttempt, { run_id: run.id, attempt_number: 1 });
    // The attempt-specific endpoint is authoritative even on API versions whose
    // job DTO omits run_attempt. A populated contradictory attempt is rejected.
    insist(jobs.every(job => positive(job.id) && job.run_id === run.id &&
      (job.run_attempt === undefined || job.run_attempt === 1) && job.head_sha === run.head_sha),
      'jobs', 'Jobs do not belong to this exact run, first attempt and revision.');
    for (const job of jobs.filter(job => job.status === 'completed' && job.conclusion !== 'skipped')) {
      insist(time(job.started_at) >= time(run.created_at) && time(job.completed_at) >= time(job.started_at) &&
        time(job.completed_at) <= at, 'jobs', 'Job timestamps are missing, future-dated or inconsistent.');
    }
    return jobs;
  }
  job(jobs, name, conclusion = 'success') {
    const matches = jobs.filter(job => job.name === name);
    insist(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === conclusion &&
      Array.isArray(matches[0].steps) && matches[0].steps.some(step => step.status === 'completed' &&
        step.conclusion === (conclusion === 'failure' ? 'failure' : 'success') && !/^(?:Set up job|Complete job|Post )/.test(step.name)),
    'jobs', `The exact '${name}' job must really run and finish with ${conclusion}; skipped/empty jobs do not count.`);
    return matches[0];
  }
  async trustedCi(state, run) {
    insist(run.path === this.config.workflowPaths.learner, 'workflow', 'Only the installed reviewed learner checks can provide course CI evidence.');
    await this.installed(state, run.head_sha);
    for (const filename of this.config.ciTrustedPaths) {
      const actual = await this.content(filename, run.head_sha);
      const trusted = await this.content(filename, state.root.startRevision);
      insist(actual.digest === trusted.digest, 'workflow', 'Credential-free CI implementation or package source was changed.');
    }
  }
  async ci(state, task, hint, { at = this.now(), historical = false, failure = false } = {}) {
    const candidates = hint?.runId ? [{ id: hint.runId }] : (await this.runs(state)).filter(run =>
      run.head_sha === task.revision && run.head_branch === task.branch &&
      run.path === this.config.workflowPaths.learner && ['push', 'pull_request'].includes(run.event));
    // Maintenance quality has its own job/semantics and intentionally permits
    // the purple teaching input. It cannot provide positive or negative learner
    // CI evidence, including via a hinted run ID or historical receipt replay.
    // Do not conceal a newer failed learner run with an older green learner run.
    const candidate = candidates[0];
    insist(candidate, 'ci', 'No current-revision credential-free CI run was observed.');
    const run = await this.run(candidate.id, state, { revision: task.revision, branch: task.branch,
      workflowPath: this.config.workflowPaths.learner, events: ['push', 'pull_request'], complete: failure ? 'failure' : 'success', at });
    await this.current(task.branch, task.revision, historical);
    await this.trustedCi(state, run);
    const jobs = await this.jobs(run, at);
    const validation = this.job(jobs, this.config.jobs.validation, failure ? 'failure' : 'success');
    if (failure) {
      const matches = validation.steps.filter(step => step.name === this.config.inputValidationStep);
      insist(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'failure',
        'rejection', 'The intended input validation step, not setup or another test, must fail.');
      const workflow = (await this.content(run.path, run.head_sha)).text.replace(/\r\n/g, '\n');
      const block = workflow.split(/^\s*-\s+name:\s*/m).find(part => scalar(part.split('\n')[0]) === this.config.inputValidationStep);
      insist(block && /^\s*run:\s*node scripts\/inputs\.mjs\s*$/m.test(block),
        'rejection', 'The exact failed step must invoke the unchanged trusted participant validator.');
      insist(time(matches[0].completed_at) <= at, 'rejection', 'The failed input step has no valid completion timestamp.');
    }
    return { runId: run.id, workflowPath: run.path, event: run.event, runCreatedAt: run.created_at,
      validationJobId: validation.id, validationCompletedAt: validation.completed_at };
  }
  profile(state) {
    insist(this.repository.private === true && this.repository.visibility === 'private' && this.repository.is_template === false && this.repository.fork === false &&
      APPROVED_LIVE_REPOSITORIES[this.repository.id] === this.repository.full_name, 'offline',
    'Live evidence is limited to the two exact approved private simulation IDs/names. This copy stays offline; the guide cannot enable or authorize Azure.');
    insist(DIGEST.test(this.env.WORKSHOP_OWNER_PROFILE_SHA256 ?? ''), 'profile', 'The owner-managed root/profile digest is missing.');
    const value = parseStrictJson(this.env.WORKSHOP_OWNER_PROFILE_JSON ?? '');
    const digest = hash(canonicalJson(value));
    insist(digest === this.env.WORKSHOP_OWNER_PROFILE_SHA256 && value.schemaVersion === 1 && value.repositoryId === String(this.repository.id) &&
      value.repository === this.repository.full_name && value.root === this.config.root && value.profile === this.config.profile &&
      typeof value.owner?.id === 'string' && /^[1-9][0-9]{0,15}$/.test(value.owner.id) &&
      positive(Number(value.owner.id)) && LOGIN.test(value.owner.login ?? '') &&
      Array.isArray(value.assignment?.learner_user_ids) && value.assignment.learner_user_ids.every(positive) &&
      new Set(value.assignment.learner_user_ids).size === value.assignment.learner_user_ids.length &&
      value.assignment.learner_user_ids.some(id => state.root.learnerIds.includes(id) && this.learnerIds.includes(id)) &&
      /^[a-z][a-z0-9]{1,11}$/.test(value.assignment.participant_name ?? '') && value.assignment.instance_number === '001' &&
      DIGEST.test(value.deliveryWorkflowSha256 ?? '') && DIGEST.test(value.cleanupWorkflowSha256 ?? ''),
    'profile', 'The protected owner profile does not match this repository, root, participant or pinned workflows.');
    insist(time(value.expiresAt) > time(value.approvedAt) && time(value.expiresAt) - time(value.approvedAt) <= 86400000,
      'profile', 'The profile lifetime is invalid.');
    return { value, digest };
  }
  observationName(profile, participantDigest, operation, result) {
    // Parent live workflows must emit this EXACT successful step name inside
    // the corresponding real job, AFTER their trusted admission/readback checks.
    // owner = SHA256(sorted-key canonical owner-profile JSON); participant is
    // the equivalent strict participant JSON digest. No artifact/log is trusted.
    // Job/run identity, SHA, event, main, attempt and timestamps come from the
    // Actions API, not from this string. The owner pins original workflow bytes.
    return `${this.config.observationStepPrefix} root=${this.config.root} profile=${this.config.profile}` +
      ` owner=${profile.digest} participant=${participantDigest} operation=${operation} result=${result}`;
  }
  observation(job, profile, participantDigest, operation, result, after, at) {
    const expected = this.observationName(profile, participantDigest, operation, result);
    const matches = job.steps.filter(step => step.name === expected);
    insist(matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === 'success' &&
      time(matches[0].completed_at) > time(after) && time(matches[0].completed_at) <= at &&
      time(matches[0].completed_at) >= time(job.started_at) && time(matches[0].completed_at) <= time(job.completed_at) &&
      time(matches[0].completed_at) <= time(profile.value.expiresAt),
    'readback', 'The trusted same-run checks did not publish the exact successful root/profile/participant readback step.');
    return matches[0].completed_at;
  }
  receipt(state, stepId) {
    const receipt = state.receipts.find(entry => entry.stepId === stepId);
    insist(receipt, 'preceding', 'The required own preceding receipt is missing.');
    return receipt;
  }
  async mergedPr(state, run, preceding, at) {
    const number = preceding.evidence.pullNumber;
    insist(positive(number), 'merge', 'The recorded learner input PR is missing.');
    const associated = await this.list(this.github.rest.repos.listPullRequestsAssociatedWithCommit, { commit_sha: run.head_sha });
    insist(associated.some(pr => pr.number === number), 'merge', 'The main revision is not associated with the recorded input PR.');
    const pr = (await this.github.rest.pulls.get({ ...this.params, pull_number: number })).data;
    insist(pr.number === number && pr.merged === true && pr.state === 'closed' && pr.base?.ref === 'main' && pr.draft === false &&
      sameRepo(pr.base.repo, this.repository) && sameRepo(pr.head?.repo, this.repository) && pr.head.sha === preceding.revision &&
      pr.merge_commit_sha === run.head_sha && time(pr.merged_at) > time(preceding.recordedAt) && time(pr.merged_at) <= time(run.created_at) &&
      time(pr.merged_at) <= at, 'merge', 'Require an actual later protected-main merge of the exact recorded learner PR revision.');
    return pr.number;
  }
  async live(state, hint, { kind = 'delivery', at = this.now(), historical = false, after = state.activeAt,
    fixedRunId, expectedRevision, preceding } = {}) {
    const profile = this.profile(state);
    const operation = kind === 'followup' ? 'followup' : kind === 'cleanup' ? 'destroy' : 'deploy';
    const workflowPath = kind === 'cleanup' ? this.config.workflowPaths.cleanup : this.config.workflowPaths.delivery;
    let revision = expectedRevision ?? hint?.revision;
    if (!historical) {
      const main = await branchHead(this.github, this.repository, 'main');
      insist(main?.protected === true, 'main', 'A real protected main branch is required.');
      insist(!revision || main.commit.sha === revision, 'stale', 'Main moved away from the recorded live revision.');
      revision = main.commit.sha;
    }
    insist(SHA.test(revision ?? ''), 'live', 'The live learner revision is missing.');
    const event = operation === 'deploy' ? 'push' : 'workflow_dispatch';
    const candidates = fixedRunId || hint?.runId ? [{ id: fixedRunId ?? hint.runId }] :
      (await this.runs(state)).filter(run => run.head_sha === revision && run.head_branch === 'main' && run.path === workflowPath && run.event === event);
    insist(candidates.length > 0, 'live', 'No genuine current-main live run with the exact workflow/event was observed.');
    const run = await this.run(candidates[0].id, state, { revision, branch: 'main', workflowPath,
      events: [event], complete: 'success', after, at, live: true });
    insist(profile.value.assignment.learner_user_ids.includes(run.actor.id) ||
      (String(run.actor.id) === profile.value.owner.id && run.actor.login === profile.value.owner.login),
    'identity', 'The live run actor is not assigned to this participant or the pinned owner.');
    await this.current('main', revision, historical);
    const workflow = await this.content(workflowPath, revision);
    insist(workflow.digest === profile.value[kind === 'cleanup' ? 'cleanupWorkflowSha256' : 'deliveryWorkflowSha256'],
      'workflow', 'The actual live workflow bytes differ from the protected owner profile pin.');
    insist(time(run.created_at) >= time(profile.value.approvedAt) && time(run.created_at) < time(profile.value.expiresAt),
      'profile', 'The run did not start in the approved owner-profile window.');
    const participant = await this.participant(revision, profile.value.assignment.participant_name);
    const jobs = await this.jobs(run, at);
    const preflight = this.job(jobs, this.config.jobs.preflight);
    this.observation(preflight, profile, participant.digest, operation, 'admitted', after, at);
    const names = [this.config.jobs.preflight, this.config.jobs.liveValidation];
    if (kind === 'delivery') names.push(this.config.jobs.plan, this.config.jobs.apply, this.config.jobs.packaging);
    if (kind === 'followup') names.push(this.config.jobs.followup);
    if (kind === 'cleanup') names.push(this.config.jobs.destroyPlan, this.config.jobs.destroy);
    const required = names.map(name => this.job(jobs, name));
    const completedAt = required.map(job => job.completed_at).sort((a, b) => time(b) - time(a))[0];
    insist(time(completedAt) <= time(profile.value.expiresAt), 'profile', 'The live checks completed outside the approved profile window.');
    if (operation === 'followup') this.observation(this.job(jobs, this.config.jobs.followup), profile, participant.digest, operation, 'no-change', after, at);
    if (operation === 'destroy') this.observation(this.job(jobs, this.config.jobs.destroy), profile, participant.digest, operation, 'destroyed', after, at);
    const evidence = { revision, runId: run.id, workflowPath, event, branch: 'main', actorId: run.actor.id,
      runCreatedAt: run.created_at, completedAt, jobIds: required.map(job => job.id), participantSha256: participant.digest,
      ownerProfileSha256: profile.digest, operation };
    if (preceding) {
      insist(profile.value.assignment.learner_user_ids.includes(preceding.evidence.authorId),
        'identity', 'The recorded input PR author is not assigned to this participant.');
      evidence.pullNumber = await this.mergedPr(state, run, preceding, at);
      insist(participant.digest === preceding.evidence.participantSha256, 'participant', 'Merged inputs differ from the recorded checked PR inputs.');
    }
    return { run, jobs, profile, participant, evidence };
  }
  async evaluate(step, state, hint, options = {}) {
    const { historical = false, at = this.now() } = options;
    const taskGate = ['task-push', 'installed-workflow', 'open-pr', 'current-ci', 'participant-change', 'input-pr-ci', 'purple-rejection'].includes(step.gate);
    if (taskGate) {
      const task = await this.task(state, hint, { historical, at });
      let evidence = { ...task };
      if (step.gate === 'installed-workflow') evidence.workflowSha256 = await this.installed(state, task.revision);
      if (['open-pr', 'input-pr-ci'].includes(step.gate)) Object.assign(evidence, await this.pr(state, task, hint, { historical, at }));
      if (['participant-change', 'input-pr-ci'].includes(step.gate)) {
        const participant = await this.participant(task.revision);
        const original = await this.participant(state.root.startRevision);
        insist(participant.digest !== original.digest, 'participant', 'Change the actual strict participant JSON from the course-start source.');
        if (step.gate === 'input-pr-ci') {
          const preceding = this.receipt(state, 's2-1');
          const firstInput = await this.participant(preceding.revision);
          insist(firstInput.input.participant_name === participant.input.participant_name &&
            firstInput.input.instance_number === participant.input.instance_number,
          'participant', 'The current checked PR must retain the chosen participant name and fixed instance.');
        }
        evidence.participantSha256 = participant.digest;
      }
      if (step.gate === 'current-ci' || step.gate === 'input-pr-ci') Object.assign(evidence, await this.ci(state, task, hint, { historical, at }));
      if (step.gate === 'purple-rejection') {
        const previous = this.receipt(state, 's2-3');
        const deployed = await this.participant(previous.revision);
        const raw = parseStrictJson((await this.content(this.config.participantPath, task.revision)).text);
        insist(raw.page_theme === 'purple', 'rejection', 'The intended negative fixture is exactly page_theme purple.');
        validateParticipant({ ...raw, page_theme: 'blue' }, deployed.input.participant_name);
        insist(raw.instance_number === deployed.input.instance_number, 'participant', 'Do not rename the preceding deployment.');
        let rejection;
        try { validateParticipant(raw); } catch (error) { rejection = error.code; }
        insist(rejection === 'theme', 'rejection', 'The only intended participant validation rejection must be the purple theme.');
        Object.assign(evidence, await this.ci(state, task, hint, { historical, at, failure: true }), {
          participantSha256: hash(canonicalJson(raw)), rejection: 'page_theme:purple',
          validatorSha256: (await this.content(this.config.validatorPath, task.revision)).digest,
        });
      }
      return { revision: task.revision, evidence };
    }
    if (step.gate === 'initial-delivery') {
      const preceding = this.receipt(state, 's2-2');
      const live = await this.live(state, hint, { historical, at, preceding });
      return { revision: live.run.head_sha, evidence: live.evidence };
    }
    if (step.gate === 'updated-delivery') {
      const broken = this.receipt(state, 's3-2');
      const first = this.receipt(state, 's2-3');
      // The update PR is observed independently after the negative fixture; its
      // successful merged revision need not be the failed task-branch revision.
      const live = await this.live(state, hint, { historical, at, after: broken.evidence.validationCompletedAt });
      const initial = await this.participant(first.revision);
      const updated = live.participant.input;
      insist(updated.participant_name === initial.input.participant_name && updated.instance_number === initial.input.instance_number &&
        updated.page_theme === 'green' && updated.workshop_iteration === '02' && live.run.head_sha !== first.revision &&
        live.run.head_sha !== broken.revision, 'update', 'Require fixed green iteration 02 at a fresh main revision without renaming the workload.');
      const associated = await this.list(this.github.rest.repos.listPullRequestsAssociatedWithCommit, { commit_sha: live.run.head_sha });
      const candidates = associated.filter(pr => pr.base?.ref === 'main' && pr.merge_commit_sha === live.run.head_sha);
      insist(candidates.length === 1, 'merge', 'The update needs unique actual same-repository merged-PR provenance.');
      const pr = (await this.github.rest.pulls.get({ ...this.params, pull_number: candidates[0].number })).data;
      insist(pr.merged === true && pr.state === 'closed' && pr.draft === false && sameRepo(pr.base?.repo, this.repository) &&
        sameRepo(pr.head?.repo, this.repository) && pr.base.ref === 'main' && pr.merge_commit_sha === live.run.head_sha &&
        time(pr.merged_at) > time(broken.recordedAt) && time(pr.merged_at) <= time(live.run.created_at) &&
        human(pr.user, pr) && live.profile.value.assignment.learner_user_ids.includes(pr.user.id) &&
        await this.eligible(pr.user, state), 'merge', 'The fixed input update must be the learner\'s later real merged PR.');
      const checked = await this.participant(pr.head.sha, initial.input.participant_name);
      insist(checked.digest === live.participant.digest, 'participant', 'The merged update input differs from its learner PR.');
      live.evidence.pullNumber = pr.number;
      live.evidence.precedingReceiptHash = first.hash;
      return { revision: live.run.head_sha, evidence: live.evidence };
    }
    if (['initial-verification', 'updated-verification', 'workload-absence'].includes(step.gate)) {
      const sourceId = step.gate === 'initial-verification' ? 's2-3' : step.gate === 'updated-verification' ? 's3-3' : 's4-3';
      const source = this.receipt(state, sourceId);
      const kind = step.gate === 'workload-absence' ? 'cleanup' : 'delivery';
      const live = await this.live(state, { ...hint, revision: source.revision }, { historical, at, kind,
        fixedRunId: source.evidence.runId, expectedRevision: source.revision,
        after: step.gate === 'updated-verification' ? this.receipt(state, 's3-2').evidence.validationCompletedAt : state.activeAt });
      insist(live.profile.digest === source.evidence.ownerProfileSha256 && live.participant.digest === source.evidence.participantSha256,
        'readback', 'Verification must retain the recorded run/root/profile/input binding.');
      const job = this.job(live.jobs, step.gate === 'workload-absence' ? this.config.jobs.absence : this.config.jobs.verification);
      const verifiedAt = this.observation(job, live.profile, live.participant.digest, kind === 'cleanup' ? 'destroy' : 'deploy',
        kind === 'cleanup' ? 'absent' : 'deployed', state.activeAt, at);
      return { revision: source.revision, evidence: { runId: live.run.id, verificationJobId: job.id, verifiedAt,
        ownerProfileSha256: live.profile.digest, participantSha256: live.participant.digest,
        sourceStepId: sourceId, sourceReceiptHash: source.hash } };
    }
    if (step.gate === 'initial-receipt' || step.gate === 'updated-receipt') {
      const source = this.receipt(state, step.gate === 'initial-receipt' ? 's2-4' : 's3-4');
      // Existence of an own recorded successful run is not a fresh Azure probe.
      await this.run(source.evidence.runId, state, { revision: source.revision, branch: 'main',
        workflowPath: this.config.workflowPaths.delivery, events: ['push'], complete: 'success',
        after: state.startedAt, at, live: true });
      return { revision: source.revision, evidence: { sourceStepId: source.stepId, sourceReceiptHash: source.hash,
        runId: source.evidence.runId, ownerProfileSha256: source.evidence.ownerProfileSha256 } };
    }
    if (step.gate === 'no-change' || step.gate === 'authorized-destroy') {
      const preceding = this.receipt(state, step.gate === 'no-change' ? 's3-3' : 's4-2');
      const live = await this.live(state, { ...hint, revision: preceding.revision }, { historical, at,
        kind: step.gate === 'no-change' ? 'followup' : 'cleanup', expectedRevision: preceding.revision,
        after: step.gate === 'no-change' ? state.activeAt : preceding.evidence.completedAt });
      insist(live.profile.digest === preceding.evidence.ownerProfileSha256 && live.participant.digest === preceding.evidence.participantSha256,
        'readback', 'Followup/cleanup must retain this learner\'s preceding deployment binding.');
      live.evidence.sourceReceiptHash = preceding.hash;
      return { revision: live.run.head_sha, evidence: live.evidence };
    }
    throw new GuideError('course', 'Unknown evidence gate.');
  }
}

function commonRecord(config, repository, issueNumber, kind) {
  return { schemaVersion: 1, kind, courseId: config.id, courseDigest: hash(canonicalJson(config)), repositoryId: repository.id, issueNumber };
}
function recordBody(record) {
  let text;
  if (record.kind === 'register') text = '**AgentAlvine** registered this one Exercise. The bot account is technical automation, never the enrolled learner.';
  else if (record.kind === 'start') text = '**AgentAlvine** started a new enrolled course cycle. Only subsequent real GitHub evidence can progress it.';
  else if (record.kind === 'step') text = `**AgentAlvine** recorded ${record.stepId} at immutable revision ${record.revision}. This receipt is not Azure authorization.`;
  else if (record.kind === 'gate') text = `**AgentAlvine — Section ${record.section} is verified 4/4.**\n\n` +
    `Pause here. Only AFTER this prompt, an enrolled human with current write access may post the exact whole comment:\n\n` +
    `\`${COMMAND}\`\n\nThis opens Section ${record.section + 1}, Step 1 only. It never approves or dispatches a deployment. Early comments are not queued.`;
  else if (record.kind === 'advance') text = `**AgentAlvine** consumed human comment ${record.commandCommentId} for Section ${record.fromSection} → ${record.toSection}. ` +
    `Only ${record.nextStepId} is now open. No deployment was authorized or dispatched.`;
  else throw new GuideError('journal', 'Unknown journal record.');
  return `${text}\n\n${RECORD}${JSON.stringify(record)}${END_RECORD}`;
}
function journalFingerprint(comments) {
  return hash(canonicalJson(comments.filter(comment => technicalBot(comment) && comment.body?.includes(RECORD))
    .map(comment => ({ id: comment.id, body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at }))
    .sort((a, b) => a.id - b.id)));
}
function parseRecords(comments, issue, repository, config, now) {
  const entries = [];
  const seen = new Set();
  for (const comment of comments) {
    // A human copying a hidden marker cannot create authority. Neither can an
    // issue-body checkbox, pasted state cache, other bot or installed App.
    if (!technicalBot(comment) || !comment.body?.includes(RECORD)) continue;
    insist(positive(comment.id) && !seen.has(comment.id) && comment.updated_at === comment.created_at &&
      time(comment.created_at) >= time(issue.created_at) && time(comment.created_at) <= now &&
      comment.issue_url === `https://api.github.com/repos/${repository.full_name}/issues/${issue.number}`,
    'journal', 'A journal comment is duplicated, edited, future-dated or attached to the wrong issue.');
    seen.add(comment.id);
    const start = comment.body.indexOf(RECORD);
    const finish = comment.body.indexOf(END_RECORD, start + RECORD.length);
    insist(finish >= 0 && comment.body.indexOf(RECORD, start + RECORD.length) === -1, 'journal', 'Malformed bot journal record.');
    const record = parseStrictJson(comment.body.slice(start + RECORD.length, finish));
    insist(Object.hasOwn(RECORD_FIELDS, record.kind), 'journal', 'Unknown bot journal record kind.');
    exact(record, RECORD_FIELDS[record.kind], 'Journal record');
    insist(record.schemaVersion === 1 && record.courseId === config.id && record.courseDigest === hash(canonicalJson(config)) &&
      record.repositoryId === repository.id && record.issueNumber === issue.number && comment.body === recordBody(record),
    'journal', 'Course/repository/issue binding or the immutable prompt text changed.');
    const digest = hash(canonicalJson({ record, commentId: comment.id, createdAt: comment.created_at }));
    entries.push({ record, comment, hash: digest });
  }
  entries.sort((a, b) => time(a.comment.created_at) - time(b.comment.created_at) || a.comment.id - b.comment.id);
  return entries;
}
function exactCommand(comment, repository, issueNumber) {
  return positive(comment?.id) && human(comment.user, comment) && typeof comment.body === 'string' && comment.body.trim() === COMMAND &&
    comment.updated_at === comment.created_at &&
    comment.issue_url === `https://api.github.com/repos/${repository.full_name}/issues/${issueNumber}`;
}
function sameCommentSnapshot(current, candidate, repository, issueNumber) {
  return current && exactCommand(current, repository, issueNumber) && exactCommand(candidate, repository, issueNumber) &&
    current.id === candidate.id && current.user.id === candidate.user.id && current.user.login === candidate.user.login &&
    current.body === candidate.body && current.created_at === candidate.created_at && current.updated_at === candidate.updated_at;
}
async function readCommand({ github, reader, repository, issue, state, candidate, at }) {
  insist(state.gate && exactCommand(candidate, repository, issue.number), 'command', 'Only an unedited exact human command in the registered Exercise can cross a boundary.');
  const current = await optional(async () => (await github.rest.issues.getComment({ ...route(repository), comment_id: candidate.id })).data);
  insist(sameCommentSnapshot(current, candidate, repository, issue.number),
  'command', 'The current comment does not exist or its ID, author, body or edit timestamp differs from the event/readback.');
  insist(time(current.created_at) > time(state.gate.createdAt) && time(current.created_at) <= at &&
    !state.transitions.some(entry => entry.commandCommentId === current.id), 'early-command',
  'The gate prompt must strictly precede the command; an early, replayed or consumed comment cannot be queued or reused.');
  insist(await reader.eligible(current.user, state), 'identity', 'Only an enrolled human with current repository write access may continue.');
  return current;
}

async function inspectLedger({ comments, issue, repository, config, reader, now, verifyEvidence = true }) {
  const entries = parseRecords(comments, issue, repository, config, now);
  insist(entries.length > 0 && entries[0].record.kind === 'register', 'journal', 'The immutable registration receipt is missing. Owner repair is required; body caches are not imported.');
  const registration = entries[0];
  insist(registration.record.defaultBranch === repository.default_branch && SHA.test(registration.record.registeredRevision),
    'journal', 'The registered default branch/revision is invalid.');
  const state = { registrationCommentId: registration.comment.id, registrationHash: registration.hash,
    head: registration.hash, root: null, cycle: null, startedAt: null, activeAt: null,
    section: 1, stepIndex: 0, receipts: [], transitions: [], gate: null, complete: false };
  let previousTime = time(registration.comment.created_at);
  for (const entry of entries.slice(1)) {
    const { record, comment } = entry;
    insist(record.previous === state.head && time(comment.created_at) >= previousTime, 'journal', 'The immutable receipt chain is broken or reordered.');
    if (record.kind === 'start') {
      insist(!state.root && record.registrationCommentId === state.registrationCommentId &&
        record.defaultBranch === repository.default_branch && SHA.test(record.startRevision) &&
        Array.isArray(record.learnerIds) && record.learnerIds.length > 0 && record.learnerIds.length <= 32 &&
        record.learnerIds.every(positive) && new Set(record.learnerIds).size === record.learnerIds.length,
      'journal', 'The start/enrollment receipt is malformed or attempts an implicit course reset.');
      state.root = clone(record);
      state.startedAt = comment.created_at;
      state.activeAt = comment.created_at;
      state.cycle = hash(canonicalJson({ repositoryId: repository.id, issueNumber: issue.number,
        courseDigest: record.courseDigest, registrationCommentId: state.registrationCommentId,
        startCommentId: comment.id, startedAt: comment.created_at }));
    } else {
      insist(state.root && record.cycle === state.cycle, 'journal', 'A receipt belongs to a different course cycle.');
      if (record.kind === 'step') {
        const step = config.sections[state.section - 1].steps[state.stepIndex];
        insist(!state.gate && step && step.id === record.stepId && SHA.test(record.revision ?? '') && object(record.evidence),
          'journal', 'A step is out of order or tries to cross a section boundary.');
        if (verifyEvidence) {
          const observed = await reader.evaluate(step, state, record.evidence, { historical: true, at: time(comment.created_at) });
          insist(observed.revision === record.revision && canonicalJson(observed.evidence) === canonicalJson(record.evidence),
            'journal', 'Cached receipt facts do not match rederived immutable GitHub/source evidence.');
        }
        state.receipts.push({ stepId: record.stepId, revision: record.revision, evidence: clone(record.evidence),
          commentId: comment.id, recordedAt: comment.created_at, hash: entry.hash });
        state.stepIndex++;
      } else if (record.kind === 'gate') {
        insist(state.section < 4 && state.stepIndex === 4 && !state.gate && record.section === state.section &&
          record.stepReceiptHash === state.receipts.at(-1)?.hash, 'journal', 'Only a verified fourth step in Sections 1–3 can publish a gate prompt.');
        state.gate = { section: state.section, commentId: comment.id, createdAt: comment.created_at,
          id: hash(canonicalJson({ cycle: state.cycle, section: state.section, promptCommentId: comment.id,
            createdAt: comment.created_at, stepReceiptHash: record.stepReceiptHash })) };
      } else if (record.kind === 'advance') {
        insist(state.gate && state.section < 4 && state.stepIndex === 4 && record.fromSection === state.section &&
          record.toSection === state.section + 1 && record.nextStepId === `s${state.section + 1}-1` &&
          record.gateCommentId === state.gate.commentId && record.gateId === state.gate.id &&
          record.promptCreatedAt === state.gate.createdAt && positive(record.commandCommentId) &&
          positive(record.commandAuthorId) && DIGEST.test(record.commandBodySha256 ?? '') && state.transitions.length < 3,
        'journal', 'A transition is not bound to the current cycle/section/gate/prompt/command.');
        const candidate = await optional(async () => (await reader.github.rest.issues.getComment({ ...route(repository), comment_id: record.commandCommentId })).data);
        insist(candidate && candidate.user?.id === record.commandAuthorId && candidate.created_at === record.commandCreatedAt &&
          hash(candidate.body ?? '') === record.commandBodySha256, 'journal', 'The consumed human command no longer matches its immutable receipt.');
        await readCommand({ github: reader.github, reader, repository, issue, state, candidate, at: time(comment.created_at) });
        state.transitions.push({ commandCommentId: record.commandCommentId, fromSection: record.fromSection, toSection: record.toSection,
          gateCommentId: record.gateCommentId, gateId: record.gateId, recordedAt: comment.created_at, hash: entry.hash });
        state.section++;
        state.stepIndex = 0;
        state.activeAt = comment.created_at;
        state.gate = null;
      } else throw new GuideError('journal', 'Duplicate registration/start or unknown lifecycle record.');
    }
    state.head = entry.hash;
    previousTime = time(comment.created_at);
  }
  state.complete = state.section === 4 && state.stepIndex === 4 && state.transitions.length === 3 && !state.gate;
  insist(state.receipts.length === (state.section - 1) * 4 + state.stepIndex, 'journal', 'The section/receipt shape is inconsistent.');
  return state;
}

function setupInstructions() {
  return 'The repository owner must open **Settings → Secrets and variables → Actions → Variables** and set ' +
    '**WORKSHOP_LEARNER_USER_IDS** to a JSON array of the enrolled humans\' positive numeric GitHub user IDs, for example `[12345678]`. ' +
    'Those users must currently have write, maintain or admin access. Use a repository variable, not an issue checkbox, comment, login name, bot author or secret. ' +
    'A later normal trusted-default event will retry setup. This does not grant deployment permission.';
}
// Published reference files only, not directory-prefix or filesystem discovery.
// In particular, plans, state, owner profiles, local output and arbitrary new
// files must never acquire a link (or become a public image) through this view.
const LESSON_FILES = new Map([
  ...['start-here', 'architecture', 'parameters', 'verification', 'recovery', 'instructor-setup']
    .map(name => [`docs/${name}.md`, 'trusted']),
  ['docs/images/NOTICE.md', 'trusted'], ['docs/images/manifest.json', 'trusted'],
  ['full-ws-content/README.md', 'trusted'],
  ...GATES.flatMap((steps, section) => steps.flatMap((_, index) => {
    const id = `s${section + 1}-${index + 1}`;
    return [[`.github/steps/${id}.md`, 'trusted'], [`full-ws-content/${id}.md`, 'trusted'],
      [`docs/images/${id}.png`, 'image']];
  })),
  ...['setup-enterprise', 'setup-clone', 'boundary'].map(name => [`docs/images/${name}.png`, 'image']),
  ['exercise/participant.json', 'learner'], ['.github/workflows/learner-checks.yml', 'learner'],
  ...['backend', 'locals', 'network', 'outputs', 'providers', 'resource-group', 'storage', 'variables', 'versions', 'web']
    .map(name => [`infra/${name}.tf`, 'learner']),
  ['infra/.terraform.lock.hcl', 'learner'], ['infra/tests/workshop.tftest.hcl', 'learner'],
  ...['server.mjs', 'package.json', 'package-lock.json', 'public/style.css', 'public/page.js']
    .map(name => [`app/${name}`, 'learner']),
  ['exercise/workflow-starter.yml', 'start'], ['exercise/validation-workflow.yml', 'start'],
  ['.github/agentalvine/course.json', 'start'], ['package.json', 'start'], ['package-lock.json', 'start'],
  ...['guide', 'quality', 'delivery', 'cleanup'].map(name => [`.github/workflows/${name}.yml`, 'start']),
  ...['azure-readback.mjs', 'capture-references.mjs', 'check.mjs', 'content-check.mjs', 'delivery.mjs',
    'deployment-authorization.cjs', 'doctor.mjs', 'inputs.mjs', 'package-app.mjs', 'plan-envelope.mjs',
    'plan-policy.mjs', 'preview.mjs', 'preview.css', 'preview-extra.css', 'terraform-check.mjs']
    .map(name => [`scripts/${name}`, 'start']),
]);
function lessonLink(destination, image, { config, repository, step, state, trustedRevision }) {
  insist(!/[\u0000-\u001f\u007f]/.test(destination), 'lesson-link', 'A lesson link contains unsafe characters.');
  if (destination.startsWith('#')) return destination;
  if (/^https:\/\//i.test(destination)) {
    let url;
    try { url = new URL(destination); } catch { /* rejected below */ }
    insist(url?.protocol === 'https:' && url.hostname && !url.username && !url.password,
      'lesson-link', 'Only valid external HTTPS lesson links are supported.');
    return destination;
  }
  const fragmentAt = destination.indexOf('#');
  const filename = fragmentAt < 0 ? destination : destination.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : destination.slice(fragmentAt);
  // All published target paths are ASCII. Reject encoded/entity/backslash
  // spellings rather than letting Markdown, URL and GitHub decoders disagree.
  insist(/^[.A-Za-z0-9_/-]+$/.test(filename) && !filename.startsWith('/') &&
    !['', '.', '..'].includes(filename.split('/').at(-1)) &&
    !/[\s<>"'`\\]/.test(fragment), 'lesson-link', 'The lesson link target is unsupported or unsafe.');
  const parts = path.posix.dirname(step.lesson).split('/');
  for (const part of filename.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      insist(parts.length > 0, 'lesson-link', 'A lesson link must remain inside the repository root.');
      parts.pop();
    } else parts.push(part);
  }
  const resolved = parts.join('/');
  const kind = LESSON_FILES.get(resolved);
  insist(kind && (!image || kind === 'image'), 'lesson-link', 'The lesson link is not a published allowlisted file or reference image.');
  const encoded = resolved.split('/').map(encodeURIComponent).join('/');
  if (kind === 'image') {
    // These are public, attributed REFERENCE screenshots only. Never substitute
    // the private copy, a learner revision, input, artifact or participant data.
    return `https://raw.githubusercontent.com/${config.sourceRepository}/${config.sourceDefaultBranch}/${encoded}${fragment}`;
  }
  const startRevision = state?.root?.startRevision ?? trustedRevision;
  // Until a learner receipt exists, participant links show the observed starter
  // source. Afterwards use its actual immutable receipt revision, never the
  // comment's context.sha, a guessed task branch or a mutable default-branch URL.
  const revision = kind === 'learner' ? state?.receipts.at(-1)?.revision ?? startRevision :
    kind === 'start' ? startRevision : trustedRevision;
  insist(SHA.test(revision ?? ''), 'lesson-link', 'An immutable observed source revision is required for lesson links.');
  return `https://github.com/${repository.full_name}/blob/${revision}/${encoded}${fragment}`;
}
function markdownDestination(source, from) {
  let index = from;
  while (/[ \t\r\n]/.test(source[index] ?? '')) index++;
  const angle = source[index] === '<';
  const start = index + (angle ? 1 : 0);
  index = start;
  let depth = 0;
  for (; index < source.length; index++) {
    const character = source[index];
    if (character === '\\') { index++; continue; }
    if (angle) {
      if (character === '>') return { start, end: index, after: index + 1 };
      if (/[\r\n<]/.test(character)) return null;
    } else {
      if (/\s/.test(character) || (character === ')' && depth === 0)) break;
      if (character === '<') return null;
      if (character === '(') depth++;
      if (character === ')') depth--;
    }
  }
  return angle || depth !== 0 ? null : { start, end: index, after: index };
}
function markdownDestinationEnd(source, after, reference = false) {
  let index = after;
  while (/[ \t\r\n]/.test(source[index] ?? '')) index++;
  if (reference ? index === source.length : source[index] === ')') return index + (reference ? 0 : 1);
  if (index === after || !['"', "'", '('].includes(source[index])) return null;
  const close = source[index] === '(' ? ')' : source[index];
  for (index++; index < source.length && source[index] !== close; index++) if (source[index] === '\\') index++;
  if (source[index] !== close) return null;
  index++;
  while (/[ \t\r\n]/.test(source[index] ?? '')) index++;
  return (reference ? index === source.length : source[index] === ')') ? index + (reference ? 0 : 1) : null;
}
function absoluteLessonLinks(markdown, context) {
  insist(typeof markdown === 'string', 'lesson-link', 'The trusted lesson must be Markdown text.');
  const destinations = [];
  const imageReferences = new Set();
  const referenceName = name => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const escaped = (source, index) => {
    let count = 0;
    while (index > 0 && source[--index] === '\\') count++;
    return count % 2 === 1;
  };
  function scan(source, offset) {
    const labels = [];
    for (let index = 0; index < source.length; index++) {
      if (index === 0 || source[index - 1] === '\n') {
        const definition = source.slice(index).match(/^ {0,3}\[([^\]\r\n]+)\]:[ \t]*/);
        if (definition) {
          const end = source.indexOf('\n', index);
          const line = source.slice(index, end < 0 ? source.length : end);
          const token = markdownDestination(line, definition[0].length);
          if (token && markdownDestinationEnd(line, token.after, true) !== null) {
            destinations.push({ start: offset + index + token.start, end: offset + index + token.end,
              reference: referenceName(definition[1]) });
            index += line.length - 1;
            continue;
          }
        }
      }
      if (source[index] === '\\') { index++; continue; }
      if (source[index] === '`') {
        const delimiter = source.slice(index).match(/^`+/)[0];
        let next = index + delimiter.length;
        let finish;
        while ((next = source.indexOf(delimiter, next)) !== -1) {
          if (source[next - 1] !== '`' && source[next + delimiter.length] !== '`') { finish = next + delimiter.length; break; }
          next += delimiter.length;
        }
        index = (finish ?? index + delimiter.length) - 1;
        continue;
      }
      if (source[index] === '[') labels.push({ index, image: source[index - 1] === '!' && !escaped(source, index - 1) });
      if (source[index] !== ']' || labels.length === 0) continue;
      const label = labels.pop();
      if (source[index + 1] === '(') {
        const token = markdownDestination(source, index + 2);
        const finish = token && markdownDestinationEnd(source, token.after);
        if (finish !== null && finish !== undefined) {
          destinations.push({ start: offset + token.start, end: offset + token.end, image: label.image });
          index = finish - 1;
          continue;
        }
      }
      if (label.image) {
        const reference = source.slice(index + 1).match(/^\[([^\]\r\n]*)\]/);
        imageReferences.add(referenceName(reference?.[1] || source.slice(label.index + 1, index)));
        if (reference) index += reference[0].length;
      }
    }
  }
  // Preserve exact fence/code bytes, including CRLF, longer closing delimiters,
  // shorter nested markers and unclosed fences. No Markdown reserialization.
  let fence = null;
  let prose = 0;
  let offset = 0;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const text = line.replace(/\r?\n$/, '');
    if (fence) {
      const close = text.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
        prose = offset + line.length;
      }
    } else {
      const open = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
        scan(markdown.slice(prose, offset), prose);
        fence = open[1];
      }
    }
    offset += line.length;
  }
  if (!fence) scan(markdown.slice(prose), prose);
  for (const token of destinations.sort((left, right) => right.start - left.start)) {
    const destination = markdown.slice(token.start, token.end);
    const absolute = lessonLink(destination, token.image || imageReferences.has(token.reference), context);
    markdown = markdown.slice(0, token.start) + absolute + markdown.slice(token.end);
  }
  return markdown;
}
function renderIssue({ config, repository, state = null, lesson = '', blocked = null, preview = false, trustedRevision }) {
  const section = state?.section ?? 1;
  const index = Math.min(state?.stepIndex ?? 0, 3);
  const entry = config.sections[section - 1];
  const step = entry.steps[index];
  const total = state?.receipts.length ?? 0;
  const counts = config.sections.map(item => `${item.number}: ${state?.receipts.filter(receipt => receipt.stepId.startsWith(`s${item.number}-`)).length ?? 0}/4`).join(' · ');
  let status = preview ? '**Preview — read-only, zero progress.** No Exercise is started, graded, updated or closed.' :
    blocked ? `**Setup/evidence blocked.** ${blocked}` :
      state?.complete ? '**Complete — 16/16 verified.** No fourth section command is needed. The complete final lesson remains below.' :
        state?.stepIndex === 4 ? `**Section ${section}: 4/4 verified — paused.** Wait for the gate prompt, then post \`${COMMAND}\` after it. ` +
          'Only the next section\'s first step will open. There is no automatic boundary crossing.' : '**Follow the current lesson.** Progress inside this section is automatic only when real evidence passes.';
  if (!preview && (!state?.root || blocked?.includes('enroll'))) status += `\n\n${setupInstructions()}`;
  trustedRevision ??= state?.root?.startRevision;
  insist(SHA.test(trustedRevision ?? ''), 'lesson-link', 'The trusted default source revision is required for rendering.');
  const reference = `https://github.com/${repository.full_name}/blob/${trustedRevision}/${step.lesson}`;
  const renderedLesson = lesson ? absoluteLessonLinks(lesson, { config, repository, step, state, trustedRevision }) :
    '**Lesson unavailable on the trusted default branch.** The owner must install this lesson before it can be graded.';
  return `# Exercise — AgentAlvine\n\n${status}\n\n` +
    `Verified: **${preview ? 0 : total}/16** · Sections ${preview ? '1: 0/4 · 2: 0/4 · 3: 0/4 · 4: 0/4' : counts}\n\n` +
    `## Section ${section}/4 — ${entry.title}\n### Step ${index + 1}/4 — ${step.title}\n\n` +
    `${renderedLesson}\n\n` +
    `---\n[Trusted lesson source](${reference})\n\n` +
    'AgentAlvine is the guide persona; github-actions[bot] is its technical account. Issue checkboxes, pasted caches and comments are not evidence. ' +
    'A push does not prove installation/human UI activity; workflow verification does not prove a human visited the Azure portal. ' +
    'This guide never merges, enables, dispatches, deploys or authorizes cleanup. Section pauses do not stop billing or extend an owner-approved lifetime.\n';
}

class JournalSession {
  constructor({ github, repository, config, reader, now, issue, comments, readLesson, trustedRevision }) {
    Object.assign(this, { github, repository, config, reader, now, issue, comments, readLesson, trustedRevision });
    this.params = route(repository);
    this.state = null;
  }
  async load(verifyEvidence = true) {
    this.state = await inspectLedger({ comments: this.comments, issue: this.issue, repository: this.repository,
      config: this.config, reader: this.reader, now: this.now(), verifyEvidence });
    return this.state;
  }
  async guard() {
    // Workflow concurrency serializes our writers. Re-read state immediately
    // before EACH mutation; never reopen a closed issue or overwrite a new
    // journal head using an earlier event snapshot.
    const issue = (await this.github.rest.issues.get({ ...this.params, issue_number: this.issue.number })).data;
    insist(issue.number === this.issue.number && issue.id === this.issue.id && !issue.pull_request && technicalBot(issue) && issue.state === 'open',
      'closed', 'The registered actual Exercise is no longer an open bot-authored issue.');
    const comments = await this.reader.list(this.github.rest.issues.listComments, { issue_number: issue.number });
    insist(journalFingerprint(comments) === journalFingerprint(this.comments), 'conflict', 'Another writer changed the journal; reconcile on the next serialized event.');
    this.issue = issue;
    this.comments = comments;
    return issue;
  }
  async append(record) {
    await this.guard();
    const body = recordBody(record);
    const created = (await this.github.rest.issues.createComment({ ...this.params, issue_number: this.issue.number, body })).data;
    insist(technicalBot(created) && created.body === body && created.updated_at === created.created_at,
      'journal', 'GitHub did not return the exact immutable bot receipt.');
    this.comments.push(created);
    // Only records just evaluated by this invocation use this fast path. Every
    // new invocation rederives ALL stored step evidence with verifyEvidence=true.
    await this.load(false);
  }
  record(kind, fields) {
    return { ...commonRecord(this.config, this.repository, this.issue.number, kind),
      ...(kind === 'register' ? {} : { previous: this.state?.head }),
      ...(['step', 'gate', 'advance'].includes(kind) ? { cycle: this.state.cycle } : {}), ...fields };
  }
  lesson() {
    const section = this.state?.section ?? 1;
    const step = this.config.sections[section - 1].steps[Math.min(this.state?.stepIndex ?? 0, 3)];
    return this.readLesson(step.lesson);
  }
  async display(blocked = null) {
    const lesson = this.lesson();
    insist(!this.state?.complete || (typeof lesson === 'string' && lesson.trim()), 'lesson',
      'The entire final lesson must be available before this completed Exercise can be rendered and closed. Owner repair is required; no fourth command is needed.');
    await this.guard();
    const body = renderIssue({ config: this.config, repository: this.repository, state: this.state, lesson, blocked,
      trustedRevision: this.trustedRevision });
    const close = this.state?.complete && !blocked;
    if (body === this.issue.body && !close) return;
    await this.github.rest.issues.update({ ...this.params, issue_number: this.issue.number, body, ...(close ? { state: 'closed' } : {}) });
  }
  async ensureGate() {
    if (this.state.section < 4 && this.state.stepIndex === 4 && !this.state.gate) {
      await this.append(this.record('gate', { section: this.state.section, stepReceiptHash: this.state.receipts.at(-1).hash }));
    }
  }
  async feedback(comment) {
    const marker = `<!-- agentalvine:early:${this.state.cycle}:${comment.id} -->`;
    if (this.comments.some(entry => technicalBot(entry) && entry.body?.includes(marker))) return;
    await this.guard();
    await this.github.rest.issues.createComment({ ...this.params, issue_number: this.issue.number,
      body: `**AgentAlvine:** this command was early. Finish this section and wait for its 4/4 gate prompt, then create a NEW exact comment after that prompt. ` +
        `This comment is not queued and cannot be reused.\n\n${marker}` });
  }
  async advance(candidate) {
    const command = await readCommand({ github: this.github, reader: this.reader, repository: this.repository,
      issue: this.issue, state: this.state, candidate, at: this.now() });
    await this.guard();
    // A second current read narrows the edit/delete/access-revocation race. The
    // journal then records consumption and advancement in ONE immutable append.
    await readCommand({ github: this.github, reader: this.reader, repository: this.repository,
      issue: this.issue, state: this.state, candidate: command, at: this.now() });
    const from = this.state.section;
    const gate = this.state.gate;
    await this.append(this.record('advance', { fromSection: from, toSection: from + 1,
      gateCommentId: gate.commentId, gateId: gate.id, promptCreatedAt: gate.createdAt,
      commandCommentId: command.id, commandAuthorId: command.user.id, commandCreatedAt: command.created_at,
      commandBodySha256: hash(command.body), nextStepId: `s${from + 1}-1` }));
    await this.display();
  }
}

async function findExercise({ github, repository, config }) {
  const params = route(repository);
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...params, state: 'all', creator: BOT_LOGIN, per_page: 100 });
  insist(Array.isArray(issues) && issues.length <= 10000, 'registration', 'Exercise inventory is incomplete.');
  const candidates = [];
  for (const issue of issues.filter(issue => !issue.pull_request && technicalBot(issue))) {
    const comments = await github.paginate(github.rest.issues.listComments, { ...params, issue_number: issue.number, per_page: 100 });
    const registered = comments.some(comment => technicalBot(comment) && comment.body?.includes(RECORD) &&
      comment.body.includes(`"courseId":"${config.id}"`));
    if (registered || issue.title === config.issueTitle) candidates.push({ issue, comments });
  }
  insist(candidates.length <= 1, 'registration', 'Multiple candidate Exercise issues exist; the owner must resolve registration, not select one through a comment.');
  return candidates[0] ?? null;
}
function supportedEvent(context) {
  const payload = context.payload ?? {};
  if (context.eventName === 'workflow_dispatch') return payload.inputs?.mode === 'Preview';
  if (context.eventName === 'issue_comment') return payload.action === 'created' && !payload.issue?.pull_request && human(payload.sender, payload);
  if (context.eventName === 'issues') return ['opened', 'edited', 'reopened'].includes(payload.action) && human(payload.sender, payload);
  if (context.eventName === 'pull_request_target') return ['opened', 'synchronize', 'reopened', 'ready_for_review'].includes(payload.action) && human(payload.sender, payload);
  if (context.eventName === 'push') return payload.deleted === false && payload.forced === false && human(payload.sender, payload);
  return context.eventName === 'workflow_run' && payload.action === 'completed';
}

async function run({ github, context, core = {}, env = process.env, config = loadCourse(), now = () => Date.now(),
  readLesson = filename => {
    try { return fs.readFileSync(path.join(ROOT, filename), 'utf8'); } catch { return ''; }
  } }) {
  let session;
  try {
    validateCourse(config);
    if (!supportedEvent(context)) return { status: 'ignored', reason: 'unsupported-or-bot-event' };
    const repository = (await github.rest.repos.get(context.repo)).data;
    repositoryIdentity(repository);
    const payloadRepository = context.payload?.repository;
    insist(sameRepo(payloadRepository, repository) && payloadRepository.default_branch === repository.default_branch &&
      payloadRepository.private === repository.private && payloadRepository.is_template === repository.is_template &&
      `${context.repo.owner}/${context.repo.repo}` === repository.full_name, 'repository', 'The event and current repository identities disagree.');
    const preview = context.eventName === 'workflow_dispatch' && context.payload.inputs?.mode === 'Preview';
    const source = repository.full_name === config.sourceRepository || repository.private !== true || repository.is_template !== false;
    if (source && !preview) return { status: 'inert-source' };
    insist(repository.archived === false && repository.disabled === false && (source || repository.fork === false),
      'repository', 'The guide only starts active nonfork private copies.');
    if (repository.full_name === config.sourceRepository) insist(repository.default_branch === config.sourceDefaultBranch,
      'repository', 'The public source must retain dev as its default branch.');
    const trusted = await branchHead(github, repository, repository.default_branch);
    insist(trusted && env.GUIDE_CHECKOUT_SHA === trusted.commit.sha && env.GITHUB_WORKFLOW_SHA === trusted.commit.sha &&
      env.GITHUB_WORKFLOW_REF === `${repository.full_name}/${config.workflowPaths.guide}@refs/heads/${repository.default_branch}`,
    'untrusted-default', 'Only the current trusted-default workflow and default-branch checkout may run the observer.');
    if (preview) {
      const body = renderIssue({ config, repository, preview: true, trustedRevision: trusted.commit.sha,
        lesson: readLesson(config.sections[0].steps[0].lesson) });
      if (core.summary) await core.summary.addRaw(body).write();
      return { status: 'preview', progress: 0, body };
    }
    let found = await findExercise({ github, repository, config });
    if (context.eventName === 'issue_comment' && (!found || context.payload.issue?.number !== found.issue.number ||
      context.payload.issue?.id !== found.issue.id ||
      context.payload.issue?.state !== 'open' || !exactCommand(context.payload.comment, repository, found.issue.number)))
      return { status: 'ignored', reason: 'not-an-exact-registered-issue-command' };
    if (context.eventName === 'issues' && found && context.payload.issue?.number !== found.issue.number)
      return { status: 'ignored', reason: 'other-issue' };
    if (found?.issue.state === 'closed') return { status: 'ignored', reason: 'closed-exercise' };
    const reader = new EvidenceReader({ github, repository, config, env, learnerIds: [], now });
    let enrollmentError;
    let learnerIds;
    try {
      learnerIds = parseEnrollment(env.WORKSHOP_LEARNER_USER_IDS);
      reader.learnerIds = learnerIds;
      if (context.eventName === 'issue_comment') {
        const candidate = context.payload.comment;
        if (context.payload.sender.id !== candidate.user.id || context.payload.sender.login !== candidate.user.login ||
          !await reader.eligible(candidate.user, { root: { learnerIds } }))
          return { status: 'ignored', reason: 'not-enrolled-current-writer' };
        const starts = parseRecords(found.comments, found.issue, repository, config, now())
          .filter(entry => entry.record.kind === 'start');
        if (starts.length > 1 || (starts.length === 1 && (!Array.isArray(starts[0].record.learnerIds) ||
          !starts[0].record.learnerIds.includes(candidate.user.id))))
          return { status: 'ignored', reason: 'not-enrolled-in-current-cycle' };
        const current = await optional(async () => (await github.rest.issues.getComment({ ...route(repository), comment_id: candidate.id })).data);
        if (!sameCommentSnapshot(current, candidate, repository, found.issue.number) ||
          time(current.created_at) > now() || time(current.created_at) < time(found.issue.created_at))
          return { status: 'ignored', reason: 'comment-readback-mismatch' };
      }
      learnerIds = await reader.activeEnrollment(learnerIds);
    } catch (error) {
      if (!(error instanceof GuideError)) throw error;
      if (context.eventName === 'issue_comment') return ['enrollment', 'identity'].includes(error.code) ?
        { status: 'ignored', reason: 'not-enrolled-current-writer' } : { status: 'setup-blocked', reason: error.code };
      enrollmentError = error.message;
    }
    let newlyCreated = false;
    if (!found) {
      // Re-list immediately before creating to protect first-start registration.
      found = await findExercise({ github, repository, config });
      if (!found) {
        const body = renderIssue({ config, repository, lesson: readLesson(config.sections[0].steps[0].lesson),
          trustedRevision: trusted.commit.sha,
          blocked: enrollmentError ?? 'Registration is being initialized. No work has been graded.' });
        const issue = (await github.rest.issues.create({ ...route(repository), title: config.issueTitle, body })).data;
        insist(technicalBot(issue) && !issue.pull_request && issue.state === 'open', 'registration', 'GitHub did not create an actual open bot Exercise.');
        found = { issue, comments: [] };
        newlyCreated = true;
      }
    }
    session = new JournalSession({ github, repository, config, reader, now, ...found, readLesson, trustedRevision: trusted.commit.sha });
    if (newlyCreated) await session.append(session.record('register', { defaultBranch: repository.default_branch, registeredRevision: trusted.commit.sha }));
    else {
      // A manually edited body cannot repair, initialize or reset a journal.
      // Enrollment may be fixed after registration, but missing/edited receipts
      // must be repaired by the owner, not inferred from checkboxes.
      if (enrollmentError) {
        // Do not display un-rederived cached progress as verified when current
        // enrollment/access cannot be established. The journal is untouched.
        await session.display(enrollmentError);
        return { status: 'setup-blocked', reason: 'enrollment' };
      }
      await session.load();
    }
    if (enrollmentError) {
      await session.display(enrollmentError);
      return { status: 'setup-blocked', reason: 'enrollment' };
    }
    if (!session.state.root) {
      await session.append(session.record('start', { registrationCommentId: session.state.registrationCommentId,
        defaultBranch: repository.default_branch, startRevision: trusted.commit.sha, learnerIds }));
      if (context.eventName === 'issue_comment') await session.feedback(context.payload.comment);
      await session.display();
      return { status: context.eventName === 'issue_comment' ? 'early-command' : 'started', section: 1, step: 1, progress: 0 };
    }
    const state = session.state;
    if (context.eventName === 'issue_comment' && !await reader.eligible(context.payload.comment.user, state))
      return { status: 'ignored', reason: 'not-enrolled-current-writer' };
    if (state.complete) {
      await session.display();
      return { status: 'completed', section: 4, step: 4, progress: 16 };
    }
    if (context.eventName === 'issue_comment' && state.transitions.some(entry => entry.commandCommentId === context.payload.comment.id))
      return { status: 'ignored', reason: 'already-consumed-command' };
    // Frozen cycle membership was checked before even repairing a missing gate.
    // Unenrolled/bot/App/mismatched comment events cause ZERO writes.
    await session.ensureGate();
    if (context.eventName === 'issue_comment') {
      const candidate = context.payload.comment;
      if (!session.state.gate || time(candidate.created_at) <= time(session.state.gate.createdAt)) {
        const current = await optional(async () => (await github.rest.issues.getComment({ ...route(repository), comment_id: candidate.id })).data);
        if (!sameCommentSnapshot(current, candidate, repository, session.issue.number)) return { status: 'ignored', reason: 'comment-readback-mismatch' };
        await session.feedback(candidate);
        return { status: 'early-command', section: session.state.section, progress: session.state.receipts.length };
      }
      // All eligible coalesced comments are considered below, oldest first, so
      // two near-simultaneous commands cannot become two section transitions.
    }
    if (session.state.gate) {
      const candidates = session.comments.filter(comment => exactCommand(comment, repository, session.issue.number) &&
        time(comment.created_at) > time(session.state.gate.createdAt) &&
        !session.state.transitions.some(entry => entry.commandCommentId === comment.id))
        .sort((a, b) => time(a.created_at) - time(b.created_at) || a.id - b.id);
      for (const candidate of candidates) {
        try {
          await readCommand({ github, reader, repository, issue: session.issue, state: session.state, candidate, at: now() });
        } catch (error) { if (error instanceof GuideError) continue; throw error; }
        await session.advance(candidate);
        return { status: 'advanced', section: session.state.section, step: 1, progress: session.state.receipts.length,
          commandCommentId: candidate.id };
      }
      await session.display();
      return { status: 'paused', section: session.state.section, progress: session.state.receipts.length };
    }
    if (context.eventName === 'issue_comment') return { status: 'ignored', reason: 'no-active-gate' };
    // Event snapshots are metadata hints only; reconciliation independently
    // discovers eligible CURRENT heads/runs. Never substitute context.sha.
    await getEventSnapshot({ github, context, repository });
    let pending;
    for (let count = 0; count < 4 && session.state.stepIndex < 4; count++) {
      const step = config.sections[session.state.section - 1].steps[session.state.stepIndex];
      if (!readLesson(step.lesson)?.trim()) { pending = 'The owner must install the current lesson on the trusted default branch.'; break; }
      try {
        const first = await reader.evaluate(step, session.state);
        // Re-read current branch/run/content immediately before recording; an
        // earlier successful result is not a cache authorizing later mutations.
        const current = await reader.evaluate(step, session.state, first.evidence);
        insist(first.revision === current.revision && canonicalJson(first.evidence) === canonicalJson(current.evidence),
          'stale', 'Current evidence changed before its receipt could be recorded.');
        await session.append(session.record('step', { stepId: step.id, revision: current.revision, evidence: current.evidence }));
      } catch (error) {
        if (!(error instanceof GuideError)) throw error;
        pending = error.message;
        break;
      }
    }
    await session.ensureGate();
    await session.display(pending ?? null);
    return { status: session.state.complete ? 'completed' : session.state.gate ? 'paused' : 'pending',
      section: session.state.section, step: Math.min(session.state.stepIndex + 1, 4), progress: session.state.receipts.length,
      ...(pending ? { reason: pending } : {}) };
  } catch (error) {
    // Never log source contents, workflow logs, environment/profile JSON, API
    // responses or secrets. Expected verification failures are explicit blocks.
    const expected = error instanceof GuideError;
    if (session && expected && !['closed', 'conflict'].includes(error.code)) {
      try { await session.display(error.message); } catch { /* a closed/stale issue stays untouched */ }
    }
    if (!expected && core.setFailed) core.setFailed('AgentAlvine could not verify current GitHub metadata. No unverified progress was accepted.');
    return { status: expected ? 'setup-blocked' : 'error', reason: expected ? error.code : 'metadata-unavailable' };
  }
}

module.exports = Object.freeze({
  run, loadCourse, validateCourse, parseEnrollment, validateParticipant, parseStrictJson, canonicalJson,
  getEventSnapshot, validateLearnerWorkflow, inspectLedger, renderIssue, EvidenceReader, COMMAND, BOT_LOGIN,
  APPROVED_LIVE_REPOSITORIES,
});
