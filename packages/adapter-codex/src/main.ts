/**
 * ari-adapter-codex — drive a Codex app-server through ARI 1.0.
 *
 *   node packages/adapter-codex/src/main.ts [flags] --codex <command> [args...]
 *
 * The adapter is a translator, not a harness: it speaks ARI 1.0 (Binding A,
 * JSON-RPC 2.0 / NDJSON on its own stdio) toward the shell, and the Codex
 * app-server wire protocol toward the runtime it spawns. See SPEC Appendix B
 * for the mapping and `packages/adapter-codex/src/adapter.ts` for the
 * decisions the translation encodes.
 *
 * Flags:
 *   --codex <command> [args...]  the app-server to spawn (mandatory; put it
 *                                last — every following token is its argv,
 *                                e.g. `--codex codex app-server`)
 *   --cwd <dir>                  working directory handed to the app-server
 *                                and used for thread/start
 *   --queue-limit <n>            reject prompts beyond n pending with -32005
 *   --minimal                    declare every capability false and suppress
 *                                every gated event (conformance aid)
 *
 * Example — conformance against the in-repo Codex-protocol fake:
 *   node packages/conformance/src/main.ts --probe-slow "slow 8000" \
 *     --probe-error fail --probe-approval approve --probe-question question \
 *     --queue-limit 3 -- \
 *     node packages/adapter-codex/src/main.ts --queue-limit 3 \
 *     --codex node packages/adapter-codex/test/fake-codex.ts
 */

import { readFramesSafe } from "../../ari/src/index.ts";
import { CodexAriAdapter } from "./adapter.ts";
import type { CodexChildSpec } from "./codex.ts";

interface CliOptions {
  codex?: CodexChildSpec;
  cwd?: string;
  queueLimit?: number;
  minimal: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { minimal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--codex": {
        const command = argv[i + 1];
        if (command === undefined) throw new Error("--codex needs a command; put it last, every following token is its argv");
        options.codex = { command, args: argv.slice(i + 2) };
        return options; // everything after --codex belongs to the runtime
      }
      case "--cwd":
        options.cwd = requireValue(argv, ++i, arg);
        break;
      case "--queue-limit":
        options.queueLimit = Number(requireValue(argv, ++i, arg));
        break;
      case "--minimal":
        options.minimal = true;
        break;
      default:
        throw new Error(`unknown flag: ${String(arg)}`);
    }
  }
  return options;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function log(message: string): void {
  // stdout is reserved for ARI frames (SPEC §4.1): everything else to stderr.
  process.stderr.write(`[adapter-codex] ${message}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.codex === undefined) {
  process.stderr.write("missing --codex <command> [args...]; nothing to translate to\n");
  process.exit(2);
}

const adapter = new CodexAriAdapter(
  {
    codex: options.codex,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.queueLimit !== undefined ? { queueLimit: options.queueLimit } : {}),
    minimal: options.minimal,
    log,
    exit: (code) => process.exit(code),
  },
  process.stdout,
);

// ARI frames in from the shell; parse failures answer -32700 and keep serving.
void (async () => {
  for await (const frame of readFramesSafe(process.stdin)) {
    if (frame.ok) {
      await adapter.handleMessage(frame.value);
    } else {
      log(`unparseable ARI frame: ${frame.error.message}`);
      await adapter.handleParseFailure();
    }
  }
  // stdin closed: the shell is gone (SPEC §4.1) — take the runtime with us.
  log("stdin closed; exiting");
  adapter.dispose();
  process.exit(0);
})();

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    log(`received ${signal}`);
    adapter.dispose();
    process.exit(0);
  });
}
