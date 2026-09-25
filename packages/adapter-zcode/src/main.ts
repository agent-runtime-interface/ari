/**
 * ari-adapter-zcode — drive a ZCode Agent CLI through ARI 1.0.
 *
 *   node packages/adapter-zcode/src/main.ts [flags] --zcode <command> [args...]
 *
 * The adapter is a translator, not a harness: it speaks ARI 1.0 (Binding A,
 * JSON-RPC 2.0 / NDJSON on its own stdio) toward the shell, and the ZCode
 * Protocol V4 wire (`zcode app-server --stdio`: v4 RPC commands plus
 * conversation topic frames) toward the runtime it spawns. See SPEC Appendix B
 * for the mapping and `packages/adapter-zcode/src/adapter.ts` for the
 * decisions the translation encodes.
 *
 * Flags:
 *   --zcode <command> [args...]  the CLI runtime to spawn (mandatory; put it
 *                                last — every following token is its argv,
 *                                e.g. `--zcode zcode app-server --stdio`)
 *   --cwd <dir>                  working directory handed to the CLI and used
 *                                as the createSession workspace
 *   --queue-limit <n>            reject prompts beyond n pending with -32005
 *   --minimal                    declare every capability false and suppress
 *                                every gated event (conformance aid)
 *
 * Example — conformance against the in-repo ZCode-protocol fake:
 *   node packages/conformance/src/main.ts --probe-slow "slow 8000" \
 *     --probe-error fail --probe-approval approve --probe-question question \
 *     --queue-limit 3 -- \
 *     node packages/adapter-zcode/src/main.ts --queue-limit 3 \
 *     --zcode node packages/adapter-zcode/test/fake-zcode.ts
 */

import { readFramesSafe } from "../../ari/src/index.ts";
import { ZcodeAriAdapter } from "./adapter.ts";
import type { ZcodeChildSpec } from "./zcode.ts";

interface CliOptions {
  zcode?: ZcodeChildSpec;
  cwd?: string;
  queueLimit?: number;
  minimal: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { minimal: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--zcode": {
        const command = argv[i + 1];
        if (command === undefined) {
          throw new Error("--zcode needs a command; put it last, every following token is its argv");
        }
        options.zcode = { command, args: argv.slice(i + 2) };
        return options; // everything after --zcode belongs to the runtime
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
  process.stderr.write(`[adapter-zcode] ${message}\n`);
}

const options = parseArgs(process.argv.slice(2));
if (options.zcode === undefined) {
  process.stderr.write("missing --zcode <command> [args...]; nothing to translate to\n");
  process.exit(2);
}

const adapter = new ZcodeAriAdapter(
  {
    zcode: options.zcode,
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
