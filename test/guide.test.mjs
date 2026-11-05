import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import guide from '../.github/agentalvine/guide.cjs';
import { FIELDS, parseParticipantJson, validateParticipant as validateProductionParticipant, deriveNames } from '../scripts/inputs.mjs';

// Entirely synthetic Octokit/server metadata. Nothing executes learner source,
// shells out, signs in, calls a network, downloads a log/artifact, dispatches a
// workflow or touches Azure/state. These are observer contracts, NOT live proof.
// Assisted answers below are deterministic test candidates, not an actual LLM
// or Copilot session. No LLM, live GitHub, Azure or Copilot service is invoked.
const CONFIG = guide.loadCourse();
const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const BASE = 'a'.repeat(40);
const TASK = 'b'.repeat(40);
const INPUT = 'c'.repeat(40);
const MAIN1 = 'd'.repeat(40);
const PURPLE = 'e'.repeat(40);
const FIX = 'f'.repeat(40);
const MAIN2 = '1'.repeat(40);
const OTHER = '2'.repeat(40);
const USER = { id: 101, login: 'learner-one', type: 'User' };
const OWNER = { id: 202, login: 'workshop-owner', type: 'User' };
const OUTSIDER = { id: 303, login: 'not-enrolled', type: 'User' };
const BOT = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(guide.canonicalJson(value));
const input = (changes = {}) => ({ participant_name: 'alex', instance_number: '001', app_message: 'Hello from alex',
  page_theme: 'blue', workshop_iteration: '01', ...changes });
