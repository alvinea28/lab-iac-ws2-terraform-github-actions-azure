import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import authorization from './deployment-authorization.cjs';
import { ROOT, terraformVariables, validateParticipant } from './inputs.mjs';
import { buildPackage, MAX_PACKAGE_BYTES } from './package-app.mjs';
import { sealPlan, openPlan } from './plan-envelope.mjs';
import { canonicalJson, hash, parseStrictJson, validateBinding, summarizePlan, makeManifest, verifyPlan } from './plan-policy.mjs';
import { API, ARM_ORIGIN, boundedBytes, createArmClient, managedState, resourceIds, readSnapshot, validateReadback, cleanupInventory, verifyAbsence, verifyHealth } from './azure-readback.mjs';

export const MODES = Object.freeze(['verify', 'preflight', 'plan', 'apply', 'followup', 'package-deploy', 'verify-deployed', 'cleanup-inventory', 'verify-absence', 'clean']);
export const ENVIRONMENTS = Object.freeze({ plan: 'workshop-plan', apply: 'workshop-apply' });
export const CONTROL_FILES = Object.freeze(['package.json', 'package-lock.json', 'scripts/delivery.mjs', 'scripts/package-app.mjs', 'scripts/azure-readback.mjs',
  'scripts/deployment-authorization.cjs', 'scripts/inputs.mjs', 'scripts/plan-policy.mjs', 'scripts/plan-envelope.mjs']);
const DIGEST = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const MAX_PLAN = 64 * 1024 * 1024;
const MAX_JSON = 32 * 1024 * 1024;
const extraJobs = Object.freeze({ 'package-deploy': 'Package and deploy workshop app', 'verify-deployed': 'Verify deployed workshop', followup: 'Confirm no-change', 'verify-absence': 'Verify workload absence' });

function readRegular(file, maximum) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum, 'Missing, linked or oversized reviewed file');
  return fs.readFileSync(file);
}

// For separately reviewed OWNER onboarding, never a learner-derived trust pin.
// Workflows independently check this protected map BEFORE importing repo code.
export function controlDigests({ root = ROOT } = {}) {
  return Object.fromEntries([...CONTROL_FILES].sort(compare).map(file => [file, hash(readRegular(path.join(root, file), 4 * 1024 * 1024))]));
}

function rootFiles(root) {
  const directory = path.join(root, 'infra');
  assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'Reviewed infrastructure root must be an ordinary directory');
  const files = fs.readdirSync(directory).filter(name => /\.tf(?:\.json)?$/.test(name)).sort(compare);
  assert.ok(files.length > 0 && files.length <= 64, 'Invalid reviewed root HCL inventory');
  for (const name of fs.readdirSync(directory)) assert.ok(!/(?:\.tfvars(?:\.json)?|\.tfstate(?:\..*)?|\.tfplan)$/i.test(name), 'Unreviewed root variables/state/plan file');
  return files.map(name => ({ name, bytes: readRegular(path.join(directory, name), 1024 * 1024) }));
}

// Owner infraSha256 algorithm: SHA256(canonicalJson({<root basename>:
// SHA256(original bytes), ...})). Include EVERY direct .tf/.tf.json, sorted by
// name. Locks/workflows/ZIP use their original bytes; JSON uses canonicalJson.
export function infraDigest(files) {
  return hash(canonicalJson(Object.fromEntries([...files].sort((a, b) => compare(a.name, b.name)).map(file => [file.name, hash(file.bytes)]))));
}

export function prepare({ root = ROOT, env = process.env } = {}) {
  root = path.resolve(root);
  assert.ok(typeof env.WORKSHOP_OWNER_PROFILE_JSON === 'string' && DIGEST.test(env.WORKSHOP_OWNER_PROFILE_SHA256 ?? ''), 'Configure the separately owner-protected profile pin');
  const profile = parseStrictJson(Buffer.from(env.WORKSHOP_OWNER_PROFILE_JSON));
  assert.equal(hash(canonicalJson(profile)), env.WORKSHOP_OWNER_PROFILE_SHA256, 'Owner profile is not bound to its protected variable');
  assert.equal(canonicalJson(profile.environments), canonicalJson(ENVIRONMENTS), 'Onboarding must explicitly pin workshop-plan/workshop-apply; existing environments are not silently migrated');
  authorization.assertOidcSubjects(profile.oidcSubjects);
  const participant = parseStrictJson(readRegular(path.join(root, 'exercise/participant.json'), 16 * 1024));
  validateParticipant(participant, profile.assignment?.participant_name);
  const files = rootFiles(root);
  const packed = buildPackage({ root });
  const deliveryWorkflow = readRegular(path.join(root, '.github/workflows/delivery.yml'), 256 * 1024);
  const cleanupWorkflow = readRegular(path.join(root, '.github/workflows/cleanup.yml'), 256 * 1024);
  assert.equal(hash(deliveryWorkflow), profile.deliveryWorkflowSha256, 'Delivery workflow bytes differ from the owner pin');
  assert.equal(hash(cleanupWorkflow), profile.cleanupWorkflowSha256, 'Cleanup workflow bytes differ from the owner pin');
  const cleanup = env.GITHUB_WORKFLOW_REF?.endsWith('/cleanup.yml@refs/heads/main');
  const computed = { WORKSHOP_PARTICIPANT_JSON: canonicalJson(participant), WORKSHOP_PARTICIPANT_SHA256: hash(canonicalJson(participant)),
    WORKSHOP_ASSIGNMENT_SHA256: hash(canonicalJson(profile.assignment)), WORKSHOP_PROVIDER_LOCK_SHA256: hash(readRegular(path.join(root, 'infra/.terraform.lock.hcl'), 1024 * 1024)),
    WORKSHOP_APP_SHA256: packed.sha256, WORKSHOP_INFRA_SHA256: infraDigest(files), WORKSHOP_WORKFLOW_SHA256: hash(cleanup ? cleanupWorkflow : deliveryWorkflow) };
  for (const [variable, field] of [['WORKSHOP_ASSIGNMENT_SHA256', 'assignmentSha256'], ['WORKSHOP_PROVIDER_LOCK_SHA256', 'providerLockSha256'], ['WORKSHOP_APP_SHA256', 'appSha256'], ['WORKSHOP_INFRA_SHA256', 'infraSha256']])
    assert.equal(computed[variable], profile[field], 'Actual reviewed bytes differ from the protected owner profile');
  // Never replace WORKSHOP_OWNER_PROFILE_SHA256 with a learner-computed value.
  return { root, profile, packed, files, env: { ...env, ...computed } };
}

