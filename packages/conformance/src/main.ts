/**
 * ari-conformance — run the SPEC.md Appendix A checklist against any harness.
 *
 *   node packages/conformance/src/main.ts -- node path/to/my-harness.js
 *   ari-conformance -- node packages/mock-harness/src/main.ts \
 *       --probe-approval approve --probe-question question \
 *       --probe-slow "slow 5000" --probe-error throw
 *
 * Each check runs against a freshly spawned harness, so no state leaks between
 * checks. Checks that need the harness to be driven into a specific path report
 * SKIP (with the flag that would enable them) when the corresponding probe was
 * not supplied — a harness is never failed for something the suite could not
 * provoke.
 *
 * Shell-side items 23–25 of Appendix A are not testable from outside a Shell and
 * are therefore out of scope for this tool; `packages/ari/test` covers them for
 * the reference client.
 *
 * Exit code: 0 when nothing failed, 1 otherwise.
 */

import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";

import { AriClient, type AgentCapabilities, type AriEvent } from "../../ari/src/index.ts";
import { CHECKS, type Check, type CheckContext, type ProbePrompts } from "./checks.ts";

interface Options {
  command: string;
  args: string[];
  prompt: string;
  probes: ProbePrompts;
  queueLimit?: number;
  timeoutMs: number;
  only?: Set<string>;
  json: boolean;
}

interface CheckOutcome {
  id: string;
  item?: number;
  title: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

// ── argument parsing ────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): Options {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    throw new Error("missing `--`; usage: ari-conformance [flags] -- <harness command> [args...]");
  }
  const flags = argv.slice(0, separator);
  const rest = argv.slice(separator + 1);
  if (rest.length === 0) throw new Error("no harness command given after `--`");

  const options: Options = {
    command: rest[0] as string,
    args: rest.slice(1),
    prompt: "hello",
    probes: {},
    timeoutMs: 15_000,
    json: false,
  };

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const value = flags[i + 1];
    switch (flag) {
      case "--prompt":
        options.prompt = require(value, flag);
        i += 1;
        break;
      case "--probe-approval":
        options.probes.approval = require(value, flag);
        i += 1;
        break;
      case "--probe-question":
        options.probes.question = require(value, flag);
        i += 1;
        break;
      case "--probe-slow":
        options.probes.slow = require(value, flag);
        i += 1;
        break;
      case "--probe-error":
        options.probes.error = require(value, flag);
        i += 1;
        break;
      case "--queue-limit":
        options.queueLimit = Number(require(value, flag));
        i += 1;
        break;
      case "--timeout":
        options.timeoutMs = Number(require(value, flag));
        i += 1;
        break;
      case "--only":
        options.only = new Set(require(value, flag).split(",").map((s) => s.trim().toUpperCase()));
        i += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  return options;
}

function require(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: ari-conformance [flags] -- <harness command> [args...]",
      "",
      "  --prompt <text>          harmless prompt for observational checks (default: hello)",
      "  --probe-approval <text>  prompt that makes the harness request an approval",
      "  --probe-question <text>  prompt that makes the harness ask a question",
      "  --probe-slow <text>      prompt that holds a turn open long enough to cancel",
      "  --probe-error <text>     prompt that makes the turn end in an error",
      "  --queue-limit <n>        the harness's pending-input limit, to test -32005",
      "  --timeout <ms>           per-check timeout (default: 15000)",
      "  --only <C01,C02>         run a subset of checks",
      "  --json                   machine-readable output",
      "",
    ].join("\n"),
  );
}

// ── driving a harness ───────────────────────────────────────────────────

interface Session {
  client: AriClient;
  events: AriEvent[];
  rawFrames: string[];
  nonJsonStdout: string[];
  stderr(): string;
  kill(): void;
}

