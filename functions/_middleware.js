// Cloudflare Pages serves web/ as static files; this forwards the API and health
// routes to the Render backend so the dashboard keeps calling its own origin.
const DEFAULT_BACKEND = 'https://kult-fuse-qep5.onrender.com';

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') return next();
  const backend = (env.BACKEND_URL || DEFAULT_BACKEND).replace(/\/+$/, '');
  try {
    // Buffered so a 401 from the backend comes back as a 401; a streamed body cannot be replayed.
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    return await fetch(`${backend}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, redirect: 'manual' });
  } catch (err) {
    return Response.json({ error: 'backend unreachable', detail: String(err?.message || err) }, { status: 502 });
  }
}
