// Cloudflare Worker that serves the single-file player / downloader / docs app.
//
// Routes (all served from public/index.html; the page itself reads
// location.pathname to decide which view to show):
//   /e, /e/, /e/<data>, /e/?=<data>   -> player
//   /d, /d/, /d/<data>, /d/?=<data>   -> downloader
//   anything else without a file ext  -> docs page (same as the page's own fallback)
//
// The Worker's job is (1) making /e/* and /d/* resolve to the app instead of
// 404ing, and (2) sending the headers the player needs to be embedded and to
// use fullscreen / PiP / autoplay.

const APP_ROUTE = /^\/(e|d)(\/.*)?$/;

// Relative assets (logo.png, favicon.ico, ...) referenced by the page resolve
// to /e/logo.png when the page is loaded from /e/<data>. Map them back to root.
// Base64url payloads never contain a dot, so a dotted last segment is a file.
const NESTED_ASSET = /^\/(?:e|d)\/([^/]+\.(?:png|ico|svg|jpe?g|webp|gif|css|js|json|txt|webmanifest))$/i;
const HAS_EXTENSION = /\.[a-z0-9]{2,8}$/i;

const PERMISSIONS_POLICY = [
  'fullscreen=*',
  'picture-in-picture=*',
  'autoplay=*',
  'encrypted-media=*',
  'screen-wake-lock=*',
  'clipboard-write=*',
].join(', ');

function withHeaders(response, { html }) {
  const headers = new Headers(response.headers);

  // Allow other sites to call us / embed us.
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (html) {
    // Embeddable from any origin (the player posts status to window.parent).
    headers.delete('X-Frame-Options');
    headers.set('Content-Security-Policy', 'frame-ancestors *');
    // Lets the player use fullscreen/PiP/autoplay and delegate them onward.
    // NOTE: if the player is inside an <iframe>, the *embedding* page must also
    // grant these via allow="fullscreen; picture-in-picture; autoplay".
    headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveApp(request, env, url) {
  // Fetching "/" returns index.html directly (fetching "/index.html" would 307
  // to "/" because of the default html_handling).
  const appUrl = new URL('/', url);
  const res = await env.ASSETS.fetch(new Request(appUrl, request));
  return withHeaders(res, { html: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD, OPTIONS' },
      });
    }

    // /e/logo.png -> /logo.png (and favicon.ico, etc.)
    const nested = pathname.match(NESTED_ASSET);
    if (nested) {
      const res = await env.ASSETS.fetch(new Request(new URL('/' + nested[1], url), request));
      if (res.status === 404 && /^favicon\.ico$/i.test(nested[1])) {
        return withHeaders(new Response(null, { status: 204 }), { html: false });
      }
      return withHeaders(res, { html: false });
    }

    // Player / downloader.
    if (APP_ROUTE.test(pathname)) {
      return serveApp(request, env, url);
    }

    // Everything else: real static file if present, otherwise the app (docs view).
    const res = await env.ASSETS.fetch(request);
    if (res.status !== 404) {
      return withHeaders(res, { html: (res.headers.get('content-type') || '').includes('text/html') });
    }
    if (HAS_EXTENSION.test(pathname)) {
      if (/^\/favicon\.ico$/i.test(pathname)) {
        return withHeaders(new Response(null, { status: 204 }), { html: false });
      }
      return withHeaders(res, { html: false }); // genuine 404 for missing files
    }
    return serveApp(request, env, url);
  },
};