function startHarness(options: Options): Session {
  const child = spawn(options.command, options.args, { stdio: ["pipe", "pipe", "pipe"] });
  const clientIn = new PassThrough();
  const rawFrames: string[] = [];
  const nonJsonStdout: string[] = [];
  const events: AriEvent[] = [];
  let buffered = "";
  let stderrText = "";

  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newlineAt = buffered.indexOf("\n");
    while (newlineAt >= 0) {
      const line = buffered.slice(0, newlineAt);
      buffered = buffered.slice(newlineAt + 1);
      if (line.trim() !== "") {
        try {
          JSON.parse(line);
          rawFrames.push(line);
        } catch {
          // Anything on stdout that is not a frame violates SPEC §4.1.
          nonJsonStdout.push(line);
        }
      }
      newlineAt = buffered.indexOf("\n");
    }
    clientIn.write(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const client = AriClient.attach({
    input: clientIn,
    output: child.stdin,
    requestTimeoutMs: Math.min(options.timeoutMs, 8000),
  });
  client.onEvent((event) => events.push(event));

  return {
    client,
    events,
    rawFrames,
    nonJsonStdout,
    stderr: () => stderrText,
    kill: () => {
      client.close();
      child.kill();
    },
  };
}

function buildContext(session: Session, options: Options, capabilities: AgentCapabilities): CheckContext {
  const ctx: CheckContext = {
    client: session.client,
    events: session.events,
    rawFrames: session.rawFrames,
    nonJsonStdout: session.nonJsonStdout,
    capabilities,
    probes: options.probes,
    prompt: options.prompt,
    ...(options.queueLimit !== undefined ? { queueLimit: options.queueLimit } : {}),
    async waitFor(predicate, label, timeoutMs = options.timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(ctx.events)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        `timed out waiting for ${label}; saw [${ctx.events.map((event) => event.type).join(", ")}]` +
          (session.stderr() ? `\n      harness stderr: ${session.stderr().trim().split("\n").slice(-3).join(" | ")}` : ""),
      );
    },
    settle: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return ctx;
}

/** Discover the harness's declared capabilities once, for skip decisions. */
async function discover(options: Options): Promise<AgentCapabilities | undefined> {
  const session = startHarness(options);
  try {
    const result = await session.client.initialize();
    return result.agentCapabilities;
  } catch {
    return undefined;
  } finally {
    session.kill();
  }
}

// ── running ─────────────────────────────────────────────────────────────

async function runCheck(
  check: Check,
  options: Options,
  capabilities: AgentCapabilities,
): Promise<CheckOutcome> {
  const base = { id: check.id, ...(check.item !== undefined ? { item: check.item } : {}), title: check.title };
  const session = startHarness(options);
  try {
    const ctx = buildContext(session, options, capabilities);
    const skip = check.skipReason?.(ctx);
    if (skip) return { ...base, status: "skip", detail: skip };

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`check timed out after ${options.timeoutMs} ms`)),
        options.timeoutMs,
      );
    });
    try {
      await Promise.race([check.run(ctx), timeout]);
      return { ...base, status: "pass" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (error) {
    return { ...base, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    session.kill();
  }
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }

  const selected = CHECKS.filter((check) => !options.only || options.only.has(check.id));
  const capabilities = await discover(options);

  if (!capabilities) {
    process.stderr.write(
      `the harness did not complete an initialize handshake; cannot run conformance checks\n` +
        `  command: ${options.command} ${options.args.join(" ")}\n`,
    );
    process.exit(1);
  }

  const outcomes: CheckOutcome[] = [];
  for (const check of selected) {
    outcomes.push(await runCheck(check, options, capabilities));
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ target: [options.command, ...options.args].join(" "), capabilities, outcomes }, null, 2)}\n`,
    );
  } else {
    const enabled = Object.entries(capabilities)
      .filter(([, on]) => on)
      .map(([key]) => key);
    process.stdout.write(`ARI 1.0 conformance\n`);
    process.stdout.write(`  target:       ${options.command} ${options.args.join(" ")}\n`);
    process.stdout.write(`  capabilities: ${enabled.length > 0 ? enabled.join(", ") : "(none declared)"}\n`);
    process.stdout.write("\n");
    for (const outcome of outcomes) {
      const label = outcome.status.toUpperCase().padEnd(4);
      const id = outcome.id.padEnd(4);
      process.stdout.write(`  ${label}  ${id}  ${outcome.title}\n`);
      if (outcome.detail) {
        for (const line of outcome.detail.split("\n")) {
          process.stdout.write(`              ${line}\n`);
        }
      }
    }
    const passed = outcomes.filter((o) => o.status === "pass").length;
    const failed = outcomes.filter((o) => o.status === "fail").length;
    const skipped = outcomes.filter((o) => o.status === "skip").length;
    process.stdout.write(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  }

  process.exit(outcomes.some((o) => o.status === "fail") ? 1 : 0);
}

await main();