const named = (changes = {}) => input({ participant_name: 'li', app_message: 'Hello from li', ...changes });
const MARKER = '<!-- agentalvine:record:v1\n';
// Use the real parent-authored references, not a simplified YAML fixture that
// can omit actions/steps and conceal a rejected canonical starter.
const canonical = readFileSync(new URL('../exercise/validation-workflow.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const qualityWorkflow = readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const TERRAFORM_SETUP = 'hashicorp/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e';
const QUALITY_JOB = 'Quality and contracts';
const QUALITY_INPUT_STEP = 'Validate the valid learner input or the precise expected purple teaching case';
const deliveryBytes = '# SYNTHETIC pinned delivery implementation, never executed\n';
const cleanupBytes = '# SYNTHETIC pinned cleanup implementation, never executed\n';

function missing(label) {
  const error = new Error(`Synthetic missing ${label}`);
  error.status = 404;
  throw error;
}
function recordOf(comment) {
  const start = comment.body?.indexOf(MARKER) ?? -1;
  return start < 0 ? null : JSON.parse(comment.body.slice(start + MARKER.length, comment.body.indexOf('\n-->', start)));
}

class Fixture {
  constructor({ live = false, repository, enrollment = '[101]' } = {}) {
    const fullName = live ? guide.APPROVED_LIVE_REPOSITORIES[1379149907] : 'training/learner-copy';
    this.repository = { id: live ? 1379149907 : 900001, full_name: fullName, name: fullName.split('/')[1],
      owner: { login: fullName.split('/')[0] }, default_branch: 'dev', private: true, visibility: 'private',
      is_template: false, fork: false, archived: false, disabled: false, ...repository };
    this.config = clone(CONFIG);
    this.clock = NOW;
    this.nextComment = 1000;
    this.nextIssue = 1;
    this.nextRun = 8000;
    this.nextJob = 50000;
    this.nextPr = 1;
    this.issues = new Map();
    this.comments = new Map();
    this.runs = new Map();
    this.jobs = new Map();
    this.prs = new Map();
    this.prCommits = new Map();
    this.associations = new Map();
    this.comparisons = new Map();
    this.users = new Map([USER, OWNER, OUTSIDER, BOT].map(user => [user.id, clone(user)]));
    this.permissions = new Map([[USER.login, 'write'], [OWNER.login, 'admin'], [OUTSIDER.login, 'write']]);
    this.branches = new Map([['dev', { name: 'dev', commit: { sha: BASE }, protected: false }],
      ['main', { name: 'main', commit: { sha: BASE }, protected: true }]]);
    this.files = new Map();
    this.lessons = new Map();
    const files = {
      [CONFIG.participantPath]: JSON.stringify(input()),
      [CONFIG.canonicalWorkflowPath]: canonical,
      [CONFIG.workflowPaths.quality]: qualityWorkflow,
      [CONFIG.workflowPaths.delivery]: deliveryBytes,
      [CONFIG.workflowPaths.cleanup]: cleanupBytes,
      'package.json': '{"scripts":{"test":"node --test"}}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
      'scripts/inputs.mjs': '// SYNTHETIC unchanged trusted input validator bytes\n',
      'scripts/check.mjs': '// SYNTHETIC unchanged credential-free checker bytes\n',
      'scripts/terraform-check.mjs': '// SYNTHETIC unchanged backend-disabled checker bytes\n',
    };
    this.files.set(BASE, files);
    this.calls = [];
    this.writes = [];
    this.hooks = {};
    this.summary = [];
    this.failures = [];
    this.env = { WORKSHOP_LEARNER_USER_IDS: enrollment, GUIDE_CHECKOUT_SHA: BASE, GITHUB_WORKFLOW_SHA: BASE,
      GITHUB_WORKFLOW_REF: `${this.repository.full_name}/.github/workflows/guide.yml@refs/heads/dev` };
    this.profile = { schemaVersion: 1, profile: CONFIG.profile, repository: this.repository.full_name,
      repositoryId: String(this.repository.id), root: CONFIG.root, owner: { id: String(OWNER.id), login: OWNER.login },
      assignment: { participant_name: 'li', instance_number: '001', learner_user_ids: [101] },
      approvedAt: new Date(NOW - 60000).toISOString(), expiresAt: new Date(NOW + 8 * 60 * 60 * 1000).toISOString(),
      deliveryWorkflowSha256: hash(deliveryBytes), cleanupWorkflowSha256: hash(cleanupBytes) };
    if (live) this.pinProfile();
    this.github = this.api();
    this.guideRun = this.addRun(BASE, 'dev', CONFIG.workflowPaths.guide, { jobs: [], inProgress: true });
  }
  stamp(value = this.clock) { return new Date(value).toISOString(); }
  tick(seconds = 1) { this.clock += seconds * 1000; return this.stamp(); }
  pinProfile() {
    this.env.WORKSHOP_OWNER_PROFILE_JSON = JSON.stringify(this.profile);
    this.env.WORKSHOP_OWNER_PROFILE_SHA256 = jsonHash(this.profile);
  }
  issueUrl(number = 1) { return `https://api.github.com/repos/${this.repository.full_name}/issues/${number}`; }
  core() {
    const summary = { addRaw: text => { this.summary.push(text); return summary; }, write: async () => {} };
    return { summary, setFailed: text => this.failures.push(text) };
  }
  context(eventName = 'push', payload = {}) {
    const basePayload = { repository: clone(this.repository), sender: clone(USER) };
    if (eventName === 'push') Object.assign(basePayload, { ref: 'refs/heads/dev', after: BASE, deleted: false, forced: false });
    return { eventName, repo: { owner: this.repository.owner.login, repo: this.repository.name },
      sha: BASE, ref: 'refs/heads/dev', runId: this.guideRun.id, payload: { ...basePayload, ...clone(payload) } };
  }
  async fire(context = this.context()) {
    return guide.run({ github: this.github, context, core: this.core(), env: this.env, config: this.config,
      now: () => this.clock, readLesson: filename => {
        if (this.missingFinal && filename.endsWith('s4-4.md')) return '';
        if (this.lessons.has(filename)) return this.lessons.get(filename);
        return `## Full lesson ${filename}\n\n` +
          (filename.endsWith('s4-4.md') ? 'FINAL LESSON: verify workload absence, retain bootstrap, check billing, and contact the owner for recovery.\n' :
            'Do the learner task. Expected result and recovery remain part of this entire lesson.\n');
      } });
  }
  api() {
    const endpoint = (name, fn, write = false) => {
      const method = async params => {
        this.calls.push({ name, params: clone(params) });
        if (write) this.writes.push({ name, params: clone(params) });
        const value = await fn(params);
        return { data: clone(value) };
      };
      method.syntheticName = name;
      return method;
    };
    const rest = {
      repos: {
        get: endpoint('repos.get', () => this.repository),
        getBranch: endpoint('repos.getBranch', ({ branch }) => this.branches.get(branch) ?? missing('branch')),
        getContent: endpoint('repos.getContent', ({ path, ref }) => {
          this.hooks.onContent?.({ path, ref }, this);
          const text = this.files.get(ref)?.[path];
          if (text === undefined) return missing('content');
          const bytes = Buffer.from(text);
          return { type: 'file', path, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
        }),
        compareCommitsWithBasehead: endpoint('repos.compareCommitsWithBasehead', ({ basehead }) => this.comparisons.get(basehead) ?? missing('comparison')),
        getCollaboratorPermissionLevel: endpoint('repos.getCollaboratorPermissionLevel', ({ username }) => {
          this.hooks.onPermission?.(username, this);
          const user = [...this.users.values()].find(user => user.login === username);
          if (!user || !this.permissions.has(username)) return missing('permission');
          return { permission: this.permissions.get(username), user };
        }),
        listPullRequestsAssociatedWithCommit: endpoint('repos.listPullRequestsAssociatedWithCommit', ({ commit_sha }) =>
          (this.associations.get(commit_sha) ?? []).map(number => this.prs.get(number))),
      },
      users: { getById: endpoint('users.getById', ({ account_id }) => this.users.get(account_id) ?? missing('user')) },
      actions: {
        getWorkflowRun: endpoint('actions.getWorkflowRun', ({ run_id }) => {
          this.hooks.onRun?.(run_id, this);
          return this.runs.get(run_id) ?? missing('run');
        }),
        listWorkflowRunsForRepo: endpoint('actions.listWorkflowRunsForRepo', () => ({ workflow_runs: [...this.runs.values()] })),
        listJobsForWorkflowRunAttempt: endpoint('actions.listJobsForWorkflowRunAttempt', ({ run_id, attempt_number }) => {
          assert.equal(attempt_number, 1);
          return { jobs: this.jobs.get(run_id) ?? [] };
        }),
      },
      pulls: {
        list: endpoint('pulls.list', ({ state }) => [...this.prs.values()].filter(pr => !state || pr.state === state)),
        get: endpoint('pulls.get', ({ pull_number }) => this.prs.get(pull_number) ?? missing('PR')),
        listCommits: endpoint('pulls.listCommits', ({ pull_number }) => (this.prCommits.get(pull_number) ?? []).map(sha => ({ sha }))),
      },
      issues: {
        listForRepo: endpoint('issues.listForRepo', () => [...this.issues.values()]),
        listComments: endpoint('issues.listComments', ({ issue_number }) => [...this.comments.values()].filter(comment => comment.issue_url === this.issueUrl(issue_number))),
        get: endpoint('issues.get', ({ issue_number }) => {
          this.hooks.onIssueGet?.(issue_number, this);
          return this.issues.get(issue_number) ?? missing('issue');
        }),
        getComment: endpoint('issues.getComment', ({ comment_id }) => {
          this.hooks.onCommentGet?.(comment_id, this);
          return this.comments.get(comment_id) ?? missing('comment');
        }),
        create: endpoint('issues.create', ({ title, body }) => {
          const number = this.nextIssue++;
          const issue = { id: 70000 + number, number, title, body, state: 'open', user: clone(BOT), created_at: this.tick(), updated_at: this.stamp() };
          this.issues.set(number, issue);
          return issue;
        }, true),
        createComment: endpoint('issues.createComment', ({ issue_number, body }) => {
          const comment = this.addComment(body, BOT, { issueNumber: issue_number });
          this.hooks.afterBotComment?.(comment, this);
          return comment;
        }, true),
        update: endpoint('issues.update', ({ issue_number, ...changes }) => {
          const issue = this.issues.get(issue_number) ?? missing('issue');
          this.hooks.beforeIssueUpdate?.(changes, this);
          Object.assign(issue, Object.fromEntries(Object.entries(changes).filter(([key]) => ['body', 'state', 'title'].includes(key))), { updated_at: this.tick() });
          return issue;
        }, true),
      },
    };
    return { rest, paginate: async (method, params) => {
      const response = await method(params);
      return Array.isArray(response.data) ? response.data : response.data.workflow_runs ?? response.data.jobs;
    } };
  }
  addComment(body, user = USER, { issueNumber = 1, createdAt, edited = false, app = null, id } = {}) {
    const created = createdAt ?? this.tick();
    const comment = { id: id ?? ++this.nextComment, body, user: clone(user), issue_url: this.issueUrl(issueNumber),
      created_at: created, updated_at: edited ? this.tick() : created, performed_via_github_app: app };
    this.comments.set(comment.id, comment);
    return comment;
  }
  command(body = guide.COMMAND, user = USER, options = {}) {
    const comment = this.addComment(body, user, options);
    return this.context('issue_comment', { action: 'created', sender: clone(user), issue: clone(this.issues.get(options.issueNumber ?? 1)), comment: clone(comment) });
  }
  addRun(sha, branch, workflowPath, { event = 'push', actor = USER, result = 'success', jobs, inProgress = false } = {}) {
    const run = { id: ++this.nextRun, run_attempt: 1, repository: clone(this.repository), head_repository: clone(this.repository),
      head_sha: sha, head_branch: branch, path: workflowPath, event, status: inProgress ? 'in_progress' : 'completed',
      conclusion: inProgress ? null : result, actor: clone(actor), triggering_actor: clone(actor), created_at: this.tick(), updated_at: this.stamp() };
    this.runs.set(run.id, run);
    this.jobs.set(run.id, jobs ?? []);
    return run;
  }
  makeJob(run, name, { result = 'success', stepName = 'Perform actual synthetic work', stepResult = result } = {}) {
    const started = this.tick();
    const step = { number: 1, name: stepName, status: 'completed', conclusion: stepResult, started_at: started, completed_at: this.tick() };
    const job = { id: ++this.nextJob, run_id: run.id, run_attempt: 1, head_sha: run.head_sha, name,
      status: 'completed', conclusion: result, started_at: started, completed_at: this.tick(), steps: [step] };
    this.jobs.get(run.id).push(job);
    run.updated_at = job.completed_at;
    return job;
  }
  task(sha = TASK, { branch = 'lab/workshop', participant = input(), result = 'success', workflowPath = CONFIG.workflowPaths.learner } = {}) {
    this.files.set(sha, { ...this.files.get(BASE), [CONFIG.participantPath]: JSON.stringify(participant), [CONFIG.learnerWorkflowPath]: canonical });
    this.branches.set(branch, { name: branch, commit: { sha }, protected: false });
    this.comparisons.set(`${BASE}...${sha}`, { status: 'ahead', total_commits: 1,
      files: [{ filename: CONFIG.learnerWorkflowPath, status: 'added', changes: 20 },
        { filename: CONFIG.participantPath, status: 'modified', changes: 1 }] });
    const run = this.addRun(sha, branch, workflowPath, { result });
    const qualityRun = workflowPath === CONFIG.workflowPaths.quality;
    this.makeJob(run, qualityRun ? QUALITY_JOB : CONFIG.jobs.validation,
      { result, stepName: qualityRun ? QUALITY_INPUT_STEP : CONFIG.inputValidationStep, stepResult: result });
    return run;
  }
  pr(sha = TASK, { branch = 'lab/workshop', base = 'main', user = USER, number } = {}) {
    const actualNumber = number ?? this.nextPr++;
    const pr = { number: actualNumber, state: 'open', draft: false, merged: false, created_at: this.tick(),
      closed_at: null, merged_at: null, user: clone(user), head: { ref: branch, sha, repo: clone(this.repository) },
      base: { ref: base, repo: clone(this.repository) }, merge_commit_sha: null };
    this.prs.set(actualNumber, pr);
    this.prCommits.set(actualNumber, [sha]);
    return pr;
  }
  updatePr(number, sha) {
    this.prs.get(number).head.sha = sha;
    this.prCommits.get(number).push(sha);
  }
  merge(number, mainSha) {
    const pr = this.prs.get(number);
    Object.assign(pr, { state: 'closed', merged: true, merged_at: this.tick(), closed_at: this.stamp(), merge_commit_sha: mainSha });
    this.files.set(mainSha, { ...this.files.get(pr.head.sha) });
    this.branches.set('main', { name: 'main', commit: { sha: mainSha }, protected: true });
    this.associations.set(mainSha, [number]);
    return pr;
  }
  observation(participant, operation, result) {
    return `${CONFIG.observationStepPrefix} root=${CONFIG.root} profile=${CONFIG.profile}` +
      ` owner=${this.env.WORKSHOP_OWNER_PROFILE_SHA256} participant=${jsonHash(participant)} operation=${operation} result=${result}`;
  }
  liveRun(sha, kind = 'delivery', { actor = USER, includeAbsence = true } = {}) {
    const participant = JSON.parse(this.files.get(sha)[CONFIG.participantPath]);
    const operation = kind === 'cleanup' ? 'destroy' : kind === 'followup' ? 'followup' : 'deploy';
    const run = this.addRun(sha, 'main', kind === 'cleanup' ? CONFIG.workflowPaths.cleanup : CONFIG.workflowPaths.delivery,
      { actor, event: operation === 'deploy' ? 'push' : 'workflow_dispatch' });
    this.makeJob(run, CONFIG.jobs.preflight, { stepName: this.observation(participant, operation, 'admitted') });
    this.makeJob(run, CONFIG.jobs.liveValidation);
    if (kind === 'delivery') {
      for (const name of [CONFIG.jobs.plan, CONFIG.jobs.apply, CONFIG.jobs.packaging]) this.makeJob(run, name);
      this.makeJob(run, CONFIG.jobs.verification, { stepName: this.observation(participant, operation, 'deployed') });
    } else if (kind === 'followup') this.makeJob(run, CONFIG.jobs.followup, { stepName: this.observation(participant, operation, 'no-change') });
    else {
      this.makeJob(run, CONFIG.jobs.destroyPlan);
      this.makeJob(run, CONFIG.jobs.destroy, { stepName: this.observation(participant, operation, 'destroyed') });
      if (includeAbsence) this.makeJob(run, CONFIG.jobs.absence, { stepName: this.observation(participant, operation, 'absent') });
    }
    return run;
  }
  records(kind) {
    return [...this.comments.values()].filter(comment => comment.user.login === guide.BOT_LOGIN).map(recordOf).filter(record => record && (!kind || record.kind === kind));
  }
  async state() {
    const reader = new guide.EvidenceReader({ github: this.github, repository: this.repository, config: this.config, env: this.env,
      learnerIds: guide.parseEnrollment(this.env.WORKSHOP_LEARNER_USER_IDS), now: () => this.clock });
    return guide.inspectLedger({ comments: [...this.comments.values()], issue: this.issues.get(1), repository: this.repository,
      config: this.config, reader, now: this.clock });
  }
}

async function sectionOne(f = new Fixture()) {
  assert.equal((await f.fire()).status, 'started');
  f.task();
  f.pr();
  const result = await f.fire();
  assert.equal(result.progress, 4);
  assert.equal(result.status, 'paused');
  return f;
}
async function enterTwo(f) {
  const result = await f.fire(f.command());
  assert.equal(result.status, 'advanced');
  assert.equal(result.section, 2);
  assert.equal(result.step, 1);
  assert.equal(result.progress, 4);
}
async function inputPr(f) {
  f.task(INPUT, { participant: named() });
  f.updatePr(1, INPUT);
  const result = await f.fire();
  assert.equal(result.progress, 6);
  return result;
}
async function sectionTwo(f = new Fixture({ live: true })) {
  await sectionOne(f);
  await enterTwo(f);
  await inputPr(f);
  f.merge(1, MAIN1);
  const run = f.liveRun(MAIN1);
  const result = await f.fire();
  assert.equal(result.status, 'paused');
  assert.equal(result.progress, 8);
  return { f, run };
}
async function initialReady(f = new Fixture({ live: true })) {
  await sectionOne(f);
  await enterTwo(f);
  await inputPr(f);
  f.merge(1, MAIN1);
  return { f, run: f.liveRun(MAIN1) };
}
async function purple(f) {
  const entered = await f.fire(f.command());
  assert.equal(entered.section, 3);
  assert.equal(entered.progress, 8);
  const run = f.task(PURPLE, { branch: 'lab/update', participant: named({ page_theme: 'purple' }), result: 'failure' });
  const result = await f.fire();
  assert.equal(result.progress, 10);
  return run;
}
async function sectionThree(f) {
  await purple(f);
  f.task(FIX, { branch: 'lab/update', participant: named({ page_theme: 'green', workshop_iteration: '02', app_message: 'Updated by li' }) });
  f.pr(FIX, { branch: 'lab/update' });
  f.merge(2, MAIN2);
  const run = f.liveRun(MAIN2);
  const result = await f.fire();
  assert.equal(result.status, 'paused');
  assert.equal(result.progress, 12);
  return run;
}
async function enterFour(f) {
  const result = await f.fire(f.command());
  assert.equal(result.section, 4);
  assert.equal(result.progress, 12);
  assert.equal(result.step, 1);
}

test('fixed source/course exports describe exactly 4 x 4 steps and three human boundaries', () => {
  assert.equal(guide.COMMAND, 'proceed to next section');
  assert.equal(guide.BOT_LOGIN, 'github-actions[bot]');
  assert.equal(CONFIG.sections.length, 4);
  assert.deepEqual(CONFIG.sections.flatMap(section => section.steps.map(step => step.id)),
    Array.from({ length: 4 }, (_, section) => Array.from({ length: 4 }, (_, step) => `s${section + 1}-${step + 1}`)).flat());
  assert.equal(Object.keys(guide.APPROVED_LIVE_REPOSITORIES).length, 2);
  assert.ok(Object.isFrozen(guide.APPROVED_LIVE_REPOSITORIES));
  assert.equal(CONFIG.jobs.validation, 'Validate workshop inputs');
  assert.equal(CONFIG.jobs.destroyPlan, 'Create encrypted workshop plan');
  assert.equal(CONFIG.jobs.destroy, 'Apply exact workshop plan');
  const wrong = clone(CONFIG);
  wrong.sections[0].steps.push(clone(wrong.sections[0].steps[0]));
  assert.throws(() => guide.validateCourse(wrong));
});

for (const value of ['', '[]', '{}', '[0]', '[-1]', '[1.5]', '["101"]', '[101,101]', '[true]', '[null]', '[9007199254740992]', '[1e309]']) {
  test(`invalid/missing enrollment fails closed: ${JSON.stringify(value)}`, () => assert.throws(() => guide.parseEnrollment(value)));
}
test('enrollment uses stable numeric IDs, never issue authors or login strings', () => {
  assert.deepEqual(guide.parseEnrollment('[202,101]'), [101, 202]);
});
test('strict JSON rejects duplicate/escaped duplicate/prototype keys', () => {
  for (const text of ['{"page_theme":"blue","page_theme":"green"}', '{"x":1,"\\u0078":2}', '{"__proto__":{}}'])
    assert.throws(() => guide.parseStrictJson(text));
  assert.equal(guide.canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
});
test('participant helper enforces all five string fields and the frozen name/instance', () => {
  assert.deepEqual(guide.validateParticipant(input()), input());
  for (const value of [input({ instance_number: '002' }), input({ instance_number: 1 }), input({ page_theme: 'purple' }),
    input({ participant_name: 'Alex' }), input({ app_message: '<b>unsafe</b>' }), input({ workshop_iteration: '2' }), { ...input(), subscription_id: 'override' }])
    assert.throws(() => guide.validateParticipant(value));
  assert.throws(() => guide.validateParticipant(named(), 'alex'));
});
test('the real canonical starter is accepted only as the exact safe trusted reference, without executing YAML', () => {
  assert.equal(CONFIG.canonicalWorkflowPath, 'exercise/validation-workflow.yml');
  assert.match(canonical, /^name: Learner checks$/m);
  assert.match(canonical, /^    branches: \['lab\/\*\*', 'workshop\/\*\*', dev, main\]$/m);
  assert.match(canonical, /^  pull_request:$/m);
  assert.match(canonical, /^    name: Validate workshop inputs$/m);
  assert.match(canonical, /^    runs-on: ubuntu-24\.04$/m);
  assert.deepEqual([...canonical.matchAll(/^\s*-\s+uses:\s*(\S+)\s*$/gm)].map(match => match[1]), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    TERRAFORM_SETUP,
  ]);
  assert.ok(canonical.includes('      - run: npm ci --ignore-scripts\n'));
  assert.ok(canonical.includes(`      - name: ${CONFIG.inputValidationStep}\n        run: node scripts/inputs.mjs\n`));
  assert.match(canonical, /^        run: node scripts\/terraform-check\.mjs --mock$/m);
  assert.equal(guide.validateLearnerWorkflow(canonical, canonical, CONFIG), hash(canonical));
  assert.equal(guide.validateLearnerWorkflow(canonical.replace(/\n/g, '\r\n'), canonical, CONFIG), hash(canonical));
  assert.throws(() => guide.validateLearnerWorkflow(canonical.replace('node scripts/inputs.mjs', 'echo fake'), canonical, CONFIG));
  for (const unsafe of [
    canonical.replace('contents: read', 'contents: write'),
    canonical.replace('contents: read', 'contents: read\n  id-token: write'),
    canonical.replace('  pull_request:', '  pull_request_target:'),
    canonical.replace('node scripts/inputs.mjs', 'terraform apply -auto-approve'),
    canonical.replace('node scripts/inputs.mjs', 'az account show'),
    canonical.replace('node scripts/inputs.mjs', 'node scripts/inputs.mjs; echo unsafe'),
    canonical.replace('persist-credentials: false', 'persist-credentials: true'),
    canonical.replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@main'),
    canonical.replace('jobs:', 'env:\n  BAD: ${{ secrets.BAD }}\njobs:'),
  ]) assert.throws(() => guide.validateLearnerWorkflow(unsafe, unsafe, CONFIG));
});
for (const action of [
  'hashicorp/setup-terraform@v3',
  `hashicorp/setup-terraform@${'0'.repeat(40)}`,
  'unreviewed/setup-terraform@dfe3c3f87815947d99a8997f908cb6525fc44e9e',
]) test(`the real starter rejects an unreviewed Terraform action/ref even in a matching reference: ${action}`, () => {
  const changed = canonical.replace(TERRAFORM_SETUP, action);
  assert.notEqual(changed, canonical, 'The regression must actually replace the real canonical Terraform action.');
  assert.throws(() => guide.validateLearnerWorkflow(changed, changed, CONFIG), { code: 'unsafe-workflow' });
  assert.throws(() => guide.validateLearnerWorkflow(changed, canonical, CONFIG), { code: 'workflow' });
});

test('private copies automatically create one actual bot Exercise, with zero claimed setup/GUI evidence', async () => {
  const f = new Fixture();
  const result = await f.fire();
  assert.deepEqual(result, { status: 'started', section: 1, step: 1, progress: 0 });
  assert.equal(f.issues.size, 1);
  assert.equal(f.issues.get(1).title, 'Exercise');
  assert.equal(f.issues.get(1).user.type, 'Bot');
  assert.deepEqual(f.records('start')[0].learnerIds, [101]);
  assert.ok(!f.records('start')[0].learnerIds.includes(BOT.id));
  assert.match(f.issues.get(1).body, /does not prove installation\/human UI activity/);
  assert.equal((await f.fire()).progress, 0);
  assert.equal(f.issues.size, 1);
  assert.equal(f.records('start').length, 1);
});
test('missing enrollment publishes setup-blocked instructions, then starts the same issue only after owner setup', async () => {
  const f = new Fixture({ enrollment: '' });
  assert.equal((await f.fire()).status, 'setup-blocked');
  assert.match(f.issues.get(1).body, /WORKSHOP_LEARNER_USER_IDS/);
  assert.match(f.issues.get(1).body, /positive numeric GitHub user IDs/);
  assert.equal(f.records('register').length, 1);
  assert.equal(f.records('start').length, 0);
  assert.equal(f.records('step').length, 0);
  assert.equal(f.issues.get(1).state, 'open');
  f.env.WORKSHOP_LEARNER_USER_IDS = '[101]';
  assert.equal((await f.fire()).status, 'started');
  assert.equal(f.issues.size, 1);
});
test('an enrolled ID without current write access cannot start or produce bogus completion', async () => {
  const f = new Fixture();
  f.permissions.set(USER.login, 'read');
  assert.equal((await f.fire()).status, 'setup-blocked');
  assert.equal(f.records('start').length, 0);
  assert.equal(f.records('step').length, 0);
  assert.match(f.issues.get(1).body, /0\/16/);
});

for (const metadata of [
  { private: false, visibility: 'public' }, { is_template: true },
  { full_name: CONFIG.sourceRepository, name: CONFIG.sourceRepository.split('/')[1], owner: { login: 'alvinea28' }, private: false, visibility: 'public' },
]) test(`ordinary source/template events are inert: ${JSON.stringify(metadata)}`, async () => {
  const f = new Fixture({ repository: metadata });
  assert.equal((await f.fire()).status, 'inert-source');
  assert.equal(f.writes.length, 0);
  assert.equal(f.issues.size, 0);
});
test('explicit source Preview renders zero progress with read-only summary and no enrollment or issue writes', async () => {
  const f = new Fixture({ enrollment: '', repository: { full_name: CONFIG.sourceRepository,
    name: CONFIG.sourceRepository.split('/')[1], owner: { login: 'alvinea28' }, private: false, visibility: 'public', is_template: true } });
  const result = await f.fire(f.context('workflow_dispatch', { inputs: { mode: 'Preview' } }));
  assert.equal(result.status, 'preview');
  assert.equal(result.progress, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.issues.size, 0);
  assert.equal(f.calls.filter(call => call.name === 'users.getById').length, 0);
  assert.match(f.summary[0], /Preview — read-only, zero progress/);
});
test('Preview cannot grade or rewrite a private copy that already has progress', async () => {
  const f = await sectionOne();
  const before = clone([...f.comments.values()]);
  const body = f.issues.get(1).body;
  const writes = f.writes.length;
  assert.equal((await f.fire(f.context('workflow_dispatch', { inputs: { mode: 'Preview' } }))).progress, 0);
  assert.equal(f.writes.length, writes);
  assert.equal(f.issues.get(1).body, body);
  assert.deepEqual([...f.comments.values()], before);
});
test('unknown dispatch modes cannot start or advance a private copy', async () => {
  const f = new Fixture();
  assert.equal((await f.fire(f.context('workflow_dispatch', { inputs: { mode: 'Start' } }))).status, 'ignored');
  assert.equal(f.writes.length, 0);
});
test('wrong event repository or nondefault checkout/workflow revisions fail before any mutation', async () => {
  const f = new Fixture();
  const wrong = f.context();
  wrong.payload.repository.id++;
  assert.equal((await f.fire(wrong)).status, 'setup-blocked');
  assert.equal(f.writes.length, 0);
  f.env.GUIDE_CHECKOUT_SHA = TASK;
  assert.equal((await f.fire()).reason, 'untrusted-default');
  assert.equal(f.writes.length, 0);
  f.env.GUIDE_CHECKOUT_SHA = BASE;
  f.env.GITHUB_WORKFLOW_REF = `${f.repository.full_name}/.github/workflows/guide.yml@refs/heads/lab/untrusted`;
  assert.equal((await f.fire()).reason, 'untrusted-default');
  assert.equal(f.writes.length, 0);
});
test('bot/App events are ignored except workflow_run; their identity never becomes learner enrollment', async () => {
  const f = new Fixture();
  assert.equal((await f.fire(f.context('push', { sender: BOT }))).status, 'ignored');
  assert.equal((await f.fire(f.context('push', { performed_via_github_app: { id: 42 } }))).status, 'ignored');
  assert.equal(f.issues.size, 0);
  const context = f.context('workflow_run', { action: 'completed', sender: BOT, workflow_run: { id: f.guideRun.id } });
  assert.equal((await f.fire(context)).status, 'started');
  assert.deepEqual(f.records('start')[0].learnerIds, [101]);
});

test('comment snapshot never treats default context.sha as learner revision', async () => {
  const f = new Fixture();
  const context = f.context('issue_comment', { action: 'created' });
  context.sha = OTHER;
  const before = f.calls.length;
  assert.deepEqual(await guide.getEventSnapshot({ github: f.github, context, repository: f.repository }), { kind: 'metadata', revision: null });
  assert.equal(f.calls.length, before);
});
test('push snapshot requires actual current branch head and actual first-attempt same-repo run', async () => {
  const f = new Fixture();
  const run = f.task();
  const context = f.context('push', { ref: 'refs/heads/lab/workshop', after: TASK });
  context.runId = run.id;
  let result = await guide.getEventSnapshot({ github: f.github, context, repository: f.repository });
  assert.equal(result.revision, TASK);
  f.branches.get('lab/workshop').commit.sha = OTHER;
  result = await guide.getEventSnapshot({ github: f.github, context, repository: f.repository });
  assert.equal(result.kind, 'stale');
  assert.equal(result.revision, null);
  f.branches.get('lab/workshop').commit.sha = TASK;
  run.run_attempt = 2;
  assert.equal((await guide.getEventSnapshot({ github: f.github, context, repository: f.repository })).revision, null);
});
test('PR snapshot resolves server PR/current head, not payload head or a fork revision', async () => {
  const f = new Fixture();
  f.task();
  const pr = f.pr();
  const context = f.context('pull_request_target', { action: 'opened', pull_request: { number: pr.number, head: { sha: OTHER } } });
  assert.equal((await guide.getEventSnapshot({ github: f.github, context, repository: f.repository })).revision, TASK);
  pr.head.repo.id++;
  assert.equal((await guide.getEventSnapshot({ github: f.github, context, repository: f.repository })).revision, null);
});
test('workflow_run snapshot uses fetched current commit, not a forged or stale payload SHA', async () => {
  const f = new Fixture();
  const run = f.task();
  const context = f.context('workflow_run', { action: 'completed', workflow_run: { id: run.id, head_sha: OTHER } });
  assert.equal((await guide.getEventSnapshot({ github: f.github, context, repository: f.repository })).revision, TASK);
  f.branches.get('lab/workshop').commit.sha = INPUT;
  assert.equal((await guide.getEventSnapshot({ github: f.github, context, repository: f.repository })).revision, null);
});

test('one reconciliation can finish four current-section steps but never auto-crosses its boundary', async () => {
  const f = await sectionOne();
  assert.equal(f.records('step').length, 4);
  assert.equal(f.records('gate').length, 1);
  assert.equal(f.records('advance').length, 0);
  assert.match(f.issues.get(1).body, /Section 1: 4\/4 verified — paused/);
  assert.match(f.issues.get(1).body, /Full lesson \.github\/steps\/s1-4\.md/);
  for (let count = 0; count < 3; count++) {
    assert.equal((await f.fire()).status, 'paused');
    assert.equal(f.records('step').length, 4);
    assert.equal(f.records('advance').length, 0);
  }
});
test('one exact eligible command opens only next-section Step 1, including when fresh Step 1 evidence is already available', async () => {
  const f = await sectionOne();
  const event = f.command();
  f.hooks.afterBotComment = (comment, fixture) => {
    if (recordOf(comment)?.kind === 'advance') fixture.task(INPUT, { participant: named() });
  };
  const result = await f.fire(event);
  assert.equal(result.status, 'advanced');
  assert.equal(result.section, 2);
  assert.equal(result.step, 1);
  assert.equal(result.progress, 4);
  assert.equal(f.records('step').length, 4);
  assert.match(f.issues.get(1).body, /Full lesson \.github\/steps\/s2-1\.md/);
  assert.ok(!f.issues.get(1).body.includes('Full lesson .github/steps/s2-2.md'));
  f.hooks.afterBotComment = undefined;
  assert.equal((await f.fire()).progress, 5);
});
test('early commands receive feedback once, are not queued, and require a NEW post-prompt command', async () => {
  const f = new Fixture();
  await f.fire();
  const early = f.command();
  assert.equal((await f.fire(early)).status, 'early-command');
  const feedbackCount = () => [...f.comments.values()].filter(comment => comment.body.includes('agentalvine:early:')).length;
  assert.equal(feedbackCount(), 1);
  await f.fire(early);
  assert.equal(feedbackCount(), 1);
  f.task();
  f.pr();
  assert.equal((await f.fire()).progress, 4);
  assert.equal((await f.fire()).status, 'paused');
  assert.equal(f.records('advance').length, 0);
  assert.equal((await f.fire(early)).status, 'early-command');
  assert.equal((await f.fire(f.command())).status, 'advanced');
  assert.notEqual(f.records('advance')[0].commandCommentId, early.payload.comment.id);
});
test('equal-second command timestamp is early: the gate prompt must strictly precede it', async () => {
  const f = await sectionOne();
  const gate = [...f.comments.values()].find(comment => recordOf(comment)?.kind === 'gate');
  const event = f.command(guide.COMMAND, USER, { createdAt: gate.created_at });
  assert.equal((await f.fire(event)).status, 'early-command');
  assert.equal(f.records('advance').length, 0);
});

for (const body of [
  'Proceed to next section', 'PROCEED TO NEXT SECTION', 'proceed to next sections',
  'please proceed to next section', '> proceed to next section', '"proceed to next section"',
  "'proceed to next section'", '`proceed to next section`', '```\nproceed to next section\n```',
  'proceed to next section\nthanks', 'proceed to next section.', 'proceed  to next section',
]) test(`nonexact whole-body command is ignored: ${JSON.stringify(body)}`, async () => {
  const f = await sectionOne();
  const before = f.writes.length;
  assert.equal((await f.fire(f.command(body))).status, 'ignored');
  assert.equal(f.writes.length, before);
  assert.equal(f.records('advance').length, 0);
});
test('only outer whitespace is allowed by the exact trimmed whole-body command', async () => {
  const f = await sectionOne();
  assert.equal((await f.fire(f.command(' \nproceed to next section\r\n\t'))).status, 'advanced');
  assert.equal(f.records('advance').length, 1);
});
test('duplicate/rerun of an already consumed comment cannot grade any further step or skip a section', async () => {
  const f = await sectionOne();
  const event = f.command();
  assert.equal((await f.fire(event)).status, 'advanced');
  f.task(INPUT, { participant: named() });
  const before = f.writes.length;
  const result = await f.fire(event);
  assert.equal(result.status, 'ignored');
  assert.equal(result.reason, 'already-consumed-command');
  assert.equal(f.writes.length, before);
  assert.equal(f.records('advance').length, 1);
  assert.equal(f.records('step').length, 4);
});
test('coalesced eligible comments are recovered from server comments on a later metadata event', async () => {
  const f = await sectionOne();
  f.command(guide.COMMAND, OUTSIDER);
  f.command('`proceed to next section`');
  const eligible = f.command(); // its issue_comment delivery is intentionally lost
  const later = f.command();
  const result = await f.fire();
  assert.equal(result.status, 'advanced');
  assert.equal(result.commandCommentId, eligible.payload.comment.id);
  assert.equal(f.records('advance').length, 1);
  assert.notEqual(f.records('advance')[0].commandCommentId, later.payload.comment.id);
  assert.equal(f.records('step').length, 4);
});
test('edited/deleted/bot/App/outsider coalesced comments are never candidates for consumption', async () => {
  const f = await sectionOne();
  f.command(guide.COMMAND, USER, { edited: true });
  const deleted = f.command();
  f.comments.delete(deleted.payload.comment.id);
  f.command(guide.COMMAND, BOT);
  f.command(guide.COMMAND, USER, { app: { id: 777 } });
  f.command(guide.COMMAND, OUTSIDER);
  assert.equal((await f.fire()).status, 'paused');
  assert.equal(f.records('advance').length, 0);
});
test('edited and deleted event ACTIONS cannot be treated as newly created commands', async () => {
  const f = await sectionOne();
  for (const action of ['edited', 'deleted']) {
    const event = f.command();
    event.payload.action = action;
    // Remove it from current server inventory too, so another legitimate event
    // cannot later recover a genuinely created, unchanged command by accident.
    f.comments.delete(event.payload.comment.id);
    const before = f.writes.length;
    assert.equal((await f.fire(event)).status, 'ignored');
    assert.equal(f.writes.length, before);
  }
});
test('commands on PRs, another issue, or a closed Exercise do not mutate progress', async () => {
  const f = await sectionOne();
  const prEvent = f.command();
  prEvent.payload.issue.pull_request = { url: 'https://api.github.com/synthetic/pr' };
  f.comments.delete(prEvent.payload.comment.id);
  assert.equal((await f.fire(prEvent)).status, 'ignored');
  const other = f.command(guide.COMMAND, USER, { issueNumber: 99 });
  other.payload.issue = { number: 99, id: 70099, state: 'open' };
  assert.equal((await f.fire(other)).status, 'ignored');
  f.issues.get(1).state = 'closed';
  const closed = f.command();
  const before = f.writes.length;
  assert.equal((await f.fire(closed)).status, 'ignored');
  assert.equal(f.writes.length, before);
  assert.equal(f.issues.get(1).state, 'closed');
  assert.equal(f.records('advance').length, 0);
});
test('another human issue event cannot drive the registered Exercise', async () => {
  const f = await sectionOne();
  const before = f.writes.length;
  assert.equal((await f.fire(f.context('issues', { action: 'edited', issue: { number: 99 } }))).reason, 'other-issue');
  assert.equal(f.writes.length, before);
});
test('bot author, bot impersonation, Apps, outsiders and enrolled read-only users cannot continue', async () => {
  for (const scenario of ['bot', 'app', 'outsider', 'read-only', 'sender-mismatch']) {
    const f = await sectionOne();
    let event;
    if (scenario === 'bot') event = f.command(guide.COMMAND, BOT);
    else if (scenario === 'app') event = f.command(guide.COMMAND, USER, { app: { id: 1 } });
    else if (scenario === 'outsider') event = f.command(guide.COMMAND, OUTSIDER);
    else {
      event = f.command();
      if (scenario === 'read-only') f.permissions.set(USER.login, 'read');
      else event.payload.sender = clone(OUTSIDER);
    }
    const result = await f.fire(event);
    assert.ok(['ignored', 'setup-blocked'].includes(result.status), `${scenario}: ${result.status}`);
    assert.equal(f.records('advance').length, 0);
  }
});

for (const mismatch of ['deleted', 'id', 'author', 'body', 'edited', 'issue-url']) {
  test(`current authoritative comment readback must still match: ${mismatch}`, async () => {
    const f = await sectionOne();
    const event = f.command();
    const current = f.comments.get(event.payload.comment.id);
    if (mismatch === 'deleted') f.comments.delete(current.id);
    if (mismatch === 'id') current.id++;
    if (mismatch === 'author') current.user = clone(OUTSIDER);
    if (mismatch === 'body') current.body = 'proceed to next section\nextra';
    if (mismatch === 'edited') current.updated_at = f.tick();
    if (mismatch === 'issue-url') current.issue_url = f.issueUrl(99);
    assert.equal((await f.fire(event)).status, 'ignored');
    assert.equal(f.records('advance').length, 0);
  });
}
test('edit between validation and consumption fails the second current readback', async () => {
  const f = await sectionOne();
  const event = f.command();
  let reads = 0;
  f.hooks.onCommentGet = (id, fixture) => {
    if (id === event.payload.comment.id && ++reads === 4) fixture.comments.get(id).updated_at = fixture.tick();
  };
  const result = await f.fire(event);
  assert.equal(result.status, 'setup-blocked');
  assert.equal(f.records('advance').length, 0);
  assert.ok(reads >= 4);
});
test('issue state is re-read immediately before mutations and a human closure is never reopened', async () => {
  const f = await sectionOne();
  const event = f.command();
  f.hooks.onIssueGet = (number, fixture) => { fixture.issues.get(number).state = 'closed'; };
  const before = f.writes.length;
  const result = await f.fire(event);
  assert.equal(result.status, 'setup-blocked');
  assert.equal(result.reason, 'closed');
  assert.equal(f.writes.length, before);
  assert.equal(f.issues.get(1).state, 'closed');
});
test('a concurrent journal-head change is not overwritten by an earlier snapshot', async () => {
  const f = await sectionOne();
  const event = f.command();
  let changed = false;
  f.hooks.onIssueGet = (number, fixture) => {
    if (changed) return;
    changed = true;
    const source = [...fixture.comments.values()].find(comment => recordOf(comment)?.kind === 'step');
    fixture.addComment(source.body, BOT); // another writer, deliberately invalid chain
  };
  const result = await f.fire(event);
  assert.equal(result.reason, 'conflict');
  assert.equal(f.records('advance').length, 0);
});

test('manual issue-body checkboxes/caches/completion claims cannot award any step', async () => {
  const f = new Fixture();
  await f.fire();
  f.issues.get(1).body = '# Exercise\n- [x] all steps\n<!-- state: {"completed":16,"section":4,"gate":true} -->';
  f.addComment('<!-- agentalvine:record:v1\n{"kind":"step","stepId":"s4-4","completed":true}\n-->', USER);
  const result = await f.fire();
  assert.equal(result.progress, 0);
  assert.equal(f.records('step').length, 0);
  assert.equal(f.issues.get(1).state, 'open');
  assert.match(f.issues.get(1).body, /0\/16/);
});
test('edited or malformed bot state/prompt is blocked, never imported from body or silently reset', async () => {
  const f = await sectionOne();
  const gate = [...f.comments.values()].find(comment => recordOf(comment)?.kind === 'gate');
  gate.updated_at = f.tick();
  f.issues.get(1).body = '# all complete 16/16';
  assert.equal((await f.fire(f.command())).status, 'setup-blocked');
  assert.equal(f.records('advance').length, 0);
  assert.equal(f.records('start').length, 1);
  assert.equal(f.issues.get(1).state, 'open');
});
test('journal receipts are rederived from metadata, not trusted as cached passing booleans', async () => {
  const f = await sectionOne();
  const ci = f.records('step').find(record => record.stepId === 's1-4');
  f.runs.get(ci.evidence.runId).conclusion = 'failure';
  const before = f.records('step').length;
  const result = await f.fire(f.command());
  assert.equal(result.status, 'setup-blocked');
  assert.equal(f.records('step').length, before);
  assert.equal(f.records('advance').length, 0);
});
test('source-content tampering at a stored SHA cannot be hidden behind a good cached receipt', async () => {
  const f = await sectionOne();
  f.files.get(TASK)[CONFIG.learnerWorkflowPath] = 'name: forged\n';
  assert.equal((await f.fire(f.command())).status, 'setup-blocked');
  assert.equal(f.records('advance').length, 0);
});
test('earlier receipt revisions and server timestamps stay immutable when the learner pushes again', async () => {
  const f = await sectionOne();
  const original = clone(f.records('step'));
  const originalState = await f.state();
  f.task(INPUT, { participant: named() });
  f.updatePr(1, INPUT);
  assert.equal((await f.fire()).status, 'paused');
  assert.deepEqual(f.records('step'), original);
  const state = await f.state();
  assert.deepEqual(state.receipts.map(receipt => [receipt.revision, receipt.recordedAt]),
    originalState.receipts.map(receipt => [receipt.revision, receipt.recordedAt]));
});
test('missing enrollment after progress suppresses unverified cached progress and never closes the issue', async () => {
  const f = await sectionOne();
  f.env.WORKSHOP_LEARNER_USER_IDS = '';
  assert.equal((await f.fire()).status, 'setup-blocked');
  assert.match(f.issues.get(1).body, /0\/16/);
  assert.equal(f.issues.get(1).state, 'open');
  assert.equal(f.records('step').length, 4);
});

test('task push needs real changed learner source after cycle start, not default SHA or a cosmetic-only commit', async () => {
  for (const scenario of ['old', 'cosmetic', 'default', 'wrong-actor', 'fork']) {
    const f = new Fixture();
    await f.fire();
    const run = f.task();
    if (scenario === 'old') run.created_at = new Date(NOW - 1000).toISOString();
    if (scenario === 'cosmetic') f.comparisons.get(`${BASE}...${TASK}`).files = [{ filename: 'README.md', status: 'modified', changes: 1 }];
    if (scenario === 'default') run.head_branch = 'dev';
    if (scenario === 'wrong-actor') run.actor = run.triggering_actor = clone(OUTSIDER);
    if (scenario === 'fork') run.head_repository.id++;
    const result = await f.fire();
    assert.equal(result.progress, 0, scenario);
    assert.equal(f.records('step').length, 0);
  }
});
test('a real successful current-head CI and non-skipped validation job are required', async () => {
  for (const scenario of ['old-sha', 'attempt-two', 'all-skipped', 'failed', 'empty', 'wrong-job', 'changed-validator']) {
    const f = new Fixture();
    await f.fire();
    const run = f.task();
    f.pr();
    const job = f.jobs.get(run.id)[0];
    if (scenario === 'old-sha') { run.head_sha = OTHER; job.head_sha = OTHER; }
    if (scenario === 'attempt-two') run.run_attempt = 2;
    if (scenario === 'all-skipped') { job.conclusion = 'skipped'; job.steps.forEach(step => { step.conclusion = 'skipped'; }); }
    if (scenario === 'failed') run.conclusion = 'failure';
    if (scenario === 'empty') job.steps = [];
    if (scenario === 'wrong-job') job.name = 'Not the validation contract';
    if (scenario === 'changed-validator') f.files.get(TASK)['scripts/inputs.mjs'] = '// fake success';
    const result = await f.fire();
    assert.ok(result.progress < 4, `${scenario}: ${result.progress}`);
    assert.equal(f.records('gate').length, 0);
  }
});
test('an unrelated skipped job does not substitute for, or invalidate, the real successful validation job', async () => {
  const f = new Fixture();
  await f.fire();
  const run = f.task();
  f.pr();
  f.jobs.get(run.id).push({ id: ++f.nextJob, run_id: run.id, run_attempt: 1, head_sha: run.head_sha,
    name: 'Unrelated optional job', status: 'completed', conclusion: 'skipped', started_at: null, completed_at: null, steps: [] });
  assert.equal((await f.fire()).progress, 4);
});
test('attempt-specific jobs API can omit redundant job.run_attempt but never override the real run attempt', async () => {
  const f = new Fixture();
  await f.fire();
  const run = f.task();
  f.pr();
  delete f.jobs.get(run.id)[0].run_attempt;
  assert.equal((await f.fire()).progress, 4);
  assert.ok(f.calls.filter(call => call.name === 'actions.listJobsForWorkflowRunAttempt').every(call => call.params.attempt_number === 1));
});
test('PR gate rejects drafts, forks, closed requests, nonexistent bases and stale heads', async () => {
  for (const scenario of ['draft', 'fork', 'closed', 'base', 'stale']) {
    const f = new Fixture();
    await f.fire();
    f.task();
    const pr = f.pr();
    if (scenario === 'draft') pr.draft = true;
    if (scenario === 'fork') pr.head.repo.id++;
    if (scenario === 'closed') { pr.state = 'closed'; pr.closed_at = f.tick(); }
    if (scenario === 'base') { pr.base.ref = 'not-an-existing-base'; f.config.permittedPullRequestBases.push(pr.base.ref); }
    if (scenario === 'stale') pr.head.sha = OTHER;
    const result = await f.fire();
    // Mutating trusted config after start invalidates the course digest, rather
    // than manufacturing a new permitted base or resetting progress.
    assert.ok(result.status === 'setup-blocked' || result.progress === 2, scenario);
    assert.equal(f.records('advance').length, 0);
  }
});

test('the real quality workflow retains a distinct job and root-check semantics, not learner input-rejection semantics', () => {
  assert.match(qualityWorkflow, /^    name: Quality and contracts$/m);
  assert.ok(qualityWorkflow.includes(`      - name: ${QUALITY_INPUT_STEP}\n        run: node scripts/check.mjs\n`));
  assert.notEqual(QUALITY_JOB, CONFIG.jobs.validation);
  assert.notEqual(QUALITY_INPUT_STEP, CONFIG.inputValidationStep);
});
for (const name of [QUALITY_JOB, CONFIG.jobs.validation]) {
  test(`quality-only CI cannot complete the learner gate even with the job label ${name}`, async () => {
    const f = new Fixture();
    await f.fire();
    const quality = f.task(TASK, { workflowPath: CONFIG.workflowPaths.quality });
    f.jobs.get(quality.id)[0].name = name;
    f.pr();
    const result = await f.fire();
    assert.equal(result.progress, 3);
    assert.match(result.reason, /No current-revision credential-free CI run/);
    assert.equal(f.records('step').some(record => record.stepId === 's1-4'), false);
    assert.equal(f.records('gate').length, 0);
    assert.equal(f.calls.some(call => call.name === 'actions.listJobsForWorkflowRunAttempt' && call.params.run_id === quality.id), false);
  });
  test(`a newer quality job labeled ${name} cannot mask the latest failed learner run or recover an older learner pass`, async () => {
    const f = new Fixture();
    await f.fire();
    const older = f.task();
    const failed = f.task(TASK, { result: 'failure' });
    const quality = f.task(TASK, { workflowPath: CONFIG.workflowPaths.quality });
    f.jobs.get(quality.id)[0].name = name;
    f.pr();
    const result = await f.fire();
    assert.equal(result.progress, 3);
    assert.match(result.reason, /required result/);
    assert.ok(older.id < failed.id && failed.id < quality.id);
    assert.equal(f.records('step').some(record => record.stepId === 's1-4'), false);
    assert.equal(f.records('gate').length, 0);
    assert.equal(f.calls.some(call => call.name === 'actions.listJobsForWorkflowRunAttempt' && call.params.run_id === quality.id), false);
  });
}
test('a later quality success cannot displace the real successful current-head learner checks', async () => {
  const f = new Fixture();
  await f.fire();
  const learner = f.task();
  const quality = f.task(TASK, { workflowPath: CONFIG.workflowPaths.quality });
  f.pr();
  assert.equal((await f.fire()).progress, 4);
  const receipt = f.records('step').find(record => record.stepId === 's1-4');
  assert.equal(receipt.evidence.workflowPath, CONFIG.workflowPaths.learner);
  assert.equal(receipt.evidence.runId, learner.id);
  assert.notEqual(receipt.evidence.runId, quality.id);
});
test('a hinted quality run cannot bypass the learner path in current or historical CI verification', async () => {
  const f = new Fixture();
  await f.fire();
  const quality = f.task(TASK, { workflowPath: CONFIG.workflowPaths.quality });
  f.jobs.get(quality.id)[0].name = CONFIG.jobs.validation;
  const state = await f.state();
  const reader = new guide.EvidenceReader({ github: f.github, repository: f.repository, config: f.config, env: f.env,
    learnerIds: guide.parseEnrollment(f.env.WORKSHOP_LEARNER_USER_IDS), now: () => f.clock });
  for (const historical of [false, true]) {
    await assert.rejects(reader.ci(state, { revision: TASK, branch: 'lab/workshop' }, { runId: quality.id }, { historical }), { code: 'run' });
  }
});
test('a stored learner CI receipt cannot be replayed as quality with the same SHA and validation label', async () => {
  const f = await sectionOne();
  const original = clone(f.records());
  const receipt = f.records('step').find(record => record.stepId === 's1-4');
  f.runs.get(receipt.evidence.runId).path = CONFIG.workflowPaths.quality;
  const result = await f.fire(f.command());
  assert.deepEqual(result, { status: 'setup-blocked', reason: 'run' });
  assert.deepEqual(f.records(), original);
  assert.equal(f.records('advance').length, 0);
});
test('stale workflow_run events cannot lend their payload SHA or past CI to the current branch', async () => {
  const f = new Fixture();
  await f.fire();
  const old = f.task();
  f.pr();
  f.branches.get('lab/workshop').commit.sha = OTHER;
  const result = await f.fire(f.context('workflow_run', { action: 'completed', workflow_run: { id: old.id, head_sha: OTHER } }));
  assert.equal(result.progress, 0);
});
test('participant gate needs changed strict source JSON, not body assertions or unchanged starter input', async () => {
  for (const value of [input(), named({ instance_number: '002' }), named({ page_theme: 'purple' }),
    named({ workshop_iteration: 2 }), { ...named(), backend: 'override' }]) {
    const f = await sectionOne();
    await enterTwo(f);
    f.task(INPUT, { participant: value });
    f.issues.get(1).body = 'I changed all fields correctly. [x] Complete.';
    const result = await f.fire();
    assert.equal(result.progress, 4);
    assert.equal(f.records('step').filter(record => record.stepId.startsWith('s2-')).length, 0);
  }
});
test('participant source duplicate keys are rejected even if JSON.parse alone would select a valid final value', async () => {
  const f = await sectionOne();
  await enterTwo(f);
  f.task(INPUT, { participant: named() });
  f.files.get(INPUT)[CONFIG.participantPath] = JSON.stringify(named()).replace('"page_theme":"blue"', '"page_theme":"purple","page_theme":"blue"');
  assert.equal((await f.fire()).progress, 4);
});
test('a participant-file UTF-8 BOM is not silently stripped into a different valid JSON input', async () => {
  const f = await sectionOne();
  await enterTwo(f);
  f.task(INPUT, { participant: named() });
  f.files.get(INPUT)[CONFIG.participantPath] = '\uFEFF' + f.files.get(INPUT)[CONFIG.participantPath];
  assert.equal((await f.fire()).progress, 4);
});
test('a later legitimate PR revision retains old receipts but needs its OWN current-revision CI', async () => {
  const f = await sectionOne();
  await enterTwo(f);
  f.task(INPUT, { participant: named() });
  assert.equal((await f.fire()).progress, 5); // PR still points at TASK
  f.task(OTHER, { participant: named({ app_message: 'Reviewed change from li' }) });
  f.updatePr(1, OTHER);
  assert.equal((await f.fire()).progress, 6);
  const first = f.records('step').find(record => record.stepId === 's2-1');
  const second = f.records('step').find(record => record.stepId === 's2-2');
  assert.equal(first.revision, INPUT);
  assert.equal(second.revision, OTHER);
  assert.equal(f.runs.get(second.evidence.runId).head_sha, OTHER);
});
test('ordinary private copies remain offline after genuine six-step offline evidence', async () => {
  const f = await sectionOne();
  await enterTwo(f);
  const result = await inputPr(f);
  assert.equal(result.progress, 6);
  assert.match(result.reason, /two exact approved private simulation IDs\/names/);
  assert.equal(f.records('step').some(record => record.stepId === 's2-3'), false);
  assert.equal(f.issues.get(1).state, 'open');
});
test('outsider comments cause no writes even if enrollment was removed or that outsider was added after the frozen cycle start', async () => {
  for (const enrollment of ['', '[101,303]']) {
    const f = await sectionOne();
    f.env.WORKSHOP_LEARNER_USER_IDS = enrollment;
    const before = f.writes.length;
    assert.equal((await f.fire(f.command(guide.COMMAND, OUTSIDER))).status, 'ignored');
    assert.equal(f.writes.length, before);
    assert.equal(f.records('advance').length, 0);
  }
});
test('future-dated exact comments are not consumed or queued', async () => {
  const f = await sectionOne();
  const event = f.command(guide.COMMAND, USER, { createdAt: new Date(f.clock + 60000).toISOString() });
  const before = f.writes.length;
  assert.equal((await f.fire(event)).status, 'ignored');
  assert.equal(f.writes.length, before);
  assert.equal(f.records('advance').length, 0);
});
test('missing registration cannot be reconstructed from a manually completed body or silently start a new cycle', async () => {
  const f = new Fixture();
  await f.fire();
  f.comments.clear();
  f.issues.get(1).body = '# Exercise 16/16 completed\n<!-- saved-cycle: done -->';
  assert.equal((await f.fire()).status, 'setup-blocked');
  assert.equal(f.issues.size, 1);
  assert.equal(f.records('start').length, 0);
  assert.equal(f.records('step').length, 0);
  assert.equal(f.issues.get(1).state, 'open');
});
test('a transition receipt from another cycle fails even if its JSON shape and server edit timestamps appear intact', async () => {
  const f = await sectionOne();
  await enterTwo(f);
  const comment = [...f.comments.values()].find(comment => recordOf(comment)?.kind === 'advance');
  const original = recordOf(comment);
  comment.body = comment.body.replace(JSON.stringify(original), JSON.stringify({ ...original, cycle: '0'.repeat(64) }));
  assert.equal((await f.fire()).status, 'setup-blocked');
  assert.equal(f.records('step').length, 4);
  assert.equal(f.records('advance').length, 1);
  assert.equal(f.issues.get(1).state, 'open');
});
test('both exact approved ID/name pairs are recognized, but an ID/name swap or same-name clone never admits live evidence', async () => {
  for (const [id, fullName] of Object.entries(guide.APPROVED_LIVE_REPOSITORIES)) {
    const f = new Fixture({ live: true, repository: { id: Number(id), full_name: fullName, name: fullName.split('/')[1], owner: { login: fullName.split('/')[0] } } });
    const prepared = await initialReady(f);
    assert.equal((await prepared.f.fire()).progress, 8);
  }
  for (const metadata of [
    { id: 900009 },
    { visibility: 'internal' },
    { full_name: 'training/not-approved', name: 'not-approved', owner: { login: 'training' } },
    { full_name: guide.APPROVED_LIVE_REPOSITORIES[1379147533], name: guide.APPROVED_LIVE_REPOSITORIES[1379147533].split('/')[1] },
  ]) {
    const { f } = await initialReady(new Fixture({ live: true, repository: metadata }));
    const result = await f.fire();
    assert.equal(result.progress, 6);
    assert.equal(f.records('step').some(record => record.stepId === 's2-3'), false);
  }
});

for (const scenario of ['digest', 'root', 'profile', 'repository', 'learner', 'participant', 'expired', 'workflow-bytes']) {
  test(`live root/profile/read-only content binding fails closed: ${scenario}`, async () => {
    const { f } = await initialReady();
    if (scenario === 'digest') f.env.WORKSHOP_OWNER_PROFILE_SHA256 = '0'.repeat(64);
    else if (scenario === 'workflow-bytes') f.files.get(MAIN1)[CONFIG.workflowPaths.delivery] += '# unreviewed\n';
    else {
      if (scenario === 'root') f.profile.root = 'other-root';
      if (scenario === 'profile') f.profile.profile = 'other-profile';
      if (scenario === 'repository') f.profile.repositoryId = '900009';
      if (scenario === 'learner') f.profile.assignment.learner_user_ids = [303];
      if (scenario === 'participant') f.profile.assignment.participant_name = 'other';
      if (scenario === 'expired') {
        f.profile.approvedAt = new Date(NOW - 7200000).toISOString();
        f.profile.expiresAt = new Date(NOW - 3600000).toISOString();
      }
      f.pinProfile();
    }
    assert.equal((await f.fire()).progress, 6);
  });
}
for (const scenario of ['attempt-two', 'event', 'path', 'main-moved', 'unprotected-main', 'before-activation', 'bot', 'head-repo', 'run-repo',
  'run-failed', 'apply-skipped', 'packaging-missing', 'job-run', 'job-sha', 'job-attempt', 'admission-readback']) {
  test(`initial delivery requires exact current-main first-attempt same-run apply AND packaging: ${scenario}`, async () => {
    const { f, run } = await initialReady();
    const jobs = f.jobs.get(run.id);
    const apply = jobs.find(job => job.name === CONFIG.jobs.apply);
    if (scenario === 'attempt-two') run.run_attempt = 2;
    if (scenario === 'event') run.event = 'workflow_dispatch';
    if (scenario === 'path') run.path = '.github/workflows/other-delivery.yml';
    if (scenario === 'main-moved') f.branches.get('main').commit.sha = OTHER;
    if (scenario === 'unprotected-main') f.branches.get('main').protected = false;
    if (scenario === 'before-activation') run.created_at = new Date(NOW - 1000).toISOString();
    if (scenario === 'bot') run.actor = run.triggering_actor = clone(BOT);
    if (scenario === 'head-repo') run.head_repository.id++;
    if (scenario === 'run-repo') run.repository.id++;
    if (scenario === 'run-failed') run.conclusion = 'failure';
    if (scenario === 'apply-skipped') apply.conclusion = 'skipped';
    if (scenario === 'packaging-missing') f.jobs.set(run.id, jobs.filter(job => job.name !== CONFIG.jobs.packaging));
    if (scenario === 'job-run') apply.run_id++;
    if (scenario === 'job-sha') apply.head_sha = OTHER;
    if (scenario === 'job-attempt') apply.run_attempt = 2;
    if (scenario === 'admission-readback') jobs.find(job => job.name === CONFIG.jobs.preflight).steps[0].name = 'Admission claims success without root/profile proof';
    assert.equal((await f.fire()).progress, 6);
  });
}
test('delivery needs the exact recorded later merged learner PR, not only any green main run', async () => {
  for (const scenario of ['association', 'merge-sha', 'head-sha', 'base', 'not-merged']) {
    const { f } = await initialReady();
    const journalBefore = f.records();
    const callsBefore = f.calls.length;
    const pr = f.prs.get(1);
    if (scenario === 'association') f.associations.set(MAIN1, []);
    if (scenario === 'merge-sha') pr.merge_commit_sha = OTHER;
    if (scenario === 'head-sha') pr.head.sha = OTHER;
    if (scenario === 'base') pr.base.ref = 'dev';
    if (scenario === 'not-merged') pr.merged = false;
    const result = await f.fire();
    if (scenario === 'base') {
      // The base is already bound into s1-3/s2-2. A permitted retarget
      // invalidates receipt equality; an unpermitted one fails PR validation.
      // Ledger replay blocks before delivery and must not report cached progress.
      const reason = f.config.permittedPullRequestBases.includes(pr.base.ref) ? 'journal' : 'pr';
      assert.deepEqual(result, { status: 'setup-blocked', reason }, scenario);
      assert.equal(f.calls.slice(callsBefore).some(call => call.name === 'repos.listPullRequestsAssociatedWithCommit'), false, scenario);
    } else {
      assert.equal(result.status, 'pending', scenario);
      assert.equal(result.progress, 6, scenario);
    }
    assert.deepEqual(f.records(), journalBefore, scenario);
    assert.equal(f.issues.get(1).state, 'open', scenario);
  }
});
test('the owner may be the live run actor only when pinned and currently an admin, never merely another writer', async () => {
  const { f, run } = await initialReady();
  run.actor = run.triggering_actor = clone(OWNER);
  assert.equal((await f.fire()).progress, 8);
  const second = await initialReady();
  second.run.actor = second.run.triggering_actor = clone(OWNER);
  second.f.permissions.set(OWNER.login, 'write');
  assert.equal((await second.f.fire()).progress, 6);
});
test('deployed verification must be the exact same delivery run, not a later unrelated green verification', async () => {
  const { f, run } = await initialReady();
  f.jobs.set(run.id, f.jobs.get(run.id).filter(job => job.name !== CONFIG.jobs.verification));
  assert.equal((await f.fire()).progress, 7);
  f.liveRun(MAIN1); // later actual run, cannot replace immutable s2-3 receipt
  const result = await f.fire();
  assert.equal(result.progress, 7);
  assert.equal(f.records('step').find(record => record.stepId === 's2-3').evidence.runId, run.id);
});
test('successful verification job without exact root/profile/input/readback metadata does not complete s2-4', async () => {
  for (const scenario of ['wrong-profile', 'wrong-root', 'wrong-input', 'skipped-step', 'before-activation']) {
    const { f, run } = await initialReady();
    const step = f.jobs.get(run.id).find(job => job.name === CONFIG.jobs.verification).steps[0];
    if (scenario === 'wrong-profile') step.name = step.name.replace(`owner=${f.env.WORKSHOP_OWNER_PROFILE_SHA256}`, `owner=${'0'.repeat(64)}`);
    if (scenario === 'wrong-root') step.name = step.name.replace('root=infra', 'root=other');
    if (scenario === 'wrong-input') step.name = step.name.replace(`participant=${jsonHash(named())}`, `participant=${'0'.repeat(64)}`);
    if (scenario === 'skipped-step') step.conclusion = 'skipped';
    if (scenario === 'before-activation') step.completed_at = new Date(NOW).toISOString();
    const result = await f.fire();
    // A wholly skipped verification job is rejected by job(), while the live
    // apply/packaging proof remains valid. No portal-visit claim is substituted.
    assert.equal(result.progress, 7, scenario);
    assert.match(f.issues.get(1).body, /does not prove a human visited the Azure portal/);
  }
});
test('a second old command created during the first gate is not reusable at the second gate', async () => {
  const f = await sectionOne(new Fixture({ live: true }));
  const first = f.command();
  const old = f.command();
  assert.equal((await f.fire(first)).status, 'advanced');
  await inputPr(f);
  f.merge(1, MAIN1);
  f.liveRun(MAIN1);
  assert.equal((await f.fire()).progress, 8);
  assert.equal((await f.fire()).status, 'paused');
  assert.equal(f.records('advance').length, 1);
  assert.equal((await f.fire(old)).status, 'early-command');
  assert.equal(f.records('advance').length, 1);
  assert.equal((await f.fire(f.command())).section, 3);
});

test('purple failure uses actual current strict JSON, unchanged trusted validator and the intended failed input step', async () => {
  const { f } = await sectionTwo();
  const run = await purple(f);
  const receipt = f.records('step').find(record => record.stepId === 's3-2');
  assert.equal(receipt.revision, PURPLE);
  assert.equal(receipt.evidence.runId, run.id);
  assert.equal(receipt.evidence.workflowPath, CONFIG.workflowPaths.learner);
  assert.equal(run.head_sha, PURPLE);
  assert.equal(receipt.evidence.rejection, 'page_theme:purple');
  assert.equal(receipt.evidence.validatorSha256, hash(f.files.get(BASE)['scripts/inputs.mjs']));
  assert.equal(f.calls.some(call => /log|artifact/i.test(call.name)), false);
});
test('a newer passing quality run does not conceal the same-SHA named learner purple rejection', async () => {
  const { f } = await sectionTwo();
  await f.fire(f.command());
  const participant = named({ page_theme: 'purple' });
  const learner = f.task(PURPLE, { branch: 'lab/update', participant, result: 'failure' });
  const quality = f.task(PURPLE, { branch: 'lab/update', participant, workflowPath: CONFIG.workflowPaths.quality });
  assert.equal(f.jobs.get(quality.id)[0].name, QUALITY_JOB);
  assert.equal(f.jobs.get(quality.id)[0].steps[0].name, QUALITY_INPUT_STEP);
  assert.equal((await f.fire()).progress, 10);
  const receipt = f.records('step').find(record => record.stepId === 's3-2');
  assert.equal(receipt.evidence.workflowPath, CONFIG.workflowPaths.learner);
  assert.equal(receipt.evidence.runId, learner.id);
  assert.equal(f.runs.get(receipt.evidence.runId).head_sha, PURPLE);
  assert.notEqual(receipt.evidence.runId, quality.id);
});
for (const result of ['success', 'failure']) {
  test(`a quality-only ${result} cannot impersonate the purple learner rejection, even with spoofed learner job/step labels`, async () => {
    const { f } = await sectionTwo();
    await f.fire(f.command());
    const quality = f.task(PURPLE, { branch: 'lab/update', participant: named({ page_theme: 'purple' }),
      result, workflowPath: CONFIG.workflowPaths.quality });
    const job = f.jobs.get(quality.id)[0];
    job.name = CONFIG.jobs.validation;
    job.steps[0].name = CONFIG.inputValidationStep;
    const observed = await f.fire();
    assert.equal(observed.progress, 9);
    assert.match(observed.reason, /No current-revision credential-free CI run/);
    assert.equal(f.records('step').some(record => record.stepId === 's3-2'), false);
  });
}
for (const scenario of ['blue', 'extra-invalid-field', 'wrong-step', 'other-failed-job', 'changed-validator', 'changed-workflow',
  'changed-mock-checker', 'wrong-sha', 'old-run', 'attempt-two']) {
  test(`unrelated failures cannot impersonate the purple input rejection: ${scenario}`, async () => {
    const { f } = await sectionTwo();
    await f.fire(f.command());
    const participant = named({ page_theme: 'purple' });
    if (scenario === 'blue') participant.page_theme = 'blue';
    if (scenario === 'extra-invalid-field') participant.instance_number = '002';
    const run = f.task(PURPLE, { branch: 'lab/update', participant, result: 'failure' });
    const job = f.jobs.get(run.id)[0];
    if (scenario === 'wrong-step') job.steps[0].name = 'Set up job';
    if (scenario === 'other-failed-job') {
      job.conclusion = 'success';
      job.steps[0].conclusion = 'success';
      f.makeJob(run, 'Unrelated test failure', { result: 'failure' });
    }
    if (scenario === 'changed-validator') f.files.get(PURPLE)['scripts/inputs.mjs'] = '// fake intended failure';
    if (scenario === 'changed-workflow') f.files.get(PURPLE)[CONFIG.learnerWorkflowPath] = canonical.replace('node scripts/inputs.mjs', 'node scripts/check.mjs');
    if (scenario === 'changed-mock-checker') f.files.get(PURPLE)['scripts/terraform-check.mjs'] = '// unreviewed mock checker';
    if (scenario === 'wrong-sha') { run.head_sha = OTHER; job.head_sha = OTHER; }
    if (scenario === 'old-run') run.created_at = new Date(NOW - 1000).toISOString();
    if (scenario === 'attempt-two') run.run_attempt = 2;
    const result = await f.fire();
    assert.equal(result.progress, 9, scenario);
    assert.equal(f.records('step').some(record => record.stepId === 's3-2'), false);
  });
}
test('Section 3 requires a fresh same-main-sha green iteration-02 delivery plus same-run verification', async () => {
  const { f } = await sectionTwo();
  const run = await sectionThree(f);
  const update = f.records('step').find(record => record.stepId === 's3-3');
  const verification = f.records('step').find(record => record.stepId === 's3-4');
  assert.equal(update.revision, MAIN2);
  assert.equal(update.evidence.runId, run.id);
  assert.equal(verification.evidence.runId, run.id);
  assert.equal(update.evidence.participantSha256, jsonHash(named({ page_theme: 'green', workshop_iteration: '02', app_message: 'Updated by li' })));
  assert.notEqual(update.revision, MAIN1);
  assert.equal(f.records('advance').length, 2);
  assert.equal(f.records('gate').length, 3);
});
for (const changes of [{ page_theme: 'orange', workshop_iteration: '02' }, { page_theme: 'green', workshop_iteration: '01' },
  { participant_name: 'other', page_theme: 'green', workshop_iteration: '02' }]) {
  test(`wrong fixed update cannot replace the preceding own deployment: ${JSON.stringify(changes)}`, async () => {
    const { f } = await sectionTwo();
    await purple(f);
    f.task(FIX, { branch: 'lab/update', participant: named(changes) });
    f.pr(FIX, { branch: 'lab/update' });
    f.merge(2, MAIN2);
    f.liveRun(MAIN2);
    assert.equal((await f.fire()).progress, 10);
  });
}
test('s3-1 and s4-1 reference their own exact preceding immutable run receipts, not newly invented probes', async () => {
  const { f } = await sectionTwo();
  await sectionThree(f);
  await enterFour(f);
  assert.equal((await f.fire()).progress, 13);
  const state = await f.state();
  for (const [currentId, previousId] of [['s3-1', 's2-4'], ['s4-1', 's3-4']]) {
    const current = state.receipts.find(receipt => receipt.stepId === currentId);
    const previous = state.receipts.find(receipt => receipt.stepId === previousId);
    assert.equal(current.evidence.runId, previous.evidence.runId);
    assert.equal(current.evidence.sourceReceiptHash, previous.hash);
    assert.equal(current.revision, previous.revision);
  }
});

test('followup requires current-main delivery dispatch, exact Confirm no-change job and matched readback', async () => {
  for (const scenario of ['wrong-event', 'wrong-workflow', 'wrong-job', 'wrong-operation', 'main-moved']) {
    const { f } = await sectionTwo();
    await sectionThree(f);
    await enterFour(f);
    const run = f.liveRun(MAIN2, 'followup');
    if (scenario === 'wrong-event') run.event = 'push';
    if (scenario === 'wrong-workflow') run.path = CONFIG.workflowPaths.cleanup;
    if (scenario === 'wrong-job') f.jobs.get(run.id).find(job => job.name === CONFIG.jobs.followup).name = 'Not the exact job';
    if (scenario === 'wrong-operation') f.jobs.get(run.id).find(job => job.name === CONFIG.jobs.followup).steps[0].name = 'No-change claim without bound operation';
    if (scenario === 'main-moved') f.branches.get('main').commit.sha = OTHER;
    assert.equal((await f.fire()).progress, 13, scenario);
  }
});
test('cleanup is a separate dispatch/workflow with exact authorized destroy, not a delivery push or optional skipped job', async () => {
  for (const scenario of ['wrong-event', 'delivery-path', 'skipped-destroy', 'wrong-name', 'missing-admission']) {
    const { f } = await sectionTwo();
    await sectionThree(f);
    await enterFour(f);
    f.liveRun(MAIN2, 'followup');
    assert.equal((await f.fire()).progress, 14);
    const run = f.liveRun(MAIN2, 'cleanup');
    if (scenario === 'wrong-event') run.event = 'push';
    if (scenario === 'delivery-path') run.path = CONFIG.workflowPaths.delivery;
    if (scenario === 'skipped-destroy') f.jobs.get(run.id).find(job => job.name === CONFIG.jobs.destroy).conclusion = 'skipped';
    if (scenario === 'wrong-name') f.jobs.get(run.id).find(job => job.name === CONFIG.jobs.destroy).name = 'Destroy something';
    if (scenario === 'missing-admission') f.jobs.get(run.id).find(job => job.name === CONFIG.jobs.preflight).steps[0].name = 'Admission without ownership/root/profile match';
    assert.equal((await f.fire()).progress, 14, scenario);
    assert.equal(f.issues.get(1).state, 'open');
  }
});
test('absence must succeed in the same recorded cleanup run; another green run cannot fill that gap', async () => {
  const { f } = await sectionTwo();
  await sectionThree(f);
  await enterFour(f);
  f.liveRun(MAIN2, 'followup');
  assert.equal((await f.fire()).progress, 14);
  const cleanup = f.liveRun(MAIN2, 'cleanup', { includeAbsence: false });
  assert.equal((await f.fire()).progress, 15);
  f.liveRun(MAIN2, 'cleanup');
  assert.equal((await f.fire()).progress, 15);
  assert.equal(f.records('step').find(record => record.stepId === 's4-3').evidence.runId, cleanup.id);
  assert.equal(f.issues.get(1).state, 'open');
});
test('complete synthetic cycle consumes EXACTLY three transition comments, retains the ENTIRE final lesson and closes without a fourth', async () => {
  const { f } = await sectionTwo();
  await sectionThree(f);
  await enterFour(f);
  const commands = f.records('advance').map(record => record.commandCommentId);
  assert.equal(commands.length, 3);
  assert.equal(new Set(commands).size, 3);
  f.liveRun(MAIN2, 'followup');
  assert.equal((await f.fire()).progress, 14);
  const cleanup = f.liveRun(MAIN2, 'cleanup');
  const result = await f.fire();
  assert.deepEqual(result, { status: 'completed', section: 4, step: 4, progress: 16 });
  assert.equal(f.records('advance').length, 3);
  assert.equal(f.records('gate').length, 3);
  assert.equal(f.records('step').length, 16);
  const state = await f.state();
  assert.equal(state.complete, true);
  assert.equal(state.receipts.at(-1).evidence.runId, cleanup.id);
  assert.equal(state.receipts.at(-1).evidence.sourceReceiptHash, state.receipts.at(-2).hash);
  assert.equal(f.issues.get(1).state, 'closed');
  assert.match(f.issues.get(1).body, /No fourth section command is needed/);
  assert.ok(f.issues.get(1).body.includes('## Full lesson .github/steps/s4-4.md\n\n' +
    'FINAL LESSON: verify workload absence, retain bootstrap, check billing, and contact the owner for recovery.\n'));
  const before = f.writes.length;
  assert.equal((await f.fire(f.command())).status, 'ignored');
  assert.equal(f.writes.length, before);
  assert.equal(f.records('advance').length, 3);
});
test('lost final issue update is recovered from verified receipts on a metadata event, not by requiring another command', async () => {
  const { f } = await sectionTwo();
  await sectionThree(f);
  await enterFour(f);
  f.liveRun(MAIN2, 'followup');
  await f.fire();
  f.liveRun(MAIN2, 'cleanup');
  let first = true;
  f.hooks.beforeIssueUpdate = changes => {
    if (changes.state === 'closed' && first) { first = false; throw new Error('Synthetic transport failure'); }
  };
  assert.equal((await f.fire()).status, 'error');
  assert.equal(f.records('step').length, 16);
  assert.equal(f.issues.get(1).state, 'open');
  f.hooks.beforeIssueUpdate = undefined;
  assert.equal((await f.fire()).status, 'completed');
  assert.equal(f.issues.get(1).state, 'closed');
  assert.equal(f.records('advance').length, 3);
});
test('a missing final lesson can never close the Exercise with fallback text instead of the full cleanup instructions', async () => {
  const { f } = await sectionTwo();
  await sectionThree(f);
  await enterFour(f);
  f.liveRun(MAIN2, 'followup');
  await f.fire();
  f.liveRun(MAIN2, 'cleanup');
  f.hooks.afterBotComment = (comment, fixture) => {
    if (recordOf(comment)?.stepId === 's4-4') fixture.missingFinal = true;
  };
  const result = await f.fire();
  assert.equal(result.status, 'setup-blocked');
  assert.equal(result.reason, 'lesson');
  assert.equal(f.records('step').length, 16);
  assert.equal(f.issues.get(1).state, 'open');
  f.missingFinal = false;
  f.hooks.afterBotComment = undefined;
  assert.equal((await f.fire()).status, 'completed');
  assert.equal(f.issues.get(1).state, 'closed');
  assert.match(f.issues.get(1).body, /FINAL LESSON: verify workload absence/);
  assert.equal(f.records('advance').length, 3);
});

function renderLesson(lesson, options = {}) {
  const f = new Fixture();
  return guide.renderIssue({ config: f.config, repository: f.repository, lesson, trustedRevision: BASE, ...options });
}
const sourceLesson = step => readFileSync(new URL(`../${step.lesson}`, import.meta.url), 'utf8');
const publicImages = `https://raw.githubusercontent.com/${CONFIG.sourceRepository}/${CONFIG.sourceDefaultBranch}/docs/images`;

test('lesson destinations use the actual private copy and learner receipt, frozen default docs and course-start references', async () => {
  const f = await sectionOne();
  const state = await f.state();
  const originalState = clone(state);
  const records = clone(f.records());
  const writes = f.writes.length;
  const repository = { ...f.repository, default_branch: 'training/docs-default' };
  const lesson = [
    '[Participant](../../exercise/participant.json#L1)',
    '[Installed checks](../workflows/learner-checks.yml)',
    '[Infrastructure](../../infra/web.tf)',
    '[App](../../app/public/page.js)',
    '[Setup](../../docs/start-here.md#before-you-start)',
    '[Mirror](../../full-ws-content/s2-1.md)',
    '[Starter](../../exercise/workflow-starter.yml)',
    '[Canonical checks](../../exercise/validation-workflow.yml)',
    '[Validator](../../scripts/inputs.mjs)',
    '[Course](../agentalvine/course.json)',
    '[Notice](../../docs/images/NOTICE.md)',
    '[![Reference](../../docs/images/s1-1.png "Public reference")](../../docs/architecture.md)',
  ].join('\n');
  const body = guide.renderIssue({ config: f.config, repository, state, lesson, trustedRevision: OTHER });
  const learner = `https://github.com/${f.repository.full_name}/blob/${TASK}`;
  const trusted = `https://github.com/${f.repository.full_name}/blob/${OTHER}`;
  const start = `https://github.com/${f.repository.full_name}/blob/${BASE}`;
  for (const [label, target] of [
    ['Participant', `${learner}/exercise/participant.json#L1`],
    ['Installed checks', `${learner}/.github/workflows/learner-checks.yml`],
    ['Infrastructure', `${learner}/infra/web.tf`],
    ['App', `${learner}/app/public/page.js`],
    ['Setup', `${trusted}/docs/start-here.md#before-you-start`],
    ['Mirror', `${trusted}/full-ws-content/s2-1.md`],
    ['Starter', `${start}/exercise/workflow-starter.yml`],
    ['Canonical checks', `${start}/exercise/validation-workflow.yml`],
    ['Validator', `${start}/scripts/inputs.mjs`],
    ['Course', `${start}/.github/agentalvine/course.json`],
    ['Notice', `${trusted}/docs/images/NOTICE.md`],
    ['Trusted lesson source', `${trusted}/.github/steps/s1-4.md`],
  ]) assert.ok(body.includes(`[${label}](${target})`), `${label}: ${target}`);
  assert.ok(body.includes(`[![Reference](${publicImages}/s1-1.png "Public reference")](${trusted}/docs/architecture.md)`));
  assert.equal(/\]\(\.\.?\//.test(body), false);
  assert.equal(body.includes('/blob/training/docs-default/'), false);
  assert.equal(body.includes(`raw.githubusercontent.com/${f.repository.full_name}/`), false);
  assert.equal(body.includes(`${CONFIG.sourceRepository}/${CONFIG.sourceDefaultBranch}/exercise/`), false);
  assert.deepEqual(state, originalState);
  assert.deepEqual(f.records(), records);
  assert.equal(f.writes.length, writes);
});

test('actual current lessons render absolute links at startup and after a human section transition without changing history', async () => {
  const f = new Fixture();
  for (const section of CONFIG.sections) for (const step of section.steps) f.lessons.set(step.lesson, sourceLesson(step));
  assert.equal((await f.fire()).status, 'started');
  const trusted = `https://github.com/${f.repository.full_name}/blob/${BASE}`;
  assert.ok(f.issues.get(1).body.includes(`](${trusted}/exercise/participant.json)`));
  assert.ok(f.issues.get(1).body.includes(`](${trusted}/docs/start-here.md)`));
  assert.ok(f.issues.get(1).body.includes(`](${publicImages}/s1-1.png)`));
  f.task();
  f.pr();
  assert.equal((await f.fire()).status, 'paused');
  const receipts = clone(f.records('step'));
  await enterTwo(f);
  const body = f.issues.get(1).body;
  assert.ok(body.includes(`](https://github.com/${f.repository.full_name}/blob/${TASK}/exercise/participant.json)`));
  assert.ok(body.includes(`](${trusted}/docs/instructor-setup.md)`));
  assert.ok(body.includes(`](${trusted}/docs/parameters.md#copilot-techniques--sections-2-and-3-only)`));
  assert.ok(body.includes(`](${publicImages}/s2-1.png)`));
  assert.equal(/\]\(\.\.?\//.test(body), false);
  assert.deepEqual(f.records('step'), receipts);
  assert.equal(f.records('advance').length, 1);
  assert.equal(f.issues.get(1).state, 'open');
});

for (const section of CONFIG.sections) for (const [index, step] of section.steps.entries()) {
  test(`published lesson ${step.id} resolves its real file links and public reference image`, () => {
    const body = renderLesson(sourceLesson(step), { state: { section: section.number, stepIndex: index, receipts: [] } });
    assert.ok(body.includes(`](${publicImages}/${step.id}.png)`));
    assert.ok(body.includes(`](https://github.com/training/learner-copy/blob/${BASE}/docs/images/NOTICE.md)`));
    assert.ok(body.includes(`](https://github.com/training/learner-copy/blob/${BASE}/${step.lesson})`));
    assert.equal(/\]\(\.\.?\//.test(body), false);
    for (const match of body.matchAll(/\]\(([^\s)]+)\)/g)) assert.equal(new URL(match[1]).protocol, 'https:');
  });
}

function publishedSourceFixture(options = {}) {
  const f = new Fixture(options);
  for (const section of CONFIG.sections) for (const step of section.steps) f.lessons.set(step.lesson, sourceLesson(step));
  assert.equal(f.lessons.size, 16, 'Every gate must load its actual published lesson, never the default synthetic lesson.');
  for (const filename of [...CONFIG.ciTrustedPaths, CONFIG.participantPath])
    f.files.get(BASE)[filename] = readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
  return f;
}

function publishedFence(f, id, language) {
  const step = CONFIG.sections.flatMap(section => section.steps).find(step => step.id === id);
  const lesson = f.lessons.get(step.lesson).replace(/\r\n/g, '\n');
  const matches = [...lesson.matchAll(/^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gm)];
  assert.equal(matches.length, 1, `${id}: retain exactly one complete example.`);
  assert.equal(matches[0][1], language);
  return matches[0][2];
}

function publishedAnswerPath(f, mode) {
  const initial = publishedFence(f, 's2-1', 'json').replaceAll('<name>', 'li');
  const fragment = publishedFence(f, 's3-2', 'json').replace(/\n$/, '');
  assert.equal(fragment.split('\n').length, 1, 'Purple is a line replacement, not a whole-file answer.');
  assert.equal((initial.match(/^[ \t]*"page_theme": "blue",$/gm) ?? []).length, 1);
  const manual = {
    initial,
    purple: initial.replace(/^[ \t]*"page_theme": "blue",$/m, fragment),
    updated: publishedFence(f, 's3-3', 'json').replaceAll('<name>', 'li'),
  };
  // Independent, deliberately reordered/minified candidates make the assisted
  // branch exercise different actual file bytes, not a relabeled manual call.
  const reviewed = {
    initial: '{"workshop_iteration":"01","page_theme":"blue","app_message":"Hello from li","instance_number":"001","participant_name":"li"}\n',
    purple: '{"workshop_iteration":"01","page_theme":"purple","app_message":"Hello from li","instance_number":"001","participant_name":"li"}\n',
    updated: '{"workshop_iteration":"02","page_theme":"green","app_message":"Updated by li","instance_number":"001","participant_name":"li"}\n',
  };
  const result = {};
  for (const stage of ['initial', 'purple', 'updated']) {
    const expected = parseParticipantJson(Buffer.from(manual[stage]));
    const candidate = parseParticipantJson(Buffer.from(reviewed[stage]));
    assert.notEqual(reviewed[stage], manual[stage]);
    assert.deepEqual(candidate, expected, `${stage}: review the candidate against the real published answer.`);
    assert.equal(jsonHash(candidate), jsonHash(expected));
    if (stage === 'purple') {
      assert.throws(() => validateProductionParticipant(expected, 'li'), /^AssertionError.*page_theme must be blue, green or orange/);
      assert.deepEqual(validateProductionParticipant({ ...candidate, page_theme: 'blue' }, 'li'),
        validateProductionParticipant(parseParticipantJson(Buffer.from(manual.initial)), 'li'));
    } else {
      assert.deepEqual(deriveNames(validateProductionParticipant(candidate, 'li')), deriveNames(validateProductionParticipant(expected, 'li')));
    }
    const text = mode === 'reviewed-assisted' ? reviewed[stage] : manual[stage];
    result[stage] = { text, value: parseParticipantJson(Buffer.from(text)), digest: jsonHash(expected) };
  }
  assert.deepEqual(FIELDS.filter(field => result.initial.value[field] !== result.updated.value[field]),
    ['app_message', 'page_theme', 'workshop_iteration']);
  assert.deepEqual(deriveNames(result.initial.value), deriveNames(result.updated.value));
  assert.equal(deriveNames(result.updated.value).resourceGroup, 'rg-li-001');
  assert.equal(deriveNames(result.updated.value).storage, 'stli001');
  return result;
}

function stagePublishedAnswer(f, sha, stage, options = {}) {
  const actual = parseParticipantJson(Buffer.from(stage.text));
  assert.deepEqual(actual, stage.value);
  if (actual.page_theme === 'purple') {
    assert.throws(() => validateProductionParticipant(actual, 'li'), /page_theme must be blue, green or orange/);
    validateProductionParticipant({ ...actual, page_theme: 'blue' }, 'li');
  } else validateProductionParticipant(actual, 'li');
  const run = f.task(sha, { ...options, participant: actual });
  f.files.get(sha)[CONFIG.participantPath] = stage.text;
  assert.equal(jsonHash(parseParticipantJson(Buffer.from(f.files.get(sha)[CONFIG.participantPath]))), stage.digest);
  return run;
}

function assertEntirePublishedLesson(body, f, step, learnerSha) {
  const lesson = f.lessons.get(step.lesson);
  const trusted = `https://github.com/${f.repository.full_name}/blob/${BASE}`;
  const learner = `https://github.com/${f.repository.full_name}/blob/${learnerSha}`;
  // Published lessons have simple inline relative destinations. Independently
  // rewrite only destinations; prose, fences, fallback answers and CRLF stay exact.
  const expected = lesson.replace(/\]\(\.\.\/\.\.\/([^\s)]+)\)/g, (_, target) => {
    if (/^docs\/images\/[^/]+\.png$/.test(target)) return `](${publicImages}/${target.split('/').at(-1)})`;
    return `](${target === CONFIG.participantPath || target.startsWith('infra/') ? learner : trusted}/${target})`;
  });
  assert.ok(body.includes(expected), `${step.id}: the complete real lesson/fallback must survive rendering.`);
  assert.equal(/\]\(\.\.?\//.test(body), false, step.id);
  assert.ok(body.includes(`](${trusted}/${step.lesson})`), step.id);
  assert.equal(body.includes('## Full lesson '), false, 'Never substitute the synthetic default lesson.');
  const fences = text => [...text.replace(/\r\n/g, '\n').matchAll(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm)].map(match => match[0]);
  assert.deepEqual(fences(body), fences(lesson), `${step.id}: preserve every actual fenced example.`);
}

for (const mode of ['reviewed-assisted', 'copy/manual']) {
  test(`all 16 dependent gates with actual lessons and ${mode} answers (synthetic metadata, no LLM/live services)`, async () => {
    const f = publishedSourceFixture({ live: true }); // Exact approved identity, but ONLY fake server metadata.
    const answers = publishedAnswerPath(f, mode);
    const courseDigest = jsonHash(CONFIG);
    const step = id => CONFIG.sections.flatMap(section => section.steps).find(step => step.id === id);
    const currentLesson = async id => {
      const state = await f.state();
      assertEntirePublishedLesson(f.issues.get(1).body, f, step(id), state.receipts.at(-1)?.revision ?? BASE);
    };
    const acceptedCommands = [];
    const advance = async section => {
      const before = clone(f.records('step'));
      const gate = f.records('gate').at(-1);
      const event = f.command();
      assert.equal(event.payload.comment.body, 'proceed to next section');
      const result = await f.fire(event);
      assert.equal(result.status, 'advanced');
      assert.equal(result.section, section);
      assert.equal(result.step, 1);
      assert.equal(result.progress, (section - 1) * 4);
      assert.deepEqual(f.records('step'), before, 'A boundary opens only step 1; it awards no step.');
      const consumed = f.records('advance').at(-1);
      assert.equal(consumed.commandCommentId, event.payload.comment.id);
      assert.equal(consumed.gateCommentId, [...f.comments.values()].find(comment => recordOf(comment)?.kind === 'gate' &&
        recordOf(comment).section === gate.section).id);
      assert.ok(Date.parse(consumed.commandCreatedAt) > Date.parse(consumed.promptCreatedAt));
      acceptedCommands.push(event.payload.comment.id);
      const writes = f.writes.length;
      assert.equal((await f.fire(event)).status, 'ignored', 'The same comment cannot advance again.');
      assert.equal(f.writes.length, writes);
      assert.deepEqual(f.records('step'), before);
      await currentLesson(`s${section}-1`);
    };
    const withholdCompletedJob = (run, name) => {
      const job = f.jobs.get(run.id).find(job => job.name === name);
      assert.ok(job);
      f.jobs.set(run.id, f.jobs.get(run.id).filter(candidate => candidate.id !== job.id));
      // Simulate delayed API visibility, not a future job retroactively changing
      // immutable historical receipts. Retain the original completed timestamps.
      return () => f.jobs.get(run.id).push(job);
    };

    assert.deepEqual(await f.fire(), { status: 'started', section: 1, step: 1, progress: 0 });
    await currentLesson('s1-1');
    const early = f.command();
    assert.equal((await f.fire(early)).status, 'early-command');
    assert.equal(f.records('advance').length, 0);
    const starter = validateProductionParticipant(parseParticipantJson(Buffer.from(f.files.get(BASE)[CONFIG.participantPath])));
    const readyMessage = f.lessons.get(step('s1-1').lesson).match(/from `Hello from alex` to `([^`]+)`/);
    assert.ok(readyMessage, 'Use the actual Section 1 edit.');
    const firstBranch = 'lab/first-check';
    f.task(TASK, { branch: firstBranch, participant: { ...starter, app_message: readyMessage[1] } });
    f.pr(TASK, { branch: firstBranch });
    assert.equal((await f.fire()).progress, 4);
    const originalReceipts = clone(f.records('step'));
    assert.equal((await f.fire()).status, 'paused', 'An early command must not be queued at the gate.');
    assert.equal(f.records('advance').length, 0);
    await currentLesson('s1-4');
    await advance(2);

    const initialCi = stagePublishedAnswer(f, INPUT, answers.initial, { branch: firstBranch });
    f.updatePr(1, INPUT);
    assert.equal((await f.fire()).progress, 6);
    assert.equal(f.records('step').find(record => record.stepId === 's2-2').evidence.runId, initialCi.id);
    f.merge(1, MAIN1);
    const initialRun = f.liveRun(MAIN1);
    const revealInitialVerification = withholdCompletedJob(initialRun, CONFIG.jobs.verification);
    assert.equal((await f.fire()).progress, 7, 'Apply/package does not prove deployment verification.');
    assert.equal(f.issues.get(1).state, 'open');
    revealInitialVerification();
    assert.equal((await f.fire()).progress, 8);
    assert.equal((await f.fire()).status, 'paused');
    await currentLesson('s2-4');
    await advance(3);

    assert.equal((await f.fire()).progress, 9, 'The preceding own baseline receipt is required before rejection.');
    const updateBranch = 'lab/theme-update';
    const rejected = stagePublishedAnswer(f, PURPLE, answers.purple, { branch: updateBranch, result: 'failure' });
    f.pr(PURPLE, { branch: updateBranch });
    assert.equal((await f.fire()).progress, 10);
    const purpleReceipt = clone(f.records('step').find(record => record.stepId === 's3-2'));
    assert.equal(purpleReceipt.revision, PURPLE);
    assert.equal(purpleReceipt.evidence.rejection, 'page_theme:purple');
    assert.equal(purpleReceipt.evidence.runId, rejected.id);
    assert.equal(purpleReceipt.evidence.participantSha256, answers.purple.digest);
    assert.equal(purpleReceipt.evidence.validatorSha256, hash(f.files.get(BASE)[CONFIG.validatorPath]));
    assert.equal(f.jobs.get(rejected.id)[0].steps[0].name, CONFIG.inputValidationStep);
    assert.equal(f.jobs.get(rejected.id)[0].steps[0].conclusion, 'failure');
    assert.equal(f.branches.get('main').commit.sha, MAIN1, 'Purple is never merged or deployed.');

    const fixedCi = stagePublishedAnswer(f, FIX, answers.updated, { branch: updateBranch });
    f.updatePr(2, FIX); // Correct the very same PR, not a new unrelated input history.
    assert.equal(fixedCi.conclusion, 'success');
    assert.equal((await f.fire()).progress, 10, 'A local correction/green CI is not a new main delivery.');
    assert.deepEqual(f.records('step').find(record => record.stepId === 's3-2'), purpleReceipt);
    f.merge(2, MAIN2);
    const updatedRun = f.liveRun(MAIN2);
    const revealUpdatedVerification = withholdCompletedJob(updatedRun, CONFIG.jobs.verification);
    assert.equal((await f.fire()).progress, 11);
    revealUpdatedVerification();
    assert.equal((await f.fire()).progress, 12);
    assert.equal((await f.fire()).status, 'paused');
    await currentLesson('s3-4');
    await advance(4);

    assert.equal((await f.fire()).progress, 13);
    const followup = f.liveRun(MAIN2, 'followup');
    assert.equal((await f.fire()).progress, 14);
    assert.equal(f.jobs.get(followup.id).some(job => job.name === CONFIG.jobs.apply), false, 'Followup is read-only.');
    f.liveRun(MAIN2, 'cleanup', { actor: OUTSIDER });
    assert.equal((await f.fire()).progress, 14, 'An unassigned cleanup actor cannot supply an authorized receipt.');
    const cleanup = f.liveRun(MAIN2, 'cleanup', { actor: OWNER });
    const revealAbsence = withholdCompletedJob(cleanup, CONFIG.jobs.absence);
    assert.equal(f.permissions.get(OWNER.login), 'admin');
    assert.equal((await f.fire()).progress, 15, 'Destroy alone cannot close the Exercise.');
    assert.equal(f.issues.get(1).state, 'open');
    revealAbsence();
    assert.deepEqual(await f.fire(), { status: 'completed', section: 4, step: 4, progress: 16 });

    const state = await f.state();
    const receipt = id => state.receipts.find(receipt => receipt.stepId === id);
    assert.equal(state.complete, true);
    assert.equal(f.issues.size, 1);
    assert.equal(f.issues.get(1).state, 'closed');
    assert.equal(f.records('gate').length, 3);
    assert.deepEqual(f.records('advance').map(record => record.commandCommentId), acceptedCommands);
    assert.equal(new Set(acceptedCommands).size, 3);
    assert.equal(acceptedCommands.includes(early.payload.comment.id), false);
    assert.deepEqual(f.records('step').slice(0, 4), originalReceipts);
    assert.deepEqual(state.receipts.map(receipt => receipt.stepId), CONFIG.sections.flatMap(section => section.steps.map(step => step.id)));
    assert.deepEqual(state.receipts.map(receipt => receipt.revision),
      [TASK, TASK, TASK, TASK, INPUT, INPUT, MAIN1, MAIN1, MAIN1, PURPLE, MAIN2, MAIN2, MAIN2, MAIN2, MAIN2, MAIN2]);
    for (const id of ['s2-1', 's2-2', 's2-3', 's2-4']) assert.equal(receipt(id).evidence.participantSha256, answers.initial.digest);
    for (const id of ['s3-3', 's3-4', 's4-2', 's4-3', 's4-4']) assert.equal(receipt(id).evidence.participantSha256, answers.updated.digest);
    for (const [verification, source, run] of [['s2-4', 's2-3', initialRun], ['s3-4', 's3-3', updatedRun], ['s4-4', 's4-3', cleanup]]) {
      assert.equal(receipt(verification).evidence.runId, run.id);
      assert.equal(receipt(source).evidence.runId, run.id);
      assert.equal(receipt(verification).evidence.sourceReceiptHash, receipt(source).hash);
    }
    for (const [current, previous] of [['s3-1', 's2-4'], ['s4-1', 's3-4'], ['s4-2', 's3-3'], ['s4-3', 's4-2']])
      assert.equal(receipt(current).evidence.sourceReceiptHash, receipt(previous).hash);
    assert.equal(receipt('s4-2').evidence.runId, followup.id);
    assert.equal(receipt('s4-2').evidence.operation, 'followup');
    assert.equal(receipt('s4-3').evidence.operation, 'destroy');
    assert.equal(receipt('s4-3').evidence.workflowPath, CONFIG.workflowPaths.cleanup);
    assert.equal(receipt('s4-3').evidence.event, 'workflow_dispatch');
    assert.equal(receipt('s4-3').evidence.actorId, OWNER.id);
    assert.notEqual(followup.id, cleanup.id);
    assert.notEqual(initialRun.id, updatedRun.id);
    assert.ok(Date.parse(receipt('s3-3').evidence.runCreatedAt) > Date.parse(purpleReceipt.evidence.validationCompletedAt));
    for (const revision of [INPUT, MAIN1, FIX, MAIN2]) {
      const actual = validateProductionParticipant(parseParticipantJson(Buffer.from(f.files.get(revision)[CONFIG.participantPath])), 'li');
      assert.deepEqual(deriveNames(actual), deriveNames(answers.initial.value));
    }
    assert.ok(f.records().every(record => record.courseDigest === courseDigest));
    assert.deepEqual(f.config, CONFIG, 'Do not change the course or its ledger hash to add an authoring path.');
    assert.equal(f.calls.some(call => /copilot|license|transcript|screenshot|completion|chat/i.test(call.name)), false);

    // Reconciliation can coalesce steps. Still render EVERY actual lesson with
    // its genuine preceding learner SHA and retain all source/fallback bytes.
    let offset = 0;
    for (const section of CONFIG.sections) for (const [index, current] of section.steps.entries()) {
      const prior = { ...state, section: section.number, stepIndex: index, complete: false, gate: null,
        receipts: state.receipts.slice(0, offset++) };
      const body = renderLesson(f.lessons.get(current.lesson), { repository: f.repository, state: prior });
      assertEntirePublishedLesson(body, f, current, prior.receipts.at(-1)?.revision ?? BASE);
    }
    await currentLesson('s4-4');
    const finalBody = f.issues.get(1).body;
    assert.match(finalBody, /Complete — 16\/16 verified/);
    assert.match(finalBody, /Sections 1: 4\/4 · 2: 4\/4 · 3: 4\/4 · 4: 4\/4/);
    assert.match(finalBody, /No fourth section command is needed/);
    const writes = f.writes.length;
    const records = clone(f.records());
    assert.equal((await f.fire()).status, 'ignored', 'Completion needs no fourth command.');
    assert.equal((await f.fire(f.command())).status, 'ignored', 'An unnecessary fourth command has no authority.');
    assert.equal(f.writes.length, writes);
    assert.deepEqual(f.records(), records);
    assert.equal(f.issues.get(1).body, finalBody);
    assert.deepEqual(f.failures, []);
  });

  test(`an unapproved copy stays live-blocked with ${mode} source answers even with pinned fake successful runs`, async () => {
    const f = publishedSourceFixture({ live: true, repository: { id: 900001, full_name: 'training/unapproved-copy',
      name: 'unapproved-copy', owner: { login: 'training' } } });
    const answers = publishedAnswerPath(f, mode);
    await sectionOne(f);
    await enterTwo(f);
    stagePublishedAnswer(f, INPUT, answers.initial);
    f.updatePr(1, INPUT);
    assert.equal((await f.fire()).progress, 6);
    f.merge(1, MAIN1);
    f.liveRun(MAIN1);
    const result = await f.fire();
    assert.equal(result.progress, 6);
    assert.match(result.reason, /two exact approved private simulation IDs\/names/);
    assert.equal(f.records('step').some(record => record.stepId === 's2-3'), false);
    assert.equal(f.records('advance').length, 1);
    assert.equal(f.issues.get(1).state, 'open');
    assert.deepEqual(f.config, CONFIG);
  });
}

test('source Actions Preview uses exactly the same absolute-link rendering and public images without writes or enrollment', async () => {
  const f = new Fixture({ enrollment: '', repository: { full_name: CONFIG.sourceRepository,
    name: CONFIG.sourceRepository.split('/')[1], owner: { login: 'alvinea28' }, private: false, visibility: 'public', is_template: true } });
  const step = CONFIG.sections[0].steps[0];
  f.lessons.set(step.lesson, sourceLesson(step));
  const result = await f.fire(f.context('workflow_dispatch', { inputs: { mode: 'Preview' } }));
  assert.equal(result.status, 'preview');
  assert.equal(result.progress, 0);
  assert.equal(f.summary.length, 1);
  assert.equal(f.summary[0], result.body);
  assert.ok(result.body.includes(`](https://github.com/${CONFIG.sourceRepository}/blob/${BASE}/exercise/participant.json)`));
  assert.ok(result.body.includes(`](https://github.com/${CONFIG.sourceRepository}/blob/${BASE}/docs/start-here.md)`));
  assert.ok(result.body.includes(`](https://github.com/${CONFIG.sourceRepository}/blob/${BASE}/${step.lesson})`));
  assert.ok(result.body.includes(`](${publicImages}/s1-1.png)`));
  assert.equal(/\]\(\.\.?\//.test(result.body), false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.issues.size, 0);
  assert.equal(f.calls.some(call => call.name === 'repos.getContent' || call.name === 'users.getById'), false);
});

test('private-copy Preview uses its observed default SHA, not learner history or a hardcoded default branch', async () => {
  const f = await sectionOne();
  const before = clone([...f.comments.values()]);
  const body = f.issues.get(1).body;
  const writes = f.writes.length;
  f.repository.default_branch = 'training/default';
  f.branches.set(f.repository.default_branch, { name: f.repository.default_branch, commit: { sha: OTHER }, protected: false });
  f.env.GUIDE_CHECKOUT_SHA = OTHER;
  f.env.GITHUB_WORKFLOW_SHA = OTHER;
  f.env.GITHUB_WORKFLOW_REF = `${f.repository.full_name}/${CONFIG.workflowPaths.guide}@refs/heads/${f.repository.default_branch}`;
  const step = CONFIG.sections[0].steps[0];
  f.lessons.set(step.lesson, sourceLesson(step));
  const result = await f.fire(f.context('workflow_dispatch', { inputs: { mode: 'Preview' } }));
  assert.equal(result.status, 'preview');
  assert.equal(result.progress, 0);
  assert.equal(f.summary.at(-1), result.body);
  assert.ok(result.body.includes(`](https://github.com/${f.repository.full_name}/blob/${OTHER}/exercise/participant.json)`));
  assert.ok(result.body.includes(`](https://github.com/${f.repository.full_name}/blob/${OTHER}/docs/start-here.md)`));
  assert.ok(result.body.includes(`](${publicImages}/s1-1.png)`));
  assert.equal(result.body.includes(`/blob/${TASK}/`), false);
  assert.equal(result.body.includes('/blob/training/default/'), false);
  assert.equal(f.writes.length, writes);
  assert.equal(f.issues.get(1).body, body);
  assert.deepEqual([...f.comments.values()], before);
});

test('HTTPS destinations, fragment-only anchors, titles and inline-code examples retain their exact source text', () => {
  const lesson = '[External](https://learn.microsoft.com/example?view=stable#heading "Official reference")\r\n' +
    '![External image](https://reference.example.invalid/image_(reference).png "Reference only")\r\n' +
    '[Angle](<https://github.com/example/reference#readme>) and [Expected](#expected-result).\r\n' +
    '`[Protected](../../../private.md)` and ``![Protected](../../exercise/participant.json)``.\r\n' +
    '\\[Literal, not a link](../../../private.md)';
  assert.ok(renderLesson(lesson).includes(lesson));
});

for (const [name, fence] of [
  ['backticks', '````markdown\r\n[Protected](../../../private.md)\r\n```\r\n' +
    '![Protected](../../exercise/participant.json)\r\n[Encoded](../../%2e%2e/private.md)\r\n`````\r\n'],
  ['indented tildes', '   ~~~~markdown\n[Protected](../../../private.md)\n~~~\n' +
    '![Protected](../../exercise/participant.json)\n   ~~~~~ \t\n'],
]) test(`relative-link conversion preserves all ${name} fence bytes and resumes only after the actual close`, () => {
  const body = renderLesson(`[Before](../../docs/start-here.md)\r\n${fence}\r\n[After](../../docs/recovery.md)`);
  assert.ok(body.includes(fence));
  assert.ok(body.includes(`[Before](https://github.com/training/learner-copy/blob/${BASE}/docs/start-here.md)`));
  assert.ok(body.includes(`[After](https://github.com/training/learner-copy/blob/${BASE}/docs/recovery.md)`));
});
test('an unclosed source code fence protects the entire remaining lesson without interpreting its links', () => {
  const protectedText = '```markdown\r\n[Protected](../../../private.md)\r\n' +
    '![Protected](../../exercise/participant.json)\r\n[Also code](../../docs/recovery.md)';
  const body = renderLesson(`[Before](../../docs/start-here.md)\r\n${protectedText}`);
  assert.ok(body.includes(protectedText));
  assert.ok(body.includes(`[Before](https://github.com/training/learner-copy/blob/${BASE}/docs/start-here.md)`));
});

test('reference-style links and images rewrite destinations only, retaining labels, angle brackets and attribution titles', () => {
  const lesson = '[Setup][setup] and [Recovery][].\n![Final reference][shot]\n![boundary]\n\n' +
    '[setup]: ../../docs/start-here.md#expected-result "Setup title"\n' +
    '[Recovery]: <../../docs/recovery.md> \'Recovery title\'\n' +
    '[shot]: ../../docs/images/s4-4.png "Reference attribution"\n' +
    '[boundary]: ../../docs/images/boundary.png\n';
  const repository = new Fixture().repository;
  const body = renderLesson(lesson, { repository });
  const trusted = `https://github.com/${repository.full_name}/blob/${BASE}`;
  assert.ok(body.includes('[Setup][setup] and [Recovery][].\n![Final reference][shot]\n![boundary]'));
  assert.ok(body.includes(`[setup]: ${trusted}/docs/start-here.md#expected-result "Setup title"`));
  assert.ok(body.includes(`[Recovery]: <${trusted}/docs/recovery.md> 'Recovery title'`));
  assert.ok(body.includes(`[shot]: ${publicImages}/s4-4.png "Reference attribution"`));
  assert.ok(body.includes(`[boundary]: ${publicImages}/boundary.png`));
  assert.equal(body.includes(`github.com/${CONFIG.sourceRepository}/blob/${BASE}/docs/`), false);
});

for (const target of [
  '../../../docs/start-here.md', '../../../../exercise/participant.json', '../../../outside/../docs/start-here.md',
  '../../%2e%2e/docs/start-here.md', '%2e%2e/%2e%2e/%2e%2e/private.md', '../../%252e%252e/private.md',
  '../../docs/%2e%2e/parameters.md', '../../docs/%73tart-here.md', '../../docs/%00start-here.md', '../../docs/%zz.md',
  '..\\/..\\/docs/start-here.md', '..\\..\\docs\\start-here.md', '../../docs/&#46;&#46;/parameters.md',
  '/docs/start-here.md', '//example.invalid/docs/start-here.md', 'C:/docs/start-here.md',
  'javascript:noop', 'data:text/plain,example', 'file:///docs/start-here.md', 'http://example.invalid/reference',
  'https://user:password@example.invalid/reference', '../../docs/start-here.md?raw=1',
  '../../docs/unknown.md', '../../docs/', '../../docs/start-here.md/', '../../docs/start-here.md/.',
  '../../exercise/unknown.json', '../../infra/terraform.tfstate',
  '../../infra/cleanup.tfplan', '../../infra/backend.hcl', '../../infra/.terraform/providers/provider',
  '../../app/.env', '../../app/public/participant.json', '../../full-ws-content/unknown.md',
  '../../docs/images/participant.png', '../../solutions/unpublished.tf', '../agentalvine/owner-profile.json',
]) test(`unsupported, escaped or root-escaping Markdown file destination is rejected: ${JSON.stringify(target)}`, () => {
  assert.throws(() => renderLesson(`[Unsupported](${target})`), { code: 'lesson-link' });
  assert.throws(() => renderLesson(`[Unsupported][target]\n\n[target]: <${target}>`), { code: 'lesson-link' });
});

for (const target of ['../../exercise/participant.json', '../../app/public/page.js', '../../infra/web.tf',
  '../../docs/start-here.md', '../../docs/images/manifest.json']) {
  test(`only known public reference screenshots can be Markdown images, never participant/source data: ${target}`, () => {
    assert.throws(() => renderLesson(`![Unsupported image](${target})`), { code: 'lesson-link' });
    assert.throws(() => renderLesson(`![Unsupported image][target]\n\n\x60\x60\x60markdown\nProtected example\n\x60\x60\x60\n\n[target]: ${target}`),
      { code: 'lesson-link' });
  });
}
test('unsafe lesson destinations fail Preview closed before any summary or issue write', async () => {
  const f = new Fixture();
  f.lessons.set(CONFIG.sections[0].steps[0].lesson, '[Unsupported](../../../private.md)');
  const result = await f.fire(f.context('workflow_dispatch', { inputs: { mode: 'Preview' } }));
  assert.deepEqual(result, { status: 'setup-blocked', reason: 'lesson-link' });
  assert.equal(f.summary.length, 0);
  assert.equal(f.writes.length, 0);
  assert.equal(f.records().length, 0);
});

test('the entire real retained final lesson keeps its public image, trusted recovery links, immutable receipts and three boundaries', async () => {
  const f = new Fixture({ live: true });
  const step = CONFIG.sections[3].steps[3];
  const lesson = sourceLesson(step);
  f.lessons.set(step.lesson, lesson);
  await sectionTwo(f);
  await sectionThree(f);
  await enterFour(f);
  f.liveRun(MAIN2, 'followup');
  assert.equal((await f.fire()).progress, 14);
  f.liveRun(MAIN2, 'cleanup');
  assert.deepEqual(await f.fire(), { status: 'completed', section: 4, step: 4, progress: 16 });
  const trusted = `https://github.com/${f.repository.full_name}/blob/${BASE}`;
  const expectedLesson = lesson
    .replaceAll('](../../docs/images/s4-4.png)', `](${publicImages}/s4-4.png)`)
    .replaceAll('](../../docs/images/NOTICE.md)', `](${trusted}/docs/images/NOTICE.md)`)
    .replaceAll('](../../docs/recovery.md)', `](${trusted}/docs/recovery.md)`);
  const body = f.issues.get(1).body;
  assert.ok(body.includes(expectedLesson), 'Retain every final instruction byte except the rewritten destinations.');
  assert.ok(body.includes(`](${publicImages}/s4-4.png)`));
  assert.equal(body.includes(`raw.githubusercontent.com/${f.repository.full_name}/`), false);
  assert.equal(/\]\(\.\.?\//.test(body), false);
  assert.match(body, /No fourth section command is needed/);
  assert.equal(f.issues.get(1).state, 'closed');
  assert.equal(f.records('step').length, 16);
  assert.equal(f.records('gate').length, 3);
  assert.equal(f.records('advance').length, 3);
  const receipts = clone(f.records());
  const writes = f.writes.length;
  assert.equal((await f.fire()).status, 'ignored');
  assert.equal(f.writes.length, writes);
  assert.equal(f.issues.get(1).body, body);
  assert.deepEqual(f.records(), receipts);
});

test('workflow is pinned, serialized, default-only and metadata-only, with separate read-only Preview permissions', () => {
  const workflow = readFileSync(new URL('../.github/workflows/guide.yml', import.meta.url), 'utf8');
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/);
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /group: agentalvine-\$\{\{ github\.repository_id \}\}/);
  assert.equal((workflow.match(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/g) ?? []).length, 2);
  assert.equal((workflow.match(/actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/g) ?? []).length, 2);
  assert.ok(!/^\s*(?:id-token|secrets):/m.test(workflow));
  assert.ok(!/^\s*run:/m.test(workflow));
  assert.ok(!/\$\{\{\s*(?:secrets\.|github\.event\.pull_request\.head|github\.event\.workflow_run\.head)/.test(workflow));
  const preview = workflow.split('  preview:')[1].split('  guide:')[0];
  assert.ok(!/issues:\s*write/.test(preview));
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /issues: write/);
});
test('observer implementation has no network client, shell, artifact/log download, source execution or workflow dispatch surface', () => {
  const source = readFileSync(new URL('../.github/agentalvine/guide.cjs', import.meta.url), 'utf8');
  for (const forbidden of ['node:child_process', 'execSync(', 'spawn(', 'fetch(', 'https.request(', 'createWorkflowDispatch(',
    'downloadArtifact(', 'downloadJobLogsForWorkflowJob(', 'updateFileContents(', 'createOrUpdateFileContents('])
    assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes("import('./"), false);
  assert.ok(source.includes('context.sha is the default branch'));
});
