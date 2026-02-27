/**
 * Worker script that serves the 2M parquet file from R2.
 *
 * Static assets (HTML, JS, CSS, smaller parquet files) are served
 * automatically by Workers Static Assets. This Worker only runs when
 * no static asset matches the request — which is exactly the case for
 * the 2M parquet file (excluded from static assets via .assetsignore
 * because it exceeds the 25 MiB per-file limit).
 *
 * Routing (handled by Cloudflare, not this code):
 *   1. Request matches a static asset → served directly (Worker not invoked)
 *   2. Request is a navigation request → index.html served (SPA mode)
 *   3. Otherwise → this Worker runs
 */

interface Env {
  ASSETS: Fetcher;
  arrow_cluster_demo_data: R2Bucket;
}

const R2_ROUTES: Record<string, string> = {
  "/data/points-2m.parquet": "points-2m.parquet",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const r2Key = R2_ROUTES[url.pathname];

    if (r2Key) {
      const object = await env.arrow_cluster_demo_data.get(r2Key);

      if (!object) {
        return new Response("Not Found", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("content-type", "application/vnd.apache.parquet");
      // Immutable per dataset version — cache aggressively
      headers.set("cache-control", "public, max-age=86400");

      return new Response(object.body, { headers });
    }

    // Not an R2 route — return 404 (static assets and SPA fallback
    // are already handled before this Worker is invoked)
    return new Response("Not Found", { status: 404 });
  },
};
