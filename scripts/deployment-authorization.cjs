'use strict';

// READ-ONLY GitHub admission, not Azure/RBAC/budget enforcement or a deployment.
// All calls below are GETs. No approvals API, settings writes or CLI exists.
// Importing this module performs no calls and reads no environment variables.
//
// Required owner-managed environment contract (no defaults):
// WORKSHOP_AZURE_ENABLED=true, WORKSHOP_RG_CREATION_APPROVED=true;
// WORKSHOP_OWNER_PROFILE_JSON, WORKSHOP_OWNER_PROFILE_SHA256;
// WORKSHOP_BUDGET_CURRENCY, WORKSHOP_BUDGET_LIMIT_MINOR, WORKSHOP_EXPIRES_AT;
// WORKSHOP_PARTICIPANT_JSON, WORKSHOP_PARTICIPANT_SHA256;
// WORKSHOP_ASSIGNMENT_SHA256, WORKSHOP_PROVIDER_LOCK_SHA256, WORKSHOP_APP_SHA256,
// WORKSHOP_INFRA_SHA256, WORKSHOP_WORKFLOW_SHA256;
// ARM_SUBSCRIPTION_ID, ARM_TENANT_ID, PLAN_CLIENT_ID, APPLY_CLIENT_ID;
// STATE_RESOURCE_GROUP, STATE_STORAGE_ACCOUNT, STATE_CONTAINER, STATE_KEY;
// WS2_STATE_LOCK_ID, WORKSHOP_CONCURRENCY_GROUP=ws2-state-<WS2_STATE_LOCK_ID>,
// WORKSHOP_CANCEL_IN_PROGRESS=false; normal GITHUB_* runtime identity variables.
// Privileged phases also require ARM_CLIENT_ID for their distinct identity.
//
// Owner profile JSON v1 has EXACT fields listed in profileFields below.
// owner={id:<positive numeric string>,login:<GitHub login>}.
// budget={currency:<ISO uppercase code>,limitMinorUnits:<positive integer>,
//         maxLifetimeHours:<integer 1..24>} (a declaration, NOT a billing cap).
// ruleset={id:<number>,updatedAt:<server timestamp>,bypassActors:[],
//          verifiedAt:<owner/admin readback timestamp>}.
// environments={plan:<name>,apply:<different name>}; requiredChecks=[<context>,...].
// oidcSubjects={plan:<owner-verified actual sub>,apply:<owner-verified actual sub>}
// pins opaque, printable claims ending in :environment:workshop-plan/apply.
// Obtain and review the ACTUAL subjects; never derive them from repository names
// or fall back between legacy and immutable-ID formats. These exact strings are
// part of the canonical owner-profile digest, not separate token/env overrides.
// Assignment, backend and version fields follow plan-policy.mjs. The six profile
// digests are canonical assignment JSON plus original provider-lock/package/root
// HCL/delivery-workflow/cleanup-workflow bytes. Profile and participant digests
// are SHA256 of canonicalJson(). Pins MUST originate in separately owner-managed
// protected configuration, not learner-controlled workflow inputs/checkout.
//
// The caller must compute real checkout/package digests, pin trusted workflows,
// set actual workflow concurrency to the group above with cancellation OFF, use
// a single state writer, and repeat admission immediately before each privilege
// boundary. This helper cannot prove env provenance or spend/network/RBAC safety.

