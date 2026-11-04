import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import { ROOT } from './inputs.mjs';

const require = createRequire(import.meta.url);
export function checkContent({ root = ROOT } = {}) {
  const course = JSON.parse(fs.readFileSync(path.join(root, '.github/agentalvine/course.json'), 'utf8'));
  require('../.github/agentalvine/guide.cjs').validateCourse(course);
  assert.equal(course.sections.length, 4);
  assert.equal(course.command, 'proceed to next section');
  let lessons = 0;
  let links = 0;
  const markdownFiles = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['.git', '.work', '.terraform', 'node_modules'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) markdownFiles.push(full);
    }
  }
  walk(root);
  for (const section of course.sections) {
    assert.equal(section.steps.length, 4);
    for (const step of section.steps) {
      const file = path.join(root, step.lesson);
      const lesson = fs.readFileSync(file, 'utf8');
      for (const label of ['**Do**', '**How / why**', '**Expected**', '**Fix**', '![']) assert.ok(lesson.includes(label), `${step.id} needs ${label}`);
      assert.ok(lesson.split(/\s+/).length <= 220, `${step.id} is too long`);
      const mirror = path.join(root, 'full-ws-content', `${step.id}.md`);
      const mirrorText = fs.readFileSync(mirror, 'utf8');
      const normalizedLesson = lesson.replaceAll('../../docs/', '../docs/').replaceAll('../../exercise/', '../exercise/').replaceAll('../../infra/', '../infra/').replaceAll('../../app/', '../app/');
      assert.equal(mirrorText.replace(/\r\n/g, '\n'), normalizedLesson.replace(/\r\n/g, '\n'), `${step.id} mirror drifted`);
      lessons++;
    }
  }
  for (const file of markdownFiles) {
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(!/[ \t]+$/m.test(body), `${path.relative(root, file)} has trailing whitespace`);
    for (const match of body.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|#)/.test(target)) continue;
      const clean = decodeURIComponent(target.split('#')[0]);
      const resolved = path.resolve(path.dirname(file), clean);
      assert.ok(resolved.startsWith(root + path.sep) || resolved === root, `Link escapes package: ${target}`);
      assert.ok(fs.existsSync(resolved), `Broken link ${path.relative(root, file)} → ${target}`);
      links++;
    }
  }
  for (const filename of ['quality.yml', 'guide.yml', 'delivery.yml', 'cleanup.yml']) {
    const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows', filename), 'utf8'), { maxAliasCount: 150 });
    assert.ok(workflow.name && workflow.on && workflow.jobs);
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) if (step.uses) assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/, 'Pin actions to verified full SHAs');
    }
  }
  const official = JSON.parse(fs.readFileSync(path.join(root, 'docs/images/manifest.json'), 'utf8'));
  assert.ok(Array.isArray(official) && official.length === 19);
  assert.equal(new Set(official.map(image => image.file)).size, 19);
  for (const image of official) {
    assert.match(image.file, /^(?:s[1-4]-[1-4]|setup-enterprise|setup-clone|boundary)\.png$/);
    const bytes = fs.readFileSync(path.join(root, 'docs/images', image.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), image.sha256, 'Captured image bytes differ from their attribution manifest');
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(bytes.readUInt32BE(16) >= 1000 && bytes.readUInt32BE(20) >= 300, 'Reference image was clipped');
    assert.equal(image.participantOrAzureProof, false);
    assert.ok(image.sourcePage.startsWith('https:') && image.sourceImage.startsWith('https:') && image.publisher && image.license);
  }
  return { status: 'PASS', lessons, localLinks: links, attributedImages: official.length, sourcePreviewsAreNotLiveProof: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(checkContent(), null, 2));