// expectedSubject must be the exact validated profile.oidcSubjects[phase], whose
// whole profile digest is already bound into the admitted/saved-plan binding.
// It has no repository-name default and no separately configurable env slot.
export function validateGitHubJWT(jwt, { binding, environment, expectedSubject, now = Date.now() }) {
  validateBinding(binding);
  authorization.assertOidcSubject(expectedSubject, environment);
  assert.ok(typeof jwt === 'string' && jwt.length < 32 * 1024, 'Invalid GitHub OIDC token');
  const parts = jwt.split('.');
  assert.ok(parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)), 'Malformed GitHub OIDC token');
  const decode = part => {
    const bytes = Buffer.from(part, 'base64url');
    assert.equal(bytes.toString('base64url'), part, 'Noncanonical GitHub JWT encoding');
    return parseStrictJson(bytes, 24 * 1024);
  };
  const header = decode(parts[0]);
  const claims = decode(parts[1]);
  assert.ok(header.alg === 'RS256' && typeof header.kid === 'string' && !header.jku && !header.x5u, 'Unreviewed GitHub signing header');
  // The token is obtained ONLY from GitHub's authenticated HTTPS OIDC endpoint,
  // not accepted from a file/CLI/env token slot. Entra validates its signature.
  const expected = { iss: 'https://token.actions.githubusercontent.com', aud: 'api://AzureADTokenExchange', repository: binding.repository,
    repository_id: binding.repositoryId, repository_visibility: 'private', ref: 'refs/heads/main', sha: binding.sha,
    run_id: binding.runId, run_attempt: '1', workflow_ref: binding.workflowRef, workflow_sha: binding.sha,
    environment, sub: expectedSubject };
  for (const [key, value] of Object.entries(expected)) assert.equal(claims[key], value, 'GitHub JWT scope/run/environment claim mismatch');
  assert.ok(['push', 'workflow_dispatch'].includes(claims.event_name) && claims.event_name === (binding.operation === 'deploy' ? 'push' : 'workflow_dispatch'), 'OIDC event route mismatch');
  assert.ok(Number.isInteger(claims.exp) && Number.isInteger(claims.iat) && Number.isInteger(claims.nbf) &&
    claims.iat * 1000 <= now + 30_000 && claims.nbf * 1000 <= now + 30_000 && claims.exp * 1000 > now + 30_000 &&
    claims.exp - claims.iat <= 600 && now - claims.iat * 1000 < 600_000, 'GitHub OIDC token is stale/future-dated');
  return jwt;
}

export async function getGitHubJWT({ env, binding, environment, expectedSubject, fetchImpl = globalThis.fetch, now = Date.now() }) {
  validateBinding(binding);
  authorization.assertOidcSubject(expectedSubject, environment);
  assert.ok(typeof env.ACTIONS_ID_TOKEN_REQUEST_URL === 'string' && typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === 'string' && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 0, 'Trusted Actions OIDC runtime is required');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.ok(url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash &&
    /^pipelines[a-z0-9-]*\.actions\.githubusercontent\.com$/.test(url.hostname) &&
    url.pathname.includes('/_apis/distributedtask/') && /\/idtoken$/i.test(url.pathname), 'Untrusted Actions OIDC request endpoint');
  url.searchParams.set('audience', 'api://AzureADTokenExchange');
  let response;
  try { response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, accept: 'application/json' } }); }
  catch { throw new Error('GitHub OIDC request failed without credential fallback'); }
  assert.equal(response.status, 200, 'GitHub did not issue an OIDC assertion');
  const body = parseStrictJson(await boundedBytes(response, 64 * 1024), 64 * 1024);
  return validateGitHubJWT(body.value, { binding, environment, expectedSubject, now });
}

