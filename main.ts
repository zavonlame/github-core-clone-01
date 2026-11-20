// Entry point for the forge. This process IS the server the grading env drives: its
// whole job is the handshake with that env — bind a port, tell the env where it is,
// then keep serving until the env says the trial is over.
//
// The handshake, in order:
//   1. Read MAKEFUN_ENV_URL. It names the env's origin (in a trial pod something like
//      http://store:8080). With no env URL there is nobody to register with, so the
//      process exits 1 — unless --port <n> was passed, in which case it just serves
//      on that port for local testing and never registers.
//   2. Build the app with createApp (from ./app.ts) and listen on port 0, letting the
//      kernel pick a free port. Port 8080 belongs to the env and is never bound here.
//   3. POST {"port": <port>} to <env>/register. The env notes where the request came
//      from plus that port and dials it from then on. 200 means accepted; 409 means
//      another entry registered first — either way, this process only waits.
//   4. GET <env>/done again and again until it answers {"done": true}. Every poll is a
//      short request that answers at once; a failure or a "not yet" answer just means
//      poll again after a pause.
//   5. Shut the server down and exit 0.

import { createApp } from './app.ts';

// One env call may hang this long before it is dropped and retried.
const CALL_TIMEOUT_MS = 30_000;
// Pauses between retries start here and double each time, up to MAX_WAIT_MS.
const FIRST_WAIT_MS = 250;
const MAX_WAIT_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Pause after `round` failed attempts: exponential from FIRST_WAIT_MS, capped. */
function retryPause(round: number): number {
  const doubled = FIRST_WAIT_MS * 2 ** Math.min(round, 8);
  return Math.min(MAX_WAIT_MS, doubled);
}

/** Read a --port <n> flag from the command line, if one was passed. */
function standalonePort(): number | null {
  const flag = process.argv.indexOf('--port');
  if (flag === -1 || flag + 1 >= process.argv.length) return null;
  const n = Number(process.argv[flag + 1]);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Tell the env which port the server bound. Returns once the env has the port (200)
 * or once another entry already claimed the slot (409). A 400 or 405 means the
 * request itself is wrong, so there is nothing to retry; anything else — a dropped
 * connection, a timeout, another status — is retried, since the env may still be
 * coming up.
 */
async function announcePort(envBase: string, port: number): Promise<void> {
  for (let round = 0; ; round += 1) {
    let answer: Response | null = null;
    try {
      answer = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      answer = null;
    }
    if (answer !== null) {
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register refused with HTTP ${answer.status}: ${await answer.text()}`);
      }
    }
    await pause(retryPause(round));
  }
}

/** Keep asking the env whether the trial is over; return only when it says yes. */
async function awaitDone(envBase: string): Promise<void> {
  for (let round = 0; ; round += 1) {
    try {
      const answer = await fetch(`${envBase}/done`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not answering, or the call timed out: the trial is not over yet.
    }
    await pause(retryPause(round));
  }
}

/**
 * Bind the server on an ephemeral port and return it. The kernel picks the port;
 * if it hands us 8080 — the env's own port — the server is closed and the draw is
 * repeated rather than fighting the env for its own port.
 */
async function bindEphemeral(server: ReturnType<typeof createApp>): Promise<number> {
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the server did not bind a TCP port');
    }
    if (address.port !== 8080) return address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function run(): Promise<void> {
  const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  const server = createApp();

  if (envBase === '') {
    const fixed = standalonePort();
    if (fixed === null) {
      process.stderr.write('[forge] MAKEFUN_ENV_URL is not set and no --port was given: nothing to register with\n');
      process.exit(1);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(fixed, '127.0.0.1', () => resolve());
    });
    process.stdout.write(`[forge] serving on port ${fixed} (standalone, no env)\n`);
    await new Promise<void>(() => {});
    return;
  }

  const port = await bindEphemeral(server);
  process.stdout.write(`[forge] listening on port ${port}\n`);

  await announcePort(envBase, port);
  process.stdout.write('[forge] registered; waiting for the env to finish\n');

  await awaitDone(envBase);
  server.close();
  process.stdout.write('[forge] env said done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
