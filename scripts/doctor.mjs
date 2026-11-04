import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './inputs.mjs';
import { terraformBinary, offlineEnvironment } from './terraform-check.mjs';

const results = [];
function check(name, run) {
  try { run(); results.push({ name, ready: true }); }
  catch { results.push({ name, ready: false }); }
}
check('Opened repository root', () => assert.equal(path.resolve(process.cwd()), ROOT));
check('Node 24.16 or compatible Node 24', () => assert.match(process.version, /^v24\./));
check('Git installed', () => assert.equal(spawnSync('git', ['--version'], { encoding: 'utf8' }).status, 0));
check('Terraform 1.16.1', () => {
  const result = spawnSync(terraformBinary(), ['version', '-json'], { env: offlineEnvironment(), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).terraform_version, '1.16.1');
});
check('Starter and guide available', () => {
  for (const file of ['exercise/participant.json', '.github/agentalvine/course.json', 'infra/versions.tf']) assert.ok(fs.statSync(path.join(ROOT, file)).isFile());
});
console.log(JSON.stringify({ results, azureAccessed: false, note: 'This read-only doctor does not verify browser/Git write access, SSO, Azure, budget or deployment authorization.' }, null, 2));
if (results.some(result => !result.ready)) process.exitCode = 1;
