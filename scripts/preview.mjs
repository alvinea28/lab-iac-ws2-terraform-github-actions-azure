import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { ROOT, readInputs, deriveNames } from './inputs.mjs';
import { createApp } from '../app/server.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const referenceBase = path.resolve(ROOT, '../../repos/ws2-azure-delivery-laboratory-07/docs/images');
// Only known, already attributed PUBLIC publisher images may be used. This is
// an authoring preview, never a private simulation/evidence/state file browser.
export const publisherReferences = {
  clone: { file: 'vscode-clone.png', url: 'https://code.visualstudio.com/assets/docs/sourcecontrol/quickstart/clone-repository-url.png', publisher: 'Microsoft', page: 'https://code.visualstudio.com/docs/sourcecontrol/quickstart', license: 'CC BY 3.0 US' },
  stage: { file: 'vscode-stage.png', url: 'https://code.visualstudio.com/assets/docs/sourcecontrol/quickstart/stage-changes-button.png', publisher: 'Microsoft', page: 'https://code.visualstudio.com/docs/sourcecontrol/quickstart', license: 'CC BY 3.0 US' },
  commit: { file: 'vscode-commit.png', url: 'https://code.visualstudio.com/assets/docs/sourcecontrol/quickstart/commit-button.png', publisher: 'Microsoft', page: 'https://code.visualstudio.com/docs/sourcecontrol/quickstart', license: 'CC BY 3.0 US' },
  template: { file: 'github-template.webp', url: 'https://docs.github.com/assets/cb-76823/mw-1440/images/help/repository/use-this-template-button.webp', publisher: 'GitHub', page: 'https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template', license: 'CC BY 4.0' },
  pr: { file: 'github-pr-files.webp', url: 'https://docs.github.com/assets/cb-23571/mw-1440/images/help/pull_requests/pull-request-tabs-changed-files.webp', publisher: 'GitHub', page: 'https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request', license: 'CC BY 4.0' },
  actions: { file: 'github-actions.webp', url: 'https://docs.github.com/assets/cb-12958/mw-1440/images/help/repository/actions-tab-global-nav-update.webp', publisher: 'GitHub', page: 'https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow', license: 'CC BY 4.0' },
  workflow: { file: 'github-workflow-sidebar.webp', url: 'https://docs.github.com/assets/cb-40551/mw-1440/images/help/actions/superlinter-workflow-sidebar.webp', publisher: 'GitHub', page: 'https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs', license: 'CC BY 4.0' },
  groups: { url: 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/media/manage-resource-groups-portal/manage-resource-groups-list-groups.png', publisher: 'Microsoft Learn', page: 'https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/manage-resource-groups-portal', license: 'CC BY 4.0' },
};
export const STORYBOARDS = {
  'setup-enterprise': { title: 'Choose your permitted private copy', clicks: ['Sign in as your authorized user', 'Use this template → approved owner', 'Private → create once'], reference: 'template', note: 'Enterprise SSO/account access is real instructor prework; never use the example account.' },
  'setup-clone': { title: 'Clone and open one local repository', clicks: ['Your copy → Code → HTTPS', 'VS Code → Git: Clone', 'Choose parent folder → Open'], reference: 'clone', note: 'Confirm your own owner/remote. Git author metadata is not authentication.' },
  's1-1': { title: 'Open your copy and publish a task branch', clicks: ['Open the known clone', 'Create lab/first-check', 'Save the intended small change → publish'], reference: 'clone', note: 'Start in your private clone, not the source template. No Azure step here.' },
  's1-2': { title: 'Complete the two CI commands', clicks: ['Explorer → exercise/workflow-starter.yml', 'Fill input and mocked-check commands', 'Save complete learner-checks.yml once'], reference: 'pr', code: 'node scripts/inputs.mjs\nnode scripts/terraform-check.mjs --mock', note: 'Read-only reference: the real edit happens in VS Code. Keep canonical pins and permissions.' },
  's1-3': { title: 'Commit, push and open the learner PR', clicks: ['Source Control → review/stage', 'Commit → publish/push', 'GitHub → Pull requests → Files changed'], reference: 'commit', note: 'Choose existing protected main only for an owner-ready live cycle; offline copies use their supplied base.' },
  's1-4': { title: 'Read the exact learner check', clicks: ['PR → Checks → Details', 'Learner checks → Validate workshop inputs', 'Match the current commit'], reference: 'workflow', note: 'A green provider-mocked check is not deployment or Azure authorization.' },
  's2-1': { title: 'Your name goes in one place', clicks: ['Explorer → exercise/participant.json', 'Replace alex with approved name', 'Keep instance_number = 001'], reference: 'pr', parameters: true, note: 'This is a local parameter reference, not a screenshot of a deployed environment.' },
  's2-2': { title: 'Inspect the intended parameter diff', clicks: ['Save → stage → commit → push', 'Same PR → Files changed', 'Current learner checks must pass'], reference: 'pr', parameters: true, note: 'No Azure/OIDC/state in PR validation. A real plan starts only on authorized protected main.' },
  's2-3': { title: 'Watch create → app package → verification', clicks: ['Merge only when ready/permitted', 'Actions → Workshop delivery', 'Open the matching main-push run'], reference: 'workflow', note: 'The exact saved plan creates rg-name-001 and its children. Source/unapproved copies skip cloud work.' },
  's2-4': { title: 'Find your new group and service properties', clicks: ['Azure → Resource groups', 'Open your actual rg-name-001', 'Resources → VNet / Storage / App Service'], reference: 'groups', note: 'Publisher example list, not your resources. Use your actual returned app URL and verify private Blob health.' },
  's3-1': { title: 'Record the before-value, not another environment', clicks: ['Open your existing app URL', 'Compare current message/theme', 'Keep the same RG and resource IDs'], reference: 'groups', parameters: true, note: 'The actual page is supplied by the app. No Azure result is shown in this reference image.' },
  's3-2': { title: 'Purple is a safe validation failure', clicks: ['Task PR → page_theme = purple', 'Push → Learner checks', 'Validate participant input must fail'], reference: 'workflow', code: 'page_theme: purple\nAllowed: blue | green | orange', note: 'A teaching illustration of the expected error, not evidence that a participant run failed.' },
  's3-3': { title: 'Correct the input and keep 001', clicks: ['Use green, new message and iteration 02', 'Push → inspect current checks', 'Merge → observe the same-resource update'], reference: 'pr', code: 'page_theme: green\nworkshop_iteration: 02\ninstance_number: 001 (unchanged)', note: 'Iteration is a tag. Do not rename the RG, resize B1 or change security/backends.' },
  's3-4': { title: 'Verify the visible update', clicks: ['Refresh the actual app URL', 'Compare message/theme and Azure tags', 'Verify same IDs and private Blob read'], reference: 'groups', note: 'References never certify a live update. The trusted job and actual properties must agree.' },
  's4-1': { title: 'Confirm everything inside the owned RG', clicks: ['Azure → your exact resource group', 'Compare live inventory with managed state', 'Stop on any unknown/shared child'], reference: 'groups', note: 'No raw state is pictured. Backend/identities/runner remain outside the owned RG and deployment authority.' },
  's4-2': { title: 'Request read-only convergence', clicks: ['Actions → Workshop delivery', 'Run workflow → main → followup', 'Inspect Confirm no-change'], reference: 'workflow', note: 'Detailed exit 0 means no change; 2 means differences. Do not reuse an old green run.' },
  's4-3': { title: 'Cleanup is a separate owner decision', clicks: ['Authorized admin → Workshop cleanup', 'Choose main and exact scope-bound authorization', 'Inspect encrypted-plan/exact-destroy jobs'], reference: 'workflow', note: 'Only input labels are explained. No real authorization value, plan, key or state is shown.' },
  's4-4': { title: 'Verify that the RG is truly gone', clicks: ['Azure → Resource groups → exact name', 'Confirm actual absence + empty managed state', 'Keep external bootstrap and cleanup record'], reference: 'groups', note: 'Publisher list is navigation only, not a fabricated empty result. Never force-delete a group to satisfy the lesson.' },
  boundary: { title: 'Four steps complete? Pause here.', clicks: ['Wait for Section complete — 4/4', 'In the SAME Exercise, type the exact phrase', 'Choose Comment; refresh the current issue'], reference: 'actions', code: 'proceed to next section', note: 'Mona-style issue navigation is provided by AgentAlvine. This local illustration is not GitHub UI or Azure permission.' },
};

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · WS2 reference</title><link rel="stylesheet" href="/preview.css"><link rel="stylesheet" href="/preview-extra.css"></head><body>${body}</body></html>`;
}
function storyboard(id) {
  const item = STORYBOARDS[id];
  if (!item) return null;
  const reference = publisherReferences[item.reference];
  const parameters = item.parameters ? `<pre>${escape(JSON.stringify(readInputs(), null, 2))}</pre><p class="names">${Object.values(deriveNames(readInputs())).slice(0, 3).map(escape).join(' · ')}</p>` : '';
  const boundary = id === 'boundary' ? '<div class="comment-example"><p>Local illustration of the comment area — not GitHub UI</p><textarea readonly aria-label="Example comment">proceed to next section</textarea><button disabled>Comment</button></div>' : '';
  return shell(item.title, `<main class="board"><div class="top"><b>WS2 / ${escape(id.toUpperCase())}</b><span>REFERENCE · NOT PARTICIPANT OR AZURE EVIDENCE</span></div><h1>${escape(item.title)}</h1><div class="columns"><section class="navigation"><ol>${item.clicks.map(click => `<li>${escape(click)}</li>`).join('')}</ol>${item.code ? `<pre>${escape(item.code)}</pre>` : ''}${parameters}${boundary}<p class="note">${escape(item.note)}</p></section><section class="publisher"><img src="/reference/${item.reference}" alt="${escape(reference.publisher)} publisher navigation example"><p>${escape(reference.publisher)} · ${escape(reference.license)} · original publisher example</p><p class="source">${escape(reference.page)}</p></section></div><footer>Follow the written names and your assigned copy, not the publisher's example account. Captured local annotated reference; no cloud operation.</footer></main>`);
}