export function terraformEnvironment({ env, binding, clientId, token, directory }) {
  validateBinding(binding);
  assert.ok([binding.planClientId, binding.applyClientId].includes(clientId), 'Unbound Terraform identity');
  assert.ok(typeof token === 'string' && token.length > 0, 'An already-validated OIDC assertion is required');
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const executablePath = pathKey ? env[pathKey] : process.env.PATH;
  assert.ok(typeof executablePath === 'string' && executablePath.length > 0, 'Trusted runner tool path is missing');
  return { PATH: executablePath, ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}), ...(env.WINDIR ? { WINDIR: env.WINDIR } : {}),
    HOME: directory, USERPROFILE: directory, TMPDIR: directory, TEMP: directory, TMP: directory,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TF_IN_AUTOMATION: 'true', TF_INPUT: '0', CHECKPOINT_DISABLE: '1',
    TF_DATA_DIR: path.join(directory, '.terraform'), TF_CLI_CONFIG_FILE: path.join(directory, 'terraform.rc'),
    ARM_SUBSCRIPTION_ID: binding.subscriptionId, ARM_TENANT_ID: binding.tenant, ARM_CLIENT_ID: clientId,
    ARM_USE_OIDC: 'true', ARM_USE_AZUREAD: 'true', ARM_USE_CLI: 'false', ARM_USE_MSI: 'false',
    ARM_SKIP_PROVIDER_REGISTRATION: 'true', ARM_RESOURCE_PROVIDER_REGISTRATIONS: 'none', ARM_OIDC_TOKEN: token };
}

export function initArguments(binding) {
  validateBinding(binding);
  const backend = binding.backend;
  return ['init', '-input=false', '-lockfile=readonly', '-no-color', '-lock-timeout=60s',
    `-backend-config=subscription_id=${backend.subscriptionId}`, `-backend-config=tenant_id=${binding.tenant}`,
    `-backend-config=resource_group_name=${backend.resourceGroupName}`, `-backend-config=storage_account_name=${backend.storageAccountName}`,
    `-backend-config=container_name=${backend.containerName}`, `-backend-config=key=${backend.key}`,
    '-backend-config=use_oidc=true', '-backend-config=use_azuread_auth=true', '-backend-config=use_cli=false'];
  // client_id/token are intentionally NOT serialized into saved backend config:
  // the fresh phase-specific ARM_CLIENT_ID/ARM_OIDC_TOKEN authenticate each job.
}

export function planArguments(binding, planFile) {
  assert.ok(path.isAbsolute(planFile), 'Saved-plan path must be absolute');
  return ['plan', '-input=false', '-lock=true', '-lock-timeout=60s', '-no-color', '-detailed-exitcode',
    ...(binding.operation === 'destroy' ? ['-destroy'] : []), `-out=${planFile}`];
}

export function terraformRunner({ directory, env, spawn = spawnSync, executable = 'terraform' }) {
  return async (args, allowed = [0]) => {
    assert.ok(Array.isArray(args) && args.every(arg => typeof arg === 'string' && !arg.includes('\0')), 'Invalid native Terraform arguments');
    let result;
    try { result = await spawn(executable, args, { cwd: directory, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 1_500_000, maxBuffer: MAX_JSON + 1024 * 1024 }); }
    catch { throw new Error('Native Terraform invocation failed; output is not logged'); }
    assert.ok(result && !result.error && !result.signal && allowed.includes(result.status), 'Native Terraform failed/timed out; sensitive stdout/stderr are not logged');
    assert.ok(Buffer.byteLength(result.stdout ?? '') <= MAX_JSON && Buffer.byteLength(result.stderr ?? '') <= MAX_JSON, 'Native Terraform output exceeds its limit');
    return { exitCode: result.status, stdout: result.stdout ?? '' };
  };
}

function workArea(root) {
  let directory = root;
  for (const segment of ['.work', 'delivery']) {
    directory = path.join(directory, segment);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe delivery work directory');
  }
  return directory;
}

function scrub(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { fs.unlinkSync(file); continue; }
    if (entry.isDirectory()) scrub(file);
    else {
      // Best-effort plaintext overwrite, then unlink. This is not an SSD/backup
      // erasure guarantee; trusted runners must be isolated and ephemeral.
      if (/\.(?:tfplan|tfstate(?:\..*)?|tfvars\.json)$/.test(entry.name)) {
        const descriptor = fs.openSync(file, 'r+');
        try {
          const block = Buffer.alloc(64 * 1024);
          const size = fs.fstatSync(descriptor).size;
          for (let offset = 0; offset < size; offset += block.length) fs.writeSync(descriptor, block, 0, Math.min(block.length, size - offset), offset);
          fs.fsyncSync(descriptor);
        } finally { fs.closeSync(descriptor); }
      }
      fs.unlinkSync(file);
    }
  }
  fs.rmdirSync(directory);
}