const ALLOWED_REPOSITORIES = Object.freeze({
  '1379147533': Object.freeze({ id: 1379147533, repository: 'alvine-aurelio-org/ws2-sim-20260921-network-module-laboratory-02', rulesetId: 23780379 }),
  '1379149907': Object.freeze({ id: 1379149907, repository: 'alvine-aurelio-org/ws2-sim-20260921-azure-delivery-laboratory-07', rulesetId: 23780383 }),
});
const JOBS = Object.freeze({
  preflight: 'Verify scoped workshop policy',
  validation: 'Validate reviewed workshop revision',
  plan: 'Create encrypted workshop plan',
  apply: 'Apply exact workshop plan',
});
const profileFields = ['schemaVersion', 'profile', 'repository', 'repositoryId', 'root', 'subscriptionId', 'tenant', 'planClientId',
  'applyClientId', 'backend', 'assignment', 'terraformVersion', 'providerVersion', 'assignmentSha256', 'providerLockSha256',
  'appSha256', 'infraSha256', 'deliveryWorkflowSha256', 'cleanupWorkflowSha256', 'owner', 'budget', 'approvedAt', 'expiresAt',
  'ruleset', 'environments', 'oidcSubjects', 'requiredChecks'];
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const numericString = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function insist(condition, message) {
  if (!condition) throw new Error(`Deployment admission: ${message}`);
}
function exact(value, fields, label) {
  insist(plainObject(value) && Object.keys(value).sort().join('\0') === [...fields].sort().join('\0'), `${label} has missing or unknown fields`);
}
function assertOidcSubject(subject, environment) {
  insist(environment === 'workshop-plan' || environment === 'workshop-apply', 'OIDC subjects require a literal workshop-plan/workshop-apply environment');
  const suffix = `:environment:${environment}`;
  insist(typeof subject === 'string' && subject.length > suffix.length && subject.length <= 600 &&
    /^[\x20-\x7e]+$/.test(subject) && !['*', '?', '[', ']', '{', '}'].some(character => subject.includes(character)) && subject.endsWith(suffix),
    'an owner-reviewed exact printable OIDC subject (maximum 600 characters, no wildcards) with its literal environment suffix is required');
  return subject;
}
function assertOidcSubjects(subjects) {
  exact(subjects, ['plan', 'apply'], 'owner OIDC subjects');
  assertOidcSubject(subjects.plan, 'workshop-plan');
  assertOidcSubject(subjects.apply, 'workshop-apply');
  return subjects;
}
function iso(value) {
  insist(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value), 'invalid UTC timestamp');
  const time = Date.parse(value);
  insist(Number.isFinite(time) && new Date(time).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'), 'invalid UTC timestamp');
  return time;
}
function routeFor(repository) {
  const route = Object.values(ALLOWED_REPOSITORIES).find(value => repository === value.repository || repository === value.id || repository === String(value.id));
  insist(route, 'repository is not one of the two immutable approved private simulations');
  return route;
}

function assertRepository(repository) {
  insist(plainObject(repository) && Number.isSafeInteger(repository.id), 'immutable numeric repository metadata is required');
  const route = routeFor(repository.id);
  insist(repository.id === route.id && repository.full_name === route.repository &&
    repository.name === route.repository.split('/')[1] && repository.owner?.login === 'alvine-aurelio-org', 'repository ID/name/owner mismatch');
  insist(repository.private === true && repository.visibility === 'private' && repository.is_template === false && repository.fork === false,
    'source repositories, public copies, forks and templates can never deploy');
  insist(repository.archived === false && repository.disabled === false, 'repository must be active');
  return route;
}

function operationFor(event, input, workflowRef, repository) {
  const route = routeFor(repository);
  const prefix = `${route.repository}/.github/workflows/`;
  if (workflowRef === `${prefix}cleanup.yml@refs/heads/main`) {
    insist(event === 'workflow_dispatch' && (input === undefined || input === 'destroy'), 'cleanup requires its separate explicit destroy dispatch');
    return 'destroy';
  }
  insist(workflowRef === `${prefix}delivery.yml@refs/heads/main`, 'only the exact main delivery or cleanup workflow is admitted');
  if (event === 'push') {
    insist(input === undefined, 'push cannot carry a dispatch operation');
    return 'deploy';
  }
  insist(event === 'workflow_dispatch' && input === 'followup', 'delivery dispatch is followup-only; other events are forbidden');
  return 'followup';
}

