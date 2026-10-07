// Builds dist/ for a manual Cloudflare Pages upload: the static dashboard plus a
// single _worker.js that proxies the API routes to the backend. Drag-and-drop
// uploads do not compile functions/, so the same proxy is emitted in worker form.
import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const out = new URL('dist/', root);
await fs.rm(out, { recursive: true, force: true });
await fs.cp(new URL('web/', root), out, { recursive: true });

const proxy = await fs.readFile(new URL('functions/_middleware.js', root), 'utf8');
if (!proxy.includes('export async function onRequest(')) throw new Error('functions/_middleware.js no longer exports onRequest');
const worker = `${proxy.replace('export async function onRequest(', 'async function onRequest(')}
export default {
  fetch: (request, env) => onRequest({ request, env, next: () => env.ASSETS.fetch(request) })
};
`;
await fs.writeFile(new URL('_worker.js', out), worker);
console.log(`BUILD PASS  dist/ → ${(await fs.readdir(out)).sort().join(', ')}`);