function sessionPrefix(env) {
  for (const name of ['GITHUB_REPOSITORY_ID', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[name] ?? '', /^[1-9][0-9]{0,15}$/, 'Missing cleanup runtime identity');
  return `ws2-${env.GITHUB_REPOSITORY_ID}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-`;
}

export function clean({ root = ROOT, env = process.env } = {}) {
  const area = path.join(root, '.work', 'delivery');
  if (!fs.existsSync(area)) return { result: 'clean' };
  assert.ok(!fs.lstatSync(path.join(root, '.work')).isSymbolicLink() && !fs.lstatSync(area).isSymbolicLink(), 'Unsafe cleanup directory');
  const marker = path.join(area, 'session.json');
  if (fs.existsSync(marker)) {
    const session = parseStrictJson(readRegular(marker, 8192));
    const base = path.resolve(env.RUNNER_TEMP || os.tmpdir());
    assert.ok(session.runId === env.GITHUB_RUN_ID && session.sha === env.GITHUB_SHA && path.dirname(session.directory) === base &&
      path.basename(session.directory).startsWith(sessionPrefix(env)) && /^[A-Za-z0-9-]+$/.test(path.basename(session.directory)), 'Refusing to delete an unbound session directory');
    if (fs.existsSync(session.directory)) { assert.ok(!fs.lstatSync(session.directory).isSymbolicLink(), 'Unsafe session cleanup'); scrub(session.directory); }
  }
  scrub(area);
  return { result: 'clean' };
}

async function withTerraform(runtime, callback) {
  const { prepared, binding, env, phase, deps, guard } = runtime;
  await guard();
  const area = workArea(prepared.root);
  const marker = path.join(area, 'session.json');
  assert.ok(!fs.existsSync(marker), 'An earlier session must be reconciled/cleaned first');
  const base = path.resolve(env.RUNNER_TEMP || os.tmpdir());
  assert.ok(fs.lstatSync(base).isDirectory() && !fs.lstatSync(base).isSymbolicLink(), 'Trusted temporary directory is unavailable');
  const directory = fs.mkdtempSync(path.join(base, sessionPrefix(env)));
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(marker, canonicalJson({ directory, runId: binding.runId, sha: binding.sha }), { mode: 0o600, flag: 'wx' });
  let childEnv;
  try {
    assert.equal(infraDigest(prepared.files), binding.infraSha256);
    for (const file of prepared.files) fs.writeFileSync(path.join(directory, file.name), file.bytes, { mode: 0o600, flag: 'wx' });
    const lock = readRegular(path.join(prepared.root, 'infra/.terraform.lock.hcl'), 1024 * 1024);
    assert.equal(hash(lock), binding.providerLockSha256);
    fs.writeFileSync(path.join(directory, '.terraform.lock.hcl'), lock, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'approved.auto.tfvars.json'), canonicalJson(terraformVariables(binding.participant, binding.assignment)), { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(directory, 'terraform.rc'), 'disable_checkpoint = true\n', { mode: 0o600, flag: 'wx' });
    const token = await getGitHubJWT({ env, binding, environment: ENVIRONMENTS[phase],
      expectedSubject: prepared.profile.oidcSubjects[phase], fetchImpl: deps.fetchImpl });
    childEnv = terraformEnvironment({ env, binding, clientId: phase === 'apply' ? binding.applyClientId : binding.planClientId, token, directory });
    const tf = terraformRunner({ directory, env: childEnv, spawn: deps.spawn, executable: deps.executable });
    const version = parseStrictJson(Buffer.from((await tf(['version', '-json'])).stdout), MAX_JSON);
    assert.equal(version.terraform_version, binding.terraformVersion, 'Terraform executable differs from the reviewed version');
    await tf(initArguments(binding));
    assert.equal(hash(fs.readFileSync(path.join(directory, '.terraform.lock.hcl'))), binding.providerLockSha256, 'Native init changed the provider lock');
    return await callback({ directory, tf });
  } finally {
    if (childEnv) delete childEnv.ARM_OIDC_TOKEN;
    try { scrub(directory); } finally { if (fs.existsSync(marker)) fs.unlinkSync(marker); }
  }
}

async function validated(tf) {
  const result = parseStrictJson(Buffer.from((await tf(['validate', '-json', '-no-color'])).stdout), MAX_JSON);
  assert.ok(result.valid === true && result.error_count === 0, 'Real Terraform validation failed');
}

const planOptions = binding => ({ subscriptionId: binding.subscriptionId, participant: binding.participant, assignment: binding.assignment, operation: binding.operation });
const artifactName = binding => `ws2-plan-${binding.repositoryId}-${binding.runId}-${binding.runAttempt}-${binding.operation}`;

async function credentialFor(runtime) {
  await runtime.guard();
  if (runtime.deps.credentialFactory) return runtime.deps.credentialFactory(runtime.binding);
  assert.ok(!runtime.env.AZURE_LOG_LEVEL, 'Azure SDK diagnostic logging must be disabled in privileged jobs');
  // Resolve the installed application SDK, NOT an undeclared root dependency.
  // This is reached only after authorization; no DefaultAzureCredential fallback.
  const requireApp = createRequire(path.join(runtime.prepared.root, 'app/package.json'));
  const { ClientAssertionCredential } = requireApp('@azure/identity');
  const client = runtime.phase === 'apply' ? runtime.binding.applyClientId : runtime.binding.planClientId;
  return new ClientAssertionCredential(runtime.binding.tenant, client, async () => {
    await runtime.guard();
    return getGitHubJWT({ env: runtime.env, binding: runtime.binding, environment: ENVIRONMENTS[runtime.phase],
      expectedSubject: runtime.prepared.profile.oidcSubjects[runtime.phase], fetchImpl: runtime.deps.fetchImpl });
  }, { authorityHost: 'https://login.microsoftonline.com', disableInstanceDiscovery: true });
}

async function armFor(runtime) {
  return createArmClient({ binding: runtime.binding, credential: await credentialFor(runtime), fetchImpl: runtime.deps.fetchImpl });
}

async function stateJson(tf) { return parseStrictJson(Buffer.from((await tf(['show', '-json', '-no-color'])).stdout), MAX_JSON); }

async function plan(runtime) {
  return withTerraform(runtime, async ({ directory, tf }) => {
    await validated(tf);
    // Validate saved state identities BEFORE a provider refresh can traverse
    // them. A fresh backend never authorizes adopting an already existing RG.
    const state = await stateJson(tf);
    const managed = managedState(state, runtime.binding, { allowEmpty: runtime.binding.operation === 'deploy' });
    if (runtime.binding.operation === 'destroy') await cleanupInventory({ arm: await armFor(runtime), binding: runtime.binding, state });
    else if (runtime.binding.operation === 'deploy' && managed.count === 0) {
      const arm = await armFor(runtime);
      assert.equal(await arm.get(resourceIds(runtime.binding).group, API.group, { allow404: true }), null, 'An existing RG cannot be adopted by a fresh workload state');
    }
    await runtime.guard();
    const file = path.join(directory, 'saved.tfplan');
    const execution = await tf(planArguments(runtime.binding, file), [0, 2]);
    const bytes = readRegular(file, MAX_PLAN);
    let manifestBytes;
    try {
      const json = parseStrictJson(Buffer.from((await tf(['show', '-json', '-no-color', file])).stdout), MAX_JSON);
      const summary = summarizePlan(json, planOptions(runtime.binding));
      if (runtime.binding.operation === 'followup') {
        assert.equal(execution.exitCode, 0, 'Followup detected changes');
        return { result: 'no-change', exitcode: '0', summary };
      }
      const manifest = makeManifest(runtime.binding, bytes, { exitCode: execution.exitCode });
      manifestBytes = Buffer.from(canonicalJson(manifest));
      assert.ok(runtime.env.PLAN_ENCRYPTION_PUBLIC_KEY, 'Owner-managed plan encryption public key is missing');
      const envelope = sealPlan(bytes, manifestBytes, runtime.env.PLAN_ENCRYPTION_PUBLIC_KEY);
      const area = workArea(runtime.prepared.root);
      const sealed = path.join(area, 'sealed');
      fs.mkdirSync(sealed, { mode: 0o700 });
      fs.writeFileSync(path.join(sealed, 'plan.enc'), envelope, { mode: 0o600, flag: 'wx' });
      return { result: 'planned', exitcode: String(execution.exitCode), artifact: artifactName(runtime.binding),
        plan_sha256: hash(bytes), manifest_sha256: hash(manifestBytes), envelope_sha256: hash(envelope), summary };
    } finally { bytes.fill(0); manifestBytes?.fill(0); }
  });
}

async function sameRunArtifact(runtime) {
  const expected = artifactName(runtime.binding);
  assert.equal(runtime.env.EXPECTED_ARTIFACT, expected, 'Artifact name is not bound to this run/attempt/operation');
  const artifacts = await runtime.github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', { ...runtime.context.repo, run_id: runtime.context.runId, per_page: 100 });
  const matches = artifacts.filter(item => item.name === expected);
  assert.ok(matches.length === 1 && Number.isSafeInteger(matches[0].id) && matches[0].expired === false, 'Require one unexpired exact same-run artifact');
  const source = matches[0].workflow_run;
  assert.ok(source?.id === runtime.context.runId && source.repository_id === Number(runtime.binding.repositoryId) &&
    source.head_repository_id === Number(runtime.binding.repositoryId) && source.head_sha === runtime.binding.sha && source.head_branch === 'main', 'Artifact provenance differs from the admitted run');
}

async function apply(runtime) {
  assert.ok(['deploy', 'destroy'].includes(runtime.binding.operation), 'Read-only operations never apply');
  for (const variable of ['EXPECTED_PLAN_HASH', 'EXPECTED_MANIFEST_HASH', 'EXPECTED_ENVELOPE_HASH']) assert.match(runtime.env[variable] ?? '', DIGEST, 'Missing trusted same-run artifact digest');
  await sameRunArtifact(runtime);
  return withTerraform(runtime, async ({ directory, tf }) => {
    const sealed = path.join(runtime.prepared.root, '.work/delivery/sealed');
    assert.ok(!fs.lstatSync(sealed).isSymbolicLink(), 'Unsafe encrypted artifact directory');
    assert.deepEqual(fs.readdirSync(sealed), ['plan.enc'], 'Artifact contains unapproved files');
    const ciphertext = readRegular(path.join(sealed, 'plan.enc'), MAX_PLAN + 256 * 1024);
    assert.equal(hash(ciphertext), runtime.env.EXPECTED_ENVELOPE_HASH, 'Encrypted artifact was altered');
    await runtime.guard();
    assert.ok(runtime.env.PLAN_DECRYPTION_PRIVATE_KEY, 'Apply-environment decryption key is missing');
    const opened = openPlan(ciphertext, runtime.env.PLAN_DECRYPTION_PRIVATE_KEY);
    try {
      const file = path.join(directory, 'saved.tfplan');
      fs.writeFileSync(file, opened.plan, { mode: 0o600, flag: 'wx' });
      const json = parseStrictJson(Buffer.from((await tf(['show', '-json', '-no-color', file])).stdout), MAX_JSON);
      summarizePlan(json, planOptions(runtime.binding));
      if (runtime.binding.operation === 'destroy') await cleanupInventory({ arm: await armFor(runtime), binding: runtime.binding, state: await stateJson(tf) });
      // Re-read ALL GitHub admission metadata after init/inventory, then check
      // both authenticated plaintext digests, entire binding and age. No replan.
      const admitted = await runtime.guard();
      verifyPlan({ manifest: opened.manifest, manifestBytes: opened.manifestBytes, planBytes: opened.plan, binding: runtime.binding,
        expectedPlanHash: runtime.env.EXPECTED_PLAN_HASH, expectedManifestHash: runtime.env.EXPECTED_MANIFEST_HASH, currentSha: admitted.mainSha });
      assert.equal(hash(readRegular(file, MAX_PLAN)), runtime.env.EXPECTED_PLAN_HASH, 'Saved binary changed immediately before apply');
      await tf(['apply', '-input=false', '-lock=true', '-lock-timeout=60s', '-no-color', file]);
      return { result: runtime.binding.operation === 'destroy' ? 'destroyed' : 'applied' };
    } finally { opened.plan.fill(0); opened.manifestBytes.fill(0); ciphertext.fill(0); }
  });
}

async function scmClient(runtime, target) {
  const credential = await credentialFor(runtime);
  const origin = `https://${target.scmHostName}`;
  return async (route, { method = 'GET', body } = {}) => {
    const url = new URL(route, origin);
    assert.ok(url.origin === origin && !url.username && !url.password && !url.hash && !/[\\%]/.test(url.pathname), 'SCM request escaped the ARM-attested app');
    assert.ok((method === 'POST' && url.pathname === '/api/zipdeploy' && body === runtime.prepared.packed.bytes) ||
      (method === 'GET' && (/^\/api\/deployments(?:\/(?:latest|[A-Za-z0-9_-]+))?$/.test(url.pathname) ||
        /^\/api\/vfs\/data\/SitePackages\/[A-Za-z0-9_.-]+$/.test(url.pathname))), 'Unreviewed SCM operation');
    const token = await credential.getToken(`${ARM_ORIGIN}/.default`);
    assert.ok(token?.token && token.expiresOnTimestamp > Date.now() + 30_000, 'SCM bearer credential is not ready');
    let response;
    try { response = await runtime.deps.fetchImpl(url.href, { method, redirect: 'error', signal: AbortSignal.timeout(method === 'POST' ? 120_000 : 30_000),
      headers: { authorization: `Bearer ${token.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/zip' } : {}) }, ...(body ? { body } : {}) }); }
    catch { throw new Error('SCM request failed; do not retry an ambiguous upload or enable publish-profile/basic authentication'); }
    assert.ok([200, 202].includes(response.status), 'Assigned SCM network/OIDC publishing permission is not ready');
    return response;
  };
}

async function remotePackageHash(scm) {
  const pointer = await scm('/api/vfs/data/SitePackages/packagename.txt');
  const filename = (await boundedBytes(pointer, 1024)).toString('utf8').trim();
  assert.match(filename, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}\.zip$/, 'SCM package pointer is not a safe exact ZIP name');
  const response = await scm(`/api/vfs/data/SitePackages/${filename}`);
  return hash(await boundedBytes(response, MAX_PACKAGE_BYTES));
}

async function packageDeploy(runtime) {
  assert.equal(runtime.binding.operation, 'deploy');
  const target = validateReadback(await readSnapshot({ arm: await armFor(runtime), binding: runtime.binding }), runtime.binding);
  const scm = await scmClient(runtime, target);
  // A read against the actual SCM endpoint must work BEFORE attempting upload.
  const readiness = await scm('/api/deployments');
  await readiness.body?.cancel();
  await runtime.guard();
  assert.equal(hash(runtime.prepared.packed.bytes), runtime.binding.appSha256, 'Package bytes changed after authorization');
  const started = Date.now();
  const response = await scm('/api/zipdeploy?isAsync=true', { method: 'POST', body: runtime.prepared.packed.bytes });
  const location = response.headers.get('location');
  await response.body?.cancel();
  assert.ok(location, 'SCM did not return an asynchronous deployment location');
  let statusRoute = new URL(location, `https://${target.scmHostName}`).href;
  let complete = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = parseStrictJson(await boundedBytes(await scm(statusRoute), 64 * 1024), 64 * 1024);
    const received = Date.parse(status.received_time ?? status.start_time);
    if (Number.isFinite(received) && received >= started - 10_000) {
      assert.match(status.id ?? '', /^[A-Za-z0-9_-]+$/, 'SCM deployment identity is missing');
      statusRoute = `/api/deployments/${status.id}`;
      assert.notEqual(status.status, 3, 'SCM reported an actual deployment failure');
      if (status.status === 4 && status.complete === true && status.active === true) { complete = true; break; }
    }
    if (attempt + 1 < 30) await runtime.deps.sleep(Math.min(1_000 * 2 ** attempt, 15_000));
  }
  assert.ok(complete, 'SCM deployment remains pending after its bounded deadline');
  assert.equal(await remotePackageHash(scm), runtime.binding.appSha256, 'The mounted deployment ZIP differs from the authorized package');
  await verifyHealth({ target, fetchImpl: runtime.deps.fetchImpl, sleep: runtime.deps.sleep });
  return { result: 'deployed', package_sha256: runtime.binding.appSha256, app_url: target.url };
}

async function verifyDeployed(runtime) {
  assert.equal(runtime.binding.operation, 'deploy');
  const target = validateReadback(await readSnapshot({ arm: await armFor(runtime), binding: runtime.binding }), runtime.binding);
  assert.equal(await remotePackageHash(await scmClient(runtime, target)), runtime.binding.appSha256, 'Mounted ZIP does not match the reviewed bytes');
  await verifyHealth({ target, fetchImpl: runtime.deps.fetchImpl, sleep: runtime.deps.sleep });
  return { result: 'deployed', app_url: target.url, package_sha256: runtime.binding.appSha256 };
}

async function checkExtraJob(runtime) {
  const name = extraJobs[runtime.mode];
  if (!name) return;
  const { github, context, binding } = runtime;
  assert.ok(String(context.runId) === binding.runId && binding.runAttempt === '1' && context.sha === binding.sha &&
    `${context.repo?.owner}/${context.repo?.repo}` === binding.repository, 'Lifecycle metadata must use the admitted repository/run/revision');
  const parameters = { ...context.repo, run_id: context.runId };
  const verifyRun = async () => {
    const run = (await github.rest.actions.getWorkflowRun(parameters)).data;
    assert.ok(run?.id === context.runId && run.run_attempt === 1 && run.head_sha === binding.sha && run.head_branch === 'main' &&
      run.event === context.eventName && run.status === 'in_progress' && run.conclusion === null &&
      run.repository?.id === Number(binding.repositoryId) && run.repository?.full_name === binding.repository &&
      run.head_repository?.id === Number(binding.repositoryId) && run.head_repository?.full_name === binding.repository &&
      run.path === `.github/workflows/${binding.operation === 'destroy' ? 'cleanup.yml' : 'delivery.yml'}`,
    'Lifecycle workflow run is stale, rerun or differs from the admitted run');
  };
  // Bracket the exact attempt-specific collection with live same-run checks.
  // Its jobs DTO may omit run_attempt; a populated contradiction never passes.
  await verifyRun();
  const jobs = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
    { ...parameters, attempt_number: 1, per_page: 100 });
  assert.ok(Array.isArray(jobs) && jobs.every(job => job !== null && typeof job === 'object' && !Array.isArray(job) &&
    (job.run_attempt === 1 || !Object.hasOwn(job, 'run_attempt'))), 'Lifecycle jobs contradict the verified first run attempt');
  const required = ['Verify scoped workshop policy', 'Validate reviewed workshop revision', 'Create encrypted workshop plan'];
  if (['package-deploy', 'verify-deployed', 'verify-absence'].includes(runtime.mode)) required.push('Apply exact workshop plan');
  if (runtime.mode === 'verify-deployed') required.push('Package and deploy workshop app');
  for (const prerequisite of [...required, name]) {
    const matches = jobs.filter(job => job.name === prerequisite);
    assert.ok(matches.length === 1 && matches[0].run_id === context.runId && matches[0].head_sha === binding.sha,
      'Unique exact same-run lifecycle job provenance is required');
    assert.ok(prerequisite === name ? matches[0].status === 'in_progress' && matches[0].conclusion === null :
      matches[0].status === 'completed' && matches[0].conclusion === 'success', 'A lifecycle prerequisite is skipped/failed/stale');
  }
  await verifyRun();
}

async function waitChecks(prepared, { github, context, sleep }) {
  const required = prepared.profile.requiredChecks;
  assert.ok(Array.isArray(required) && required.length > 0 && required.length <= 16, 'Owner-pinned check contexts are required');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const checks = await github.paginate(github.rest.checks.listForRef, { ...context.repo, ref: context.sha, filter: 'latest', per_page: 100 });
    const matches = required.map(name => checks.filter(check => check.name === name && check.app?.id === 15368 && check.head_sha === context.sha));
    assert.ok(matches.every(items => items.length <= 1), 'Required check provenance is ambiguous');
    assert.ok(matches.every(items => !items[0] || items[0].status !== 'completed' || items[0].conclusion === 'success'), 'A required exact-revision check failed');
    if (matches.every(items => items.length === 1 && items[0].status === 'completed' && items[0].conclusion === 'success')) return;
    if (attempt + 1 < 30) await sleep(10_000);
  }
  throw new Error('Required exact-revision checks did not finish in the bounded admission window');
}

// github-script supplies real github/context/core. authorize is the EXISTING
// security helper, explicitly passed by each workflow. Tests inject only local
// synthetic adapters; the CLI always selects the real helper and HTTPS adapter.
export async function workflowMain(mode, { github, context, core, authorize = authorization.authorize, root = ROOT, env = process.env, deps = {} }) {
  try {
    assert.ok(MODES.includes(mode), 'Unknown explicit delivery mode');
    if (mode === 'clean') return clean({ root, env });
    const dependencies = { fetchImpl: globalThis.fetch, sleep: sleepDefault, ...deps };
    const prepared = prepare({ root, env });
    env = prepared.env;
    const phase = mode === 'apply' ? 'apply' : ['plan', 'cleanup-inventory'].includes(mode) ? 'plan' : 'preflight';
    if (['preflight', 'verify'].includes(mode)) await waitChecks(prepared, { github, context, sleep: dependencies.sleep });
    const admitted = await authorize({ github, context, core, phase, env });
    const binding = validateBinding(admitted.binding);
    assert.equal(binding.ownerProfileSha256, env.WORKSHOP_OWNER_PROFILE_SHA256, 'Admission differs from the prepared owner-profile subject pin');
    const identityPhase = ['apply', 'package-deploy', 'verify-deployed'].includes(mode) ? 'apply' : 'plan';
    if (!['preflight', 'verify'].includes(mode)) assert.equal(env.ARM_CLIENT_ID, identityPhase === 'apply' ? binding.applyClientId : binding.planClientId, 'Wrong lifecycle OIDC identity');
    if (['cleanup-inventory', 'verify-absence'].includes(mode)) assert.equal(binding.operation, 'destroy');
    if (mode === 'followup') assert.equal(binding.operation, 'followup');
    const runtime = { prepared, env, binding, mode, github, context, core, phase: identityPhase, deps: dependencies };
    runtime.guard = async () => {
      const fresh = prepare({ root, env });
      const next = await authorize({ github, context, core, phase, env: fresh.env });
      assert.equal(canonicalJson(next.binding), canonicalJson(binding), 'Admission binding changed at a privilege boundary');
      await checkExtraJob(runtime);
      return next;
    };
    await checkExtraJob(runtime);
    let result;
    if (['preflight', 'verify'].includes(mode)) result = { result: 'admitted' };
    else if (['plan', 'followup'].includes(mode)) result = await plan(runtime);
    else if (mode === 'apply') result = await apply(runtime);
    else if (mode === 'package-deploy') result = await packageDeploy(runtime);
    else if (mode === 'verify-deployed') result = await verifyDeployed(runtime);
    else result = await withTerraform(runtime, async ({ tf }) => {
      const options = { arm: await armFor(runtime), binding, state: await stateJson(tf) };
      if (mode === 'cleanup-inventory') { await cleanupInventory(options); return { result: 'owned' }; }
      await verifyAbsence(options); return { result: 'absent' };
    });
    // Extra phases must still be the same active first-attempt job after their
    // work completes; never publish success from stale lifecycle admission.
    if (extraJobs[mode]) await runtime.guard();
    const output = { ...result, owner_profile_sha256: binding.ownerProfileSha256, participant_sha256: binding.participantSha256, operation: binding.operation };
    // Result markers are emitted ONLY after the real action completes. No raw
    // plan/state, Azure bodies, tokens, private keys or participant JSON in logs.
    for (const [key, value] of Object.entries(output)) if (typeof value === 'string') core.setOutput(key, value);
    if (core.summary && result.summary) { core.summary.addHeading('Scoped Terraform counts').addCodeBlock(JSON.stringify(result.summary.totals), 'json'); await core.summary.write(); }
    return output;
  } catch {
    // SDK/Terraform/assertion errors may contain sensitive response/plan data.
    // Do not hand those objects to github-script's default error formatter.
    throw new Error('Workshop delivery failed closed: owner bindings, trusted metadata, locked Terraform, inventory, network or real runtime verification did not pass. No fallback or success marker was issued.');
  }
}

export function githubAdapter({ token, fetchImpl = globalThis.fetch }) {
  assert.ok(typeof token === 'string' && token.length > 0, 'Read-only GitHub Actions token is required');
  async function request(route, parameters = {}) {
    assert.ok(route.startsWith('GET /repos/{owner}/{repo}/') || route === 'GET /repos/{owner}/{repo}', 'Only repository-scoped GitHub GETs are supported');
    const used = new Set();
    const pathname = route.slice(4).replace(/\{([^}]+)\}/g, (_match, key) => { used.add(key); assert.ok(parameters[key] !== undefined, 'Missing GitHub route parameter'); return encodeURIComponent(String(parameters[key])); });
    const url = new URL(pathname, 'https://api.github.com');
    for (const [key, value] of Object.entries(parameters)) if (!used.has(key)) url.searchParams.set(key, String(value));
    let response;
    try { response = await fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ws2-scoped-delivery' } }); }
    catch { throw new Error('Scoped GitHub metadata read failed'); }
    assert.equal(response.status, 200, 'Scoped GitHub metadata read was denied');
    return { data: parseStrictJson(await boundedBytes(response, 8 * 1024 * 1024), 8 * 1024 * 1024) };
  }
  const endpoint = route => parameters => request(route, parameters);
  return { request, rest: {
    repos: { get: endpoint('GET /repos/{owner}/{repo}'), getBranch: endpoint('GET /repos/{owner}/{repo}/branches/{branch}'),
      getCollaboratorPermissionLevel: endpoint('GET /repos/{owner}/{repo}/collaborators/{username}/permission'),
      getEnvironment: endpoint('GET /repos/{owner}/{repo}/environments/{environment_name}'),
      listDeploymentBranchPolicies: endpoint('GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies'),
      listPullRequestsAssociatedWithCommit: endpoint('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls') },
    actions: { getWorkflowRun: endpoint('GET /repos/{owner}/{repo}/actions/runs/{run_id}') },
    checks: { listForRef: endpoint('GET /repos/{owner}/{repo}/commits/{ref}/check-runs') }, pulls: { get: endpoint('GET /repos/{owner}/{repo}/pulls/{pull_number}') },
  }, async paginate(route, parameters) {
    const result = [];
    for (let page = 1; page <= 20; page += 1) {
      const { data } = typeof route === 'function' ? await route({ ...parameters, per_page: 100, page }) : await request(route, { ...parameters, per_page: 100, page });
      const values = Array.isArray(data) ? data : data.check_runs ?? data.branch_policies ?? data.jobs ?? data.artifacts;
      assert.ok(Array.isArray(values), 'Unexpected GitHub list shape');
      result.push(...values);
      if (values.length < 100) return result;
    }
    throw new Error('GitHub pagination was not exhausted');
  } };
}

async function cli() {
  assert.equal(process.argv.length, 3, 'Use one explicit delivery mode');
  const mode = process.argv[2];
  assert.ok(MODES.includes(mode), 'Unknown delivery mode');
  if (mode === 'clean') { clean(); return; }
  const env = process.env;
  assert.match(env.GITHUB_REPOSITORY ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
  const context = { repo: { owner, repo }, payload: parseStrictJson(readRegular(env.GITHUB_EVENT_PATH, 4 * 1024 * 1024), 4 * 1024 * 1024),
    sha: env.GITHUB_SHA, ref: env.GITHUB_REF, runId: Number(env.GITHUB_RUN_ID), actor: env.GITHUB_ACTOR, eventName: env.GITHUB_EVENT_NAME };
  const core = { setOutput(name, value) { assert.match(name, /^[a-z_]+$/); assert.ok(typeof value === 'string' && !/[\r\n]/.test(value), 'Unsafe output');
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`); } };
  await workflowMain(mode, { github: githubAdapter({ token: env.GITHUB_TOKEN }), context, core });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(() => { console.error('Workshop delivery stopped without a success marker. See the protected workflow owner for scoped readiness.'); process.exitCode = 1; });
}