function assertEnvironmentProtection(environment, branches, expectedName) {
  insist(plainObject(environment) && (!expectedName || environment.name === expectedName), 'environment identity changed');
  const policy = environment.deployment_branch_policy;
  exact(policy, ['protected_branches', 'custom_branch_policies'], 'environment branch policy');
  insist(policy.protected_branches === false && policy.custom_branch_policies === true, 'explicit main-only environment policies are required');
  insist(Array.isArray(branches) && branches.length === 1 && branches[0].name === 'main' && branches[0].type === 'branch', 'environment must admit main and no other branch/tag');
  insist(environment.can_admins_bypass === false, 'environment administrator bypass must be disabled');
  insist(Array.isArray(environment.protection_rules) && environment.protection_rules.every(rule => rule.type === 'branch_policy') &&
    environment.protection_rules.length <= 1, 'this scoped automatic path has no deployment reviewers, timers or custom approval rules');
}

function assertRules(rules, requiredChecks) {
  insist(Array.isArray(requiredChecks) && requiredChecks.length > 0 && new Set(requiredChecks).size === requiredChecks.length &&
    requiredChecks.every(name => typeof name === 'string' && name.length > 0), 'nonempty owner-pinned required check contexts are mandatory');
  insist(Array.isArray(rules) && rules.length === 4 && new Set(rules.map(rule => rule.type)).size === 4 &&
    ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'].every(type => rules.some(rule => rule.type === type)), 'main protection rule inventory changed');
  const pr = rules.find(rule => rule.type === 'pull_request').parameters;
  insist(plainObject(pr) && pr.required_approving_review_count === 0 && pr.require_code_owner_review === false &&
    pr.require_last_push_approval === false && pr.dismiss_stale_reviews_on_push === true && pr.required_review_thread_resolution === true,
    'require protected PRs, zero mandatory approving reviews and resolved conversations');
  insist(pr.required_reviewers === undefined || (Array.isArray(pr.required_reviewers) && pr.required_reviewers.length === 0), 'additional PR reviewers are not part of this approved route');
  const status = rules.find(rule => rule.type === 'required_status_checks').parameters;
  insist(plainObject(status) && status.strict_required_status_checks_policy === true && Array.isArray(status.required_status_checks), 'strict required status checks are mandatory');
  const checks = status.required_status_checks;
  insist(checks.length === requiredChecks.length && new Set(checks.map(check => check.context)).size === checks.length &&
    checks.every(check => check.integration_id === 15368 && requiredChecks.includes(check.context)), 'required GitHub Actions checks differ from the owner pin');
  // Empty parameters cannot smuggle an exemption into deletion/force-push rules.
  for (const type of ['deletion', 'non_fast_forward']) {
    const parameters = rules.find(rule => rule.type === type).parameters;
    insist(parameters === undefined || (plainObject(parameters) && Object.keys(parameters).length === 0), 'unexpected deletion/force-push parameters');
  }
}

function assertRuleset(ruleset, profile, route) {
  insist(ruleset?.id === route.rulesetId && ruleset.id === profile.ruleset.id && ruleset.enforcement === 'active' && ruleset.target === 'branch' &&
    ruleset.source_type === 'Repository' && ruleset.source === route.repository, 'wrong or inactive main ruleset');
  insist(ruleset.updated_at === profile.ruleset.updatedAt, 'ruleset changed; obtain fresh owner/admin no-bypass evidence and a new reviewed profile pin');
  insist(ruleset.conditions?.ref_name && Object.keys(ruleset.conditions).length === 1 &&
    JSON.stringify(ruleset.conditions.ref_name.include) === '["refs/heads/main"]' && JSON.stringify(ruleset.conditions.ref_name.exclude) === '[]' &&
    Object.keys(ruleset.conditions.ref_name).length === 2, 'ruleset must target exactly main');
  if (Object.hasOwn(ruleset, 'bypass_actors')) insist(Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0, 'main bypass actors are forbidden');
  // Missing bypass_actors is NOT []. Only a separately owner-pinned server ID,
  // updated_at and explicit admin-read-back EMPTY list permit the hidden shape.
  else insist(profile.ruleset.id === ruleset.id && profile.ruleset.updatedAt === ruleset.updated_at &&
    Array.isArray(profile.ruleset.bypassActors) && profile.ruleset.bypassActors.length === 0 &&
    iso(profile.ruleset.verifiedAt) >= iso(ruleset.updated_at), 'hidden bypass actors require exact owner-pinned revision evidence');
  assertRules(ruleset.rules, profile.requiredChecks);
}

function assertJobs(jobs, { phase, runId, sha, attemptSpecificVerified = false }) {
  insist(['plan', 'apply'].includes(phase) && Number.isSafeInteger(runId) && SHA.test(sha) && Array.isArray(jobs), 'same-run jobs or privilege phase could not be verified');
  // Only a verified attempt-specific collection can omit the optional DTO field.
  // A populated contradiction is forbidden even on an otherwise unrelated job.
  insist(jobs.every(job => plainObject(job) && (job.run_attempt === 1 ||
    (attemptSpecificVerified === true && !Object.hasOwn(job, 'run_attempt')))), 'job attempt is missing, contradictory or belongs to a rerun');
  const required = phase === 'apply' ? [JOBS.preflight, JOBS.validation, JOBS.plan] : [JOBS.preflight, JOBS.validation];
  for (const name of required) {
    const matches = jobs.filter(job => job.name === name);
    insist(matches.length === 1, 'require each unique exact same-run prerequisite job');
    const job = matches[0];
    insist(job.run_id === runId && job.head_sha === sha && job.status === 'completed' && job.conclusion === 'success',
      'prerequisite job is stale, skipped, failed or belongs to another run/attempt/revision');
    insist(typeof job.completed_at === 'string' && Number.isFinite(Date.parse(job.completed_at)) && Date.parse(job.completed_at) <= Date.now(), 'job completion time is missing or future-dated');
  }
  const currentName = phase === 'apply' ? JOBS.apply : JOBS.plan;
  const current = jobs.filter(job => job.name === currentName);
  insist(current.length === 1 && current[0].run_id === runId && current[0].head_sha === sha &&
    current[0].status === 'in_progress' && current[0].conclusion === null, 'the current privilege-phase job is not the unique active job');
}

function assertRun(run, context, env, route, operation) {
  insist(run?.id === context.runId && run.run_attempt === 1 && run.head_sha === context.sha && run.head_branch === 'main' &&
    run.event === context.eventName && run.status === 'in_progress' && run.conclusion === null, 'workflow run metadata is stale, rerun or untrusted');
  insist(run.repository?.id === route.id && run.repository?.full_name === route.repository &&
    run.head_repository?.id === route.id && run.head_repository?.full_name === route.repository, 'run repository provenance mismatch');
  insist(run.path === `.github/workflows/${operation === 'destroy' ? 'cleanup.yml' : 'delivery.yml'}`, 'unexpected workflow path');
  const actor = run.actor;
  const triggering = run.triggering_actor;
  const sender = context.payload.sender;
  insist(actor?.type === 'User' && Number.isSafeInteger(actor.id) && actor.id > 0 && typeof actor.login === 'string' &&
    triggering?.type === 'User' && triggering.id === actor.id && triggering.login === actor.login &&
    sender?.type === 'User' && sender.id === actor.id && sender.login === actor.login &&
    env.GITHUB_ACTOR_ID === String(actor.id) && env.GITHUB_ACTOR === actor.login && context.actor === actor.login &&
    env.GITHUB_TRIGGERING_ACTOR === actor.login, 'numeric sender, actor and authenticated run identities must agree');
  return actor;
}

async function authorize({ github, context, core, phase = 'preflight', env = process.env }) {
  insist(['preflight', 'plan', 'apply'].includes(phase), 'unknown privilege phase');
  insist(env.WORKSHOP_AZURE_ENABLED === 'true' && env.WORKSHOP_RG_CREATION_APPROVED === 'true', 'Azure and new resource-group creation both require explicit owner enablement');
  for (const name of ['ARM_CLIENT_SECRET', 'ARM_CLIENT_CERTIFICATE', 'ARM_CLIENT_CERTIFICATE_PATH', 'ARM_CLIENT_CERTIFICATE_PASSWORD', 'ARM_ACCESS_KEY', 'ARM_SAS_TOKEN', 'AZURE_CLIENT_SECRET'])
    insist(!Object.hasOwn(env, name), 'long-lived identity/backend credential slots are forbidden; use scoped OIDC only');
  insist(context && SHA.test(context.sha) && Number.isSafeInteger(context.runId) && context.runId > 0, 'invalid runtime identity');
  const route = assertRepository(context.payload?.repository);
  insist(`${context.repo?.owner}/${context.repo?.repo}` === route.repository && env.GITHUB_REPOSITORY === route.repository &&
    env.GITHUB_REPOSITORY_ID === String(route.id), 'runtime repository identity mismatch');
  insist(env.GITHUB_REF === 'refs/heads/main' && context.ref === 'refs/heads/main' && env.GITHUB_REF_PROTECTED === 'true' &&
    env.GITHUB_RUN_ATTEMPT === '1' && env.GITHUB_SHA === context.sha && env.GITHUB_RUN_ID === String(context.runId) &&
    env.GITHUB_EVENT_NAME === context.eventName, 'only a first attempt at the current protected main revision is admitted');
  insist(env.GITHUB_WORKFLOW_SHA === context.sha, 'the workflow itself must come from the admitted main revision');
  const operation = operationFor(context.eventName, context.payload.inputs?.operation, env.GITHUB_WORKFLOW_REF, route.repository);
  if (env.OPERATION !== undefined) insist(env.OPERATION === operation, 'operation differs from the event/workflow route');
  if (context.eventName === 'push') insist(context.payload.ref === 'refs/heads/main' && context.payload.after === context.sha &&
    context.payload.deleted === false && context.payload.forced === false, 'force/deletion/non-main pushes cannot deploy');
  else {
    const fields = operation === 'destroy' ? ['authorization', ...(Object.hasOwn(context.payload.inputs ?? {}, 'operation') ? ['operation'] : [])] : ['operation'];
    exact(context.payload.inputs, fields, 'dispatch inputs');
  }
  if (phase === 'apply') insist(operation === 'deploy' || operation === 'destroy', 'followup is read-only and has no apply phase');

  const policy = await import('./plan-policy.mjs');
  const { validateAssignment, validateParticipant } = await import('./inputs.mjs');
  insist(typeof env.WORKSHOP_OWNER_PROFILE_JSON === 'string' && DIGEST.test(env.WORKSHOP_OWNER_PROFILE_SHA256 ?? ''), 'explicit owner profile and pinned digest are required');
  const profile = policy.parseStrictJson(Buffer.from(env.WORKSHOP_OWNER_PROFILE_JSON));
  exact(profile, profileFields, 'owner profile');
  const profileDigest = policy.hash(policy.canonicalJson(profile));
  insist(profileDigest === env.WORKSHOP_OWNER_PROFILE_SHA256 && profile.schemaVersion === 1 && profile.profile === policy.PROFILE &&
    profile.repositoryId === String(route.id) && profile.repository === route.repository && profile.root === 'infra', 'owner profile digest, version, root or immutable repository identity mismatch');
  exact(profile.owner, ['id', 'login'], 'owner identity');
  insist(numericString(profile.owner.id) && typeof profile.owner.login === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(profile.owner.login), 'owner numeric identity is required');
  exact(profile.budget, ['currency', 'limitMinorUnits', 'maxLifetimeHours'], 'budget');
  insist(typeof profile.budget.currency === 'string' && /^[A-Z]{3}$/.test(profile.budget.currency) &&
    Number.isSafeInteger(profile.budget.limitMinorUnits) && profile.budget.limitMinorUnits > 0 &&
    Number.isInteger(profile.budget.maxLifetimeHours) && profile.budget.maxLifetimeHours >= 1 && profile.budget.maxLifetimeHours <= 24, 'a finite positive owner budget and bounded lifetime are required');
  insist(env.WORKSHOP_BUDGET_CURRENCY === profile.budget.currency && env.WORKSHOP_BUDGET_LIMIT_MINOR === String(profile.budget.limitMinorUnits) &&
    env.WORKSHOP_EXPIRES_AT === profile.expiresAt, 'explicit budget/expiry bindings differ from owner authorization');
  const now = Date.now();
  const approvedAt = iso(profile.approvedAt);
  const expiresAt = iso(profile.expiresAt);
  insist(approvedAt <= now && expiresAt > now && expiresAt - approvedAt <= profile.budget.maxLifetimeHours * 60 * 60 * 1000 &&
    profile.assignment?.expires_at === profile.expiresAt, 'owner authorization is expired, future-dated or exceeds its lifetime');
  try { validateAssignment(profile.assignment, { live: true, now }); }
  catch { throw new Error('Deployment admission: invalid or inactive live owner assignment'); }
  exact(profile.ruleset, ['id', 'updatedAt', 'bypassActors', 'verifiedAt'], 'owner ruleset evidence');
  insist(profile.ruleset.id === route.rulesetId && Array.isArray(profile.ruleset.bypassActors) && profile.ruleset.bypassActors.length === 0 &&
    iso(profile.ruleset.updatedAt) <= iso(profile.ruleset.verifiedAt) && iso(profile.ruleset.verifiedAt) <= approvedAt, 'owner-pinned no-bypass server revision evidence is required');
  exact(profile.environments, ['plan', 'apply'], 'environment names');
  insist(Object.values(profile.environments).every(name => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/.test(name)) &&
    profile.environments.plan !== profile.environments.apply, 'distinct pinned plan/apply environments are required');
  insist(profile.environments.plan === 'workshop-plan' && profile.environments.apply === 'workshop-apply', 'pin the literal workshop-plan/workshop-apply environments');
  assertOidcSubjects(profile.oidcSubjects);
  insist(Array.isArray(profile.requiredChecks) && profile.requiredChecks.length > 0 && profile.requiredChecks.length <= 16 &&
    new Set(profile.requiredChecks).size === profile.requiredChecks.length && profile.requiredChecks.every(name => typeof name === 'string' &&
      /^[A-Za-z0-9][A-Za-z0-9 _/().-]{0,99}$/.test(name) && ![JOBS.preflight, JOBS.plan, JOBS.apply].includes(name)), 'pin unique nonprivileged required check contexts');

  insist(typeof env.WORKSHOP_PARTICIPANT_JSON === 'string', 'current reviewed participant input is required');
  const participant = policy.parseStrictJson(Buffer.from(env.WORKSHOP_PARTICIPANT_JSON));
  try { validateParticipant(participant, profile.assignment.participant_name); }
  catch { throw new Error('Deployment admission: invalid or unfrozen participant input'); }
  insist(policy.hash(policy.canonicalJson(participant)) === env.WORKSHOP_PARTICIPANT_SHA256, 'participant digest mismatch');
  const workflowSha256 = operation === 'destroy' ? profile.cleanupWorkflowSha256 : profile.deliveryWorkflowSha256;
  for (const [field, variable] of Object.entries({ assignmentSha256: 'WORKSHOP_ASSIGNMENT_SHA256', providerLockSha256: 'WORKSHOP_PROVIDER_LOCK_SHA256',
    appSha256: 'WORKSHOP_APP_SHA256', infraSha256: 'WORKSHOP_INFRA_SHA256' }))
    insist(DIGEST.test(profile[field] ?? '') && env[variable] === profile[field], 'reviewed dependency digest differs from its owner pin');
  insist(DIGEST.test(profile.deliveryWorkflowSha256 ?? '') && DIGEST.test(profile.cleanupWorkflowSha256 ?? '') && env.WORKSHOP_WORKFLOW_SHA256 === workflowSha256,
    'workflow digest differs from its owner pin');
  const binding = policy.validateBinding({ profile: profile.profile, repository: route.repository, repositoryId: String(route.id), workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: String(context.runId), runAttempt: '1', sha: context.sha, root: 'infra', operation, subscriptionId: profile.subscriptionId, tenant: profile.tenant,
    planClientId: profile.planClientId, applyClientId: profile.applyClientId, backend: profile.backend, participant, assignment: profile.assignment,
    terraformVersion: profile.terraformVersion, providerVersion: profile.providerVersion, participantSha256: env.WORKSHOP_PARTICIPANT_SHA256,
    assignmentSha256: profile.assignmentSha256, providerLockSha256: profile.providerLockSha256, appSha256: profile.appSha256,
    infraSha256: profile.infraSha256, workflowSha256, ownerProfileSha256: profileDigest });
  const backend = binding.backend;
  const concurrencyGroup = `ws2-state-${backend.stateLockId}`;
  insist(env.ARM_SUBSCRIPTION_ID === binding.subscriptionId && env.ARM_TENANT_ID === binding.tenant &&
    env.PLAN_CLIENT_ID === binding.planClientId && env.APPLY_CLIENT_ID === binding.applyClientId &&
    env.STATE_RESOURCE_GROUP === backend.resourceGroupName && env.STATE_STORAGE_ACCOUNT === backend.storageAccountName &&
    env.STATE_CONTAINER === backend.containerName && env.STATE_KEY === backend.key && env.WS2_STATE_LOCK_ID === backend.stateLockId &&
    env.WORKSHOP_CONCURRENCY_GROUP === concurrencyGroup && env.WORKSHOP_CANCEL_IN_PROGRESS === 'false', 'scope, isolated backend or noncancelling concurrency binding mismatch');
  if (phase !== 'preflight') insist(env.ARM_CLIENT_ID === (phase === 'plan' ? binding.planClientId : binding.applyClientId), 'wrong privilege-phase OIDC client');

  const params = context.repo;
  assertRepository((await github.rest.repos.get(params)).data);
  const readRun = async () => (await github.rest.actions.getWorkflowRun({ ...params, run_id: context.runId })).data;
  const actor = assertRun(await readRun(), context, env, route, operation);
  insist(profile.assignment.learner_user_ids.includes(actor.id) || String(actor.id) === profile.owner.id, 'run actor is not enrolled or the approved owner');
  const ownerPermission = (await github.rest.repos.getCollaboratorPermissionLevel({ ...params, username: profile.owner.login })).data;
  insist(ownerPermission?.permission === 'admin' && ownerPermission.user?.id === Number(profile.owner.id) &&
    ownerPermission.user?.login === profile.owner.login && ownerPermission.user?.type === 'User', 'profile owner is not the current authenticated numeric repository admin');
  const readMain = async () => {
    const branch = (await github.rest.repos.getBranch({ ...params, branch: 'main' })).data;
    insist(branch?.protected === true && branch.name === 'main' && branch.commit?.sha === context.sha, 'protected main moved or protections disappeared');
    return branch;
  };
  await readMain();
  const ruleset = (await github.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', { ...params, ruleset_id: profile.ruleset.id })).data;
  assertRuleset(ruleset, profile, route);
  const effective = await github.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', { ...params, branch: 'main', per_page: 100 });
  assertRules(effective, profile.requiredChecks);
  insist(effective.every(rule => rule.ruleset_id === profile.ruleset.id), 'unexpected inherited or replacement main policy');
  const checkRuns = await github.paginate(github.rest.checks.listForRef, { ...params, ref: context.sha, filter: 'latest', per_page: 100 });
  for (const name of profile.requiredChecks) {
    const matches = checkRuns.filter(check => check.name === name && check.app?.id === 15368);
    insist(matches.length === 1 && matches[0].head_sha === context.sha && matches[0].status === 'completed' && matches[0].conclusion === 'success',
      'a pinned required GitHub Actions check is missing, ambiguous or unsuccessful at this revision');
  }
  const prs = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...params, commit_sha: context.sha, per_page: 100 });
  const candidates = prs.filter(pr => pr.merged_at && pr.state === 'closed' && pr.base?.ref === 'main' && pr.base.repo?.id === route.id &&
    pr.head?.repo?.id === route.id && pr.merge_commit_sha === context.sha && Number.isSafeInteger(pr.number));
  insist(candidates.length === 1, 'require unique actual protected-main merged-PR provenance, not approval history');
  const pr = (await github.rest.pulls.get({ ...params, pull_number: candidates[0].number })).data;
  insist(pr.number === candidates[0].number && pr.merged === true && pr.merged_at && pr.state === 'closed' && pr.merge_commit_sha === context.sha &&
    pr.base?.ref === 'main' && pr.base.repo?.id === route.id && pr.head?.repo?.id === route.id, 'merged PR provenance changed');
  for (const name of Object.values(profile.environments)) {
    const environment = (await github.rest.repos.getEnvironment({ ...params, environment_name: name })).data;
    const branches = await github.paginate(github.rest.repos.listDeploymentBranchPolicies, { ...params, environment_name: name, per_page: 100 });
    assertEnvironmentProtection(environment, branches, name);
  }
  if (operation === 'destroy') {
    insist(context.payload.inputs.authorization === `destroy:${route.id}:${context.sha}:${backend.stateLockId}`, 'cleanup authorization must bind the current repository, SHA and owned backend concurrency identity');
    const permission = (await github.rest.repos.getCollaboratorPermissionLevel({ ...params, username: actor.login })).data;
    insist(permission?.permission === 'admin' && permission.user?.type === 'User' && permission.user?.id === actor.id && permission.user?.login === actor.login,
      'only the current authenticated numeric admin may authorize cleanup');
  }
  if (phase !== 'preflight') {
    const jobs = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
      { ...params, run_id: context.runId, attempt_number: 1, per_page: 100 });
    // assertRun verified this live run's first attempt before this exact GET;
    // the final metadata read below must still verify that same first attempt.
    assertJobs(jobs, { phase, runId: context.runId, sha: context.sha, attemptSpecificVerified: true });
  }
  // A second metadata read closes obvious movement during the preceding GETs.
  // It is not a transaction: manifest/current-main verification is still needed
  // immediately before applying the already saved, authenticated plan.
  assertRepository((await github.rest.repos.get(params)).data);
  assertRun(await readRun(), context, env, route, operation);
  const branch = await readMain();
  insist(Date.now() < expiresAt, 'owner authorization expired during admission');
  insist(core && typeof core.setOutput === 'function', 'GitHub Actions output adapter is required');
  core.setOutput('operation', operation);
  core.setOutput('main_sha', branch.commit.sha);
  core.setOutput('state_lock_id', backend.stateLockId);
  core.setOutput('concurrency_group', concurrencyGroup);
  core.setOutput('owner_profile_sha256', profileDigest);
  if (core.summary) {
    core.summary.addHeading('Scoped workshop admission verified').addRaw(
      `Repository ID ${route.id}; run ${context.runId}/1; revision ${context.sha}; phase ${phase}; operation ${operation}. No Azure permission or human deployment approval was granted.`, true);
    await core.summary.write();
  }
  return { operation, mainSha: branch.commit.sha, stateLockId: backend.stateLockId, concurrencyGroup, ownerProfileSha256: profileDigest, binding };
}

module.exports = { authorize, assertRepository, operationFor, assertEnvironmentProtection, assertRules, assertRuleset, assertJobs,
  assertOidcSubject, assertOidcSubjects, ALLOWED_REPOSITORIES, JOBS };
