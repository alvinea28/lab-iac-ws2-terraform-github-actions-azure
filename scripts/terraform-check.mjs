import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, readInputs, validateParticipant, deriveNames, terraformVariables } from './inputs.mjs';

export function offlineEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ARM_|AZURE_|ACTIONS_ID_TOKEN_|ACTIONS_RUNTIME_|GITHUB_TOKEN|GH_TOKEN|TF_VAR_|TF_CLI_ARGS)/i.test(key)) delete env[key];
  }
  return { ...env, TF_IN_AUTOMATION: 'true', CHECKPOINT_DISABLE: '1', ...extra };
}

export function terraformBinary() {
  if (process.env.TERRAFORM_BINARY) return process.env.TERRAFORM_BINARY;
  const local = path.resolve(ROOT, '../../.tools/terraform/terraform.exe');
  return fs.existsSync(local) ? local : 'terraform';
}

export function executeTerraform(args, cwd, env) {
  const result = spawnSync(terraformBinary(), args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 240_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Terraform ${args[0]} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

export function runTerraformChecks({ schemaOnly = false, root = ROOT, participantOverride } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2-iac-offline-'));
  const cache = path.join(root, '.work/provider-cache');
  fs.mkdirSync(cache, { recursive: true });
  const env = offlineEnvironment({ TF_PLUGIN_CACHE_DIR: cache, TF_DATA_DIR: path.join(temporary, '.terraform') });
  let verificationError;
  try {
    for (const entry of fs.readdirSync(path.join(root, 'infra'), { withFileTypes: true })) {
      if (entry.isFile() && (entry.name.endsWith('.tf') || entry.name === '.terraform.lock.hcl') && entry.name !== 'backend.tf') {
        fs.copyFileSync(path.join(root, 'infra', entry.name), path.join(temporary, entry.name));
      }
    }
    // Generated test artifacts live only in this disposable root, never the source.
    const assignment = JSON.parse(fs.readFileSync(path.join(root, 'workshop/assignment.example.json'), 'utf8'));
    const actualInput = validateParticipant(participantOverride ?? readInputs(root));
    // Fixed regression fixtures and a separate generated learner-input case both
    // execute. Changing your name must not break alex-only rejection fixtures.
    const baseline = { participant_name: 'alex', instance_number: '001', app_message: 'Hello from alex', page_theme: 'blue', workshop_iteration: '01' };
    const values = terraformVariables(baseline, assignment);
    fs.writeFileSync(path.join(temporary, 'offline.auto.tfvars.json'), JSON.stringify(values));
    if (fs.existsSync(path.join(root, 'infra/tests'))) fs.cpSync(path.join(root, 'infra/tests'), path.join(temporary, 'tests'), { recursive: true });
    if (fs.existsSync(path.join(temporary, 'tests/workshop.tftest.hcl'))) {
      const fixture = fs.readFileSync(path.join(temporary, 'tests/workshop.tftest.hcl'), 'utf8');
      const mocks = fixture.split('\nrun "')[0];
      const personal = terraformVariables(actualInput, assignment);
      const names = deriveNames(actualInput);
      const variables = Object.entries(personal).map(([key, value]) => `    ${key} = ${JSON.stringify(value)}`).join('\n');
      fs.writeFileSync(path.join(temporary, 'tests/personal.tftest.hcl'), `${mocks}\nrun "learner_personal_namespace" {\n  command = plan\n  variables {\n${variables}\n  }\n  assert {\n    condition = azurerm_resource_group.workshop.name == "${names.resourceGroup}" && azurerm_storage_account.workshop.name == "${names.storage}" && azurerm_linux_web_app.workshop.app_settings["PAGE_THEME"] == "${actualInput.page_theme}"\n    error_message = "The learner input must feed the real HCL names and settings."\n  }\n}\n`);
    }
    const version = JSON.parse(executeTerraform(['version', '-json'], temporary, env));
    assert.equal(version.terraform_version, '1.16.1', 'Use the workshop-pinned Terraform 1.16.1');
    executeTerraform(['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'], temporary, env);
    const schema = JSON.parse(executeTerraform(['providers', 'schema', '-json'], temporary, env));
    const provider = schema.provider_schemas['registry.terraform.io/hashicorp/azurerm'];
    assert.ok(provider, 'Pinned AzureRM schema was not loaded');
    if (schemaOnly) return schema;
    executeTerraform(['fmt', '-check', '-recursive', '-no-color'], path.join(root, 'infra'), offlineEnvironment());
    const validation = JSON.parse(executeTerraform(['validate', '-json'], temporary, env));
    assert.equal(validation.valid, true);
    const output = executeTerraform(['test', '-json', '-no-color'], temporary, env);
    const events = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const summary = events.findLast(event => event.type === 'test_summary')?.test_summary;
    assert.ok(summary && summary.passed > 0 && summary.failed === 0 && summary.errored === 0 && summary.skipped === 0, 'Mocked Terraform tests must execute, with no failures/zero/skipped cases');
    return { status: 'PASS', terraform: version.terraform_version, provider: '5.4.0', mockedTests: summary.passed, azureAccessed: false };
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    // Windows can briefly retain provider DLL/executable handles after the
    // native child exits. Use the filesystem's bounded EPERM/EBUSY retry, not a
    // test-timing sleep or a broad process kill; only our unique temp is removed.
    try {
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      assert.ok(!fs.existsSync(temporary), 'Owned offline test root must be removed');
    } catch (cleanupError) {
      if (verificationError) throw new AggregateError([verificationError, cleanupError], 'Offline verification and owned-temp cleanup both failed');
      throw cleanupError;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const schema = process.argv.includes('--schema');
  assert.ok(process.argv.slice(2).every(argument => ['--schema', '--validate', '--mock'].includes(argument)), 'Use only --schema, --validate or --mock; verbose plan capture is not part of this workshop');
  const result = runTerraformChecks({ schemaOnly: schema });
  if (schema) {
    const provider = result.provider_schemas['registry.terraform.io/hashicorp/azurerm'];
    for (const resource of ['azurerm_linux_web_app', 'azurerm_service_plan', 'azurerm_storage_account', 'azurerm_storage_container', 'azurerm_subnet', 'azurerm_private_endpoint']) {
      const block = provider.resource_schemas[resource].block;
      console.log(JSON.stringify({ resource, attributes: Object.keys(block.attributes), blocks: Object.keys(block.block_types ?? {}), siteConfig: block.block_types?.site_config?.block }));
    }
    console.log(JSON.stringify({ providerAttributes: Object.keys(provider.provider.block.attributes) }));
  } else console.log(JSON.stringify(result, null, 2));
}
