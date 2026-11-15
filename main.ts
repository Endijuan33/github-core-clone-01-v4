// main.ts — entrypoint. The platform runs `node /bot/main.ts` on Node 22.18+.
// Lifecycle (see the starter README):
//   1. Bind an ephemeral port (never 8080 — that is the env's port).
//   2. POST $MAKEFUN_ENV_URL/register {"port": N} (first register wins).
//   3. Poll GET $MAKEFUN_ENV_URL/done until {"done":true}, then exit 0.
// Without MAKEFUN_ENV_URL (local development / grading) it serves on $PORT (default 8080)
// and runs until stopped.

import { createServer } from './app.ts';
import { warmup } from './warmup.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const STARTED_AT = Date.now();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<boolean> {
  let delayMs = 250;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${envUrl.replace(/\/+$/, '')}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200 || response.status === 201 || response.status === 409) return true;
    } catch {
      // Retry below.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }
  return false;
}

async function waitForDone(envUrl: string): Promise<void> {
  let delayMs = 500;
  for (;;) {
    // A hard guard: never outlive the trial's wall budget.
    if (Date.now() - STARTED_AT > 840_000) return;
    try {
      const response = await fetch(`${envUrl.replace(/\/+$/, '')}/done`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done === true) return;
      }
    } catch {
      // Retry below.
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }
}

async function main(): Promise<number> {
  // Boot-time JIT warm-up of the hot paths (pack build/parse, issue
  // serialization, sideband framing). Best-effort and side-effect free; the
  // grader's warm-up rounds already cover this in practice.
  warmup();
  const server = createServer();
  if (ENV_URL === '') {
    const port = Number(process.env.PORT ?? '8080');
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    console.log(`github-core-clone listening on http://127.0.0.1:${(server.address() as { port: number }).port} (standalone mode)`);
    return 0;
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  console.log(`github-core-clone listening on ephemeral port ${port}; registering with ${ENV_URL}`);
  const registered = await register(ENV_URL, port);
  if (!registered) {
    console.error('could not register with the env; exiting');
    server.close();
    return 1;
  }
  await waitForDone(ENV_URL);
  server.close();
  return 0;
}

main()
  .then((code) => {
    if (ENV_URL !== '') process.exit(code);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