export function createPreviewServer({ port = 4318 } = {}) {
  const cache = new Map();
  const app = createApp({ env: {} }); // No managed-identity/Blob configuration in this preview.
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.method !== 'GET') { response.writeHead(405); return response.end(); }
      if (url.pathname === '/app' || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/health')) {
        if (url.pathname === '/app') request.url = '/';
        return app(request, response);
      }
      if (['/preview.css', '/preview-extra.css'].includes(url.pathname)) { response.setHeader('Content-Type', 'text/css'); return response.end(fs.readFileSync(path.join(ROOT, 'scripts', path.basename(url.pathname)))); }
      if (url.pathname.startsWith('/reference/')) {
        const key = url.pathname.slice('/reference/'.length);
        const ref = publisherReferences[key];
        if (!ref) { response.writeHead(404); return response.end(); }
        if (!cache.has(key)) {
          if (ref.file && fs.existsSync(path.join(referenceBase, ref.file))) cache.set(key, fs.readFileSync(path.join(referenceBase, ref.file)));
          else {
            let target = ref.url;
            if (!target && ref.file) {
              const prior = JSON.parse(fs.readFileSync(path.join(referenceBase, 'manifest.json'), 'utf8'));
              target = prior.images.find(image => image.file === ref.file)?.url;
            }
            if (!target || !['learn.microsoft.com', 'docs.github.com', 'code.visualstudio.com'].includes(new URL(target).hostname)) throw new Error('Unapproved publisher image');
            const fetched = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
            if (!fetched.ok) throw new Error('Publisher image unavailable');
            cache.set(key, Buffer.from(await fetched.arrayBuffer()));
          }
        }
        response.setHeader('Content-Type', ref.file?.endsWith('.webp') ? 'image/webp' : 'image/png');
        return response.end(cache.get(key));
      }
      if (url.pathname.startsWith('/storyboard/')) {
        const html = storyboard(url.pathname.slice('/storyboard/'.length));
        if (!html) { response.writeHead(404); return response.end(); }
        response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(html);
      }
      const file = url.pathname === '/' ? 'README.md' : decodeURIComponent(url.pathname.slice(1));
      const resolved = path.resolve(ROOT, file);
      if (!resolved.startsWith(ROOT + path.sep) || file.split('/').some(part => ['.git', '.work', 'node_modules'].includes(part))) { response.writeHead(404); return response.end(); }
      if (/\.(png|webp)$/.test(file) && file.startsWith('docs/images/')) { response.setHeader('Content-Type', file.endsWith('.webp') ? 'image/webp' : 'image/png'); return response.end(fs.readFileSync(resolved)); }
      if (!file.endsWith('.md') || !fs.statSync(resolved).isFile()) { response.writeHead(404); return response.end(); }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      return response.end(shell(file, `<article class="markdown">${marked.parse(fs.readFileSync(resolved, 'utf8'))}</article>`));
    } catch { response.writeHead(404); response.end('Reference not available'); }
  });
  return server.listen(port, '127.0.0.1');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer();
  console.log('Read-only workshop preview: http://127.0.0.1:4318 — no Azure access.');
}
