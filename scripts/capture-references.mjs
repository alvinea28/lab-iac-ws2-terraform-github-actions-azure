import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { ROOT } from './inputs.mjs';
import { STORYBOARDS, publisherReferences } from './preview.mjs';

const base = 'http://127.0.0.1:4318';
const executablePath = process.env.EDGE_BINARY ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(candidate => fs.existsSync(candidate));
assert.ok(executablePath, 'Set EDGE_BINARY to an already installed supported Chromium browser');
const browser = await chromium.launch({ executablePath, headless: true });
const manifest = [];
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  for (const [id, story] of Object.entries(STORYBOARDS)) {
    await page.goto(`${base}/storyboard/${id}`, { waitUntil: 'networkidle' });
    const image = page.locator('.publisher img');
    assert.ok(await image.evaluate(element => element.complete && element.naturalWidth > 0), `${id} publisher reference is missing`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${id} desktop overflow`);
    const file = `${id}.png`;
    const bytes = await page.locator('.board').screenshot({ path: path.join(ROOT, 'docs/images', file) });
    const ref = publisherReferences[story.reference];
    const sourceResponse = await fetch(`${base}/reference/${story.reference}`);
    assert.equal(sourceResponse.status, 200);
    const sourceBytes = Buffer.from(await sourceResponse.arrayBuffer());
    manifest.push({ file, kind: id === 'boundary' ? 'annotated-reference-with-labelled-local-illustration' : 'annotated-publisher-reference', capturedAt: new Date().toISOString(), sourcePage: ref.page, sourceImage: ref.url, publisher: ref.publisher, license: ref.license, sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), participantOrAzureProof: false });
  }
  let views = 0;
  for (const width of [1400, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const id of Object.keys(STORYBOARDS)) {
      await page.goto(`${base}/storyboard/${id}`, { waitUntil: 'networkidle' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${id} overflow at ${width}`);
      views++;
    }
    await page.goto(`${base}/app`, { waitUntil: 'networkidle' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `App overflow at ${width}`);
    await page.getByRole('button', { name: /Check private storage/ }).click();
    await page.getByRole('status').filter({ hasText: /not configured/ }).waitFor();
    views++;
  }
  fs.mkdirSync(path.join(ROOT, '.work'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.work/reference-manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(ROOT, '.work/reference-visual.json'), JSON.stringify({ status: 'PASS', captures: manifest.length, responsiveViews: views, browser: await browser.version(), azureAccessed: false }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', captures: manifest.length, responsiveViews: views, sourceProof: false, azureAccessed: false }));
} finally { await browser.close(); }
