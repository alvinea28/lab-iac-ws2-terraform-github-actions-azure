import express from 'express';
import { ManagedIdentityCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const themes = new Set(['blue', 'green', 'orange']);
export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function appConfiguration(env = process.env) {
  const message = env.APP_MESSAGE ?? 'Hello from alex';
  const theme = env.PAGE_THEME ?? 'blue';
  if (!/^[A-Za-z0-9 .,!-]{1,60}$/.test(message) || !message.trim() || !themes.has(theme)) throw new Error('Invalid public workshop display configuration');
  const iteration = env.WORKSHOP_ITERATION ?? '01';
  if (!['01', '02', '03'].includes(iteration)) throw new Error('Invalid workshop iteration');
  return { message, theme, iteration, account: env.STORAGE_ACCOUNT_NAME, container: env.STORAGE_CONTAINER_NAME, identity: env.MANAGED_IDENTITY_RESOURCE_ID };
}

export function createBlobProbe(config) {
  return async () => {
    if (!/^[a-z0-9]{3,24}$/.test(config.account ?? '') || !/^[a-z0-9-]{3,63}$/.test(config.container ?? '') || !config.identity?.includes('/providers/Microsoft.ManagedIdentity/userAssignedIdentities/')) {
      return { status: 'pending', reason: 'Owner-provided private Blob and managed identity are not configured.' };
    }
    try {
      const credential = new ManagedIdentityCredential({ resourceId: config.identity });
      const service = new BlobServiceClient(`https://${config.account}.blob.core.windows.net`, credential, { retryOptions: { maxTries: 2, tryTimeoutInMs: 8_000 } });
      const iterator = service.getContainerClient(config.container).listBlobsFlat().byPage({ maxPageSize: 1 });
      await iterator.next(); // An empty successful page still proves authenticated access.
      return { status: 'ok', reason: 'The app performed a read-only private Blob listing using its managed identity.' };
    } catch (error) {
      const status = Number(error.statusCode);
      return { status: 'failed', reason: status === 401 || status === 403 ? 'Storage authorization was denied; ask the owner to verify the exact data role.' : 'Private DNS, network, identity or storage readiness needs owner verification.' };
    }
  };
}

export function createApp({ env = process.env, probe } = {}) {
  const config = appConfiguration(env);
  const checkBlob = probe ?? createBlobProbe(config);
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set({
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (!['GET', 'HEAD'].includes(request.method)) return response.status(405).send('Read-only workshop application');
    next();
  });
  app.use('/assets', express.static(path.join(directory, 'public'), { dotfiles: 'deny', fallthrough: false, index: false }));
  app.get('/healthz', (_request, response) => response.json({ status: 'ok', service: 'ws2-welcome' }));
  app.get('/health/storage', async (_request, response) => {
    const result = await checkBlob();
    response.status(result.status === 'ok' ? 200 : 503).json(result);
  });
  app.get('/', (_request, response) => response.type('html').send(`<!doctype html>
<html lang="en" data-theme="${config.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your personal Azure environment · WS2</title><link rel="stylesheet" href="/assets/style.css"><script src="/assets/page.js" defer></script></head>
<body><main class="shell"><header><a class="brand" href="/">WS2<span>IaC / Azure</span></a><span class="status"><i></i>Supplied workshop app</span></header>
<section class="hero"><p class="eyebrow">CODE IT. REVIEW IT. SEE IT.</p><h1>${escapeHtml(config.message)}</h1><p class="lead">One small change in Terraform. A visible result in your own Azure environment.</p><div class="badges"><span>Linux · Basic B1</span><span>Private Blob storage</span><span>Iteration ${config.iteration}</span></div></section>
<section class="grid"><article class="card"><p class="number">01 / THE RESULT</p><h2>Your settings are live.</h2><p>The message and ${config.theme} theme come from reviewed Terraform app settings—not a manual portal edit.</p><dl><div><dt>Theme</dt><dd>${config.theme}</dd></div><div><dt>Workshop iteration</dt><dd>${config.iteration}</dd></div></dl></article>
<article class="card"><p class="number">02 / VERIFY THE PATH</p><h2>A real connection check.</h2><p>Ask this app to list one private Blob page using its managed identity. An empty successful page is enough.</p><button id="check-storage" type="button">Check private storage <span aria-hidden="true">↗</span></button><p id="storage-result" role="status">Not checked. A local preview is not Azure connectivity proof.</p></article></section>
<footer><p>Git → Pull request → Actions → Saved plan → Azure</p><p>AgentAlvine guides the lesson. It does not authorize deployment.</p></footer></main></body></html>`));
  app.use((_error, _request, response, _next) => response.status(404).send('Not found'));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  createApp().listen(port, process.env.WEBSITE_SITE_NAME ? '0.0.0.0' : '127.0.0.1', () => console.log(`Workshop app ready on port ${port}; Azure connectivity has not been inferred.`));
}
