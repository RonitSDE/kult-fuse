// Cloudflare Worker in front of the static dashboard in web/. It forwards the API
// and health routes to the Render backend so the dashboard keeps calling its own origin.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/healthz') return env.ASSETS.fetch(request);
    if (!env.BACKEND_URL) return Response.json({ error: 'BACKEND_URL not configured' }, { status: 503 });
    const backend = env.BACKEND_URL.replace(/\/+$/, '');
    try {
      // Buffered so a 401 from the backend comes back as a 401; a streamed body cannot be replayed.
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
      return await fetch(`${backend}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, redirect: 'manual' });
    } catch (err) {
      return Response.json({ error: 'backend unreachable', detail: String(err?.message || err) }, { status: 502 });
    }
  }
};
