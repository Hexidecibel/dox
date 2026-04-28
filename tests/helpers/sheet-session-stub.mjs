// Stub SheetSession Durable Object for the vitest pool.
//
// Production wrangler.toml binds SHEET_SESSION via `script_name =
// "dox-sheet-session"` (cross-script DO — Cloudflare Pages cannot host
// DO classes itself). Miniflare cannot resolve cross-script bindings on
// its own in the test pool, so we register an auxiliary worker named
// `dox-sheet-session` that hosts a no-op SheetSession class. This lets
// the binding resolve so the runner can boot.
//
// No current test exercises the DO's real-time relay behavior; if/when
// they do, swap this stub for the actual class compiled to JS (e.g. via
// esbuild) or move the relay logic to a dispatchable pure module.
//
// Plain .mjs (not .ts) so miniflare can load it directly without a
// TypeScript transform.

export class SheetSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(_request) {
    return new Response(
      JSON.stringify({
        error: 'sheet_session_stub',
        message:
          'SheetSession is stubbed in the vitest pool. Production hosts the real class in workers/sheet-session.',
      }),
      { status: 501, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

export default {
  async fetch(_request, _env) {
    return new Response('not_found', { status: 404 });
  },
};
