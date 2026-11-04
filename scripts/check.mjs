import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ROOT, validateParticipant, parseParticipantJson } from './inputs.mjs';
import { runTerraformChecks } from './terraform-check.mjs';
import { checkContent } from './content-check.mjs';
import { buildPackage } from './package-app.mjs';

const participant = parseParticipantJson(fs.readFileSync(path.join(ROOT, 'exercise/participant.json')));
// Quality still tests the complete VALID baseline when the learner deliberately
// pushes the precise purple case. The separate Learner checks input job must fail.
// This does not turn a rejected live input into acceptable deployment input.
const validationInput = participant.page_theme === 'purple' ? { ...participant, page_theme: 'blue' } : participant;
validateParticipant(validationInput);
const canonical = fs.readFileSync(path.join(ROOT, 'exercise/validation-workflow.yml'), 'utf8');
const yaml = parse(canonical);
assert.deepEqual(yaml.permissions, { contents: 'read' });
assert.equal(yaml.jobs.validate.steps.find(step => step.name === 'Validate participant input').run, 'node scripts/inputs.mjs');
const installed = path.join(ROOT, '.github/workflows/learner-checks.yml');
if (fs.existsSync(installed)) assert.equal(fs.readFileSync(installed, 'utf8').replace(/\r\n/g, '\n').trimEnd(), canonical.replace(/\r\n/g, '\n').trimEnd(), 'Use the complete reviewed learner workflow, not weakened checks');
const content = checkContent();
const terraform = runTerraformChecks({ participantOverride: validationInput });
const packageProof = buildPackage();
console.log(JSON.stringify({ status: 'PASS', content, terraform, package: { sha256: packageProof.sha256, files: packageProof.files.length }, intentionalPurpleCase: participant.page_theme === 'purple', azureAccessed: false }, null, 2));
