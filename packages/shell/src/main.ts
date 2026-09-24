/**
 * ari-shell — a reference ARI 1.0 Shell.
 *
 *   node packages/shell/src/main.ts [flags] -- <harness command> [args...]
 *
 * The whole point of this file is what it does **not** contain: there is no
 * branch anywhere on which harness is on the other end. It speaks ARI, renders
 * events, and answers interactions. If that is not enough to drive a harness,
 * the protocol is wrong — not the Shell.
 *
 * Modes:
 *   interactive (default)  read prompts from stdin; a pending interaction
 *                          consumes the next line instead
 *   --prompt <text>        send one prompt, wait for the turn to settle, exit
 *
 * Flags:
 *   --policy ask|allow|deny   how to answer approvals (default: ask)
 *   --no-reasoning            hide reasoning/delta
 *   --show-status             show session/status transitions
 *   --raw                     print raw event JSON instead of rendering
 */

import { createInterface } from "node:readline";

import {
  AriClient,
  AriError,
  type AriEvent,
  type ApprovalOption,
  type QuestionSpec,
} from "../../ari/src/index.ts";
import {
  buildAnswers,
  chooseDecision,
  offeredDecisions,
  parseDecision,
} from "./policy.ts";
import { DEFAULT_RENDER_OPTIONS, renderEvent, type RenderOptions } from "./render.ts";

interface Options {
  command: string;
  args: string[];
  policy: "ask" | "allow" | "deny";
  prompt?: string;
  raw: boolean;
  render: RenderOptions;
}

function parseArgs(argv: readonly string[]): Options {
  const separator = argv.indexOf("--");
  if (separator < 0) {
    throw new Error("missing `--`; usage: ari-shell [flags] -- <harness command> [args...]");
  }
  const flags = argv.slice(0, separator);
  const rest = argv.slice(separator + 1);
  if (rest.length === 0) throw new Error("no harness command given after `--`");

  const options: Options = {
    command: rest[0] as string,
    args: rest.slice(1),
    policy: "ask",
    raw: false,
    render: { ...DEFAULT_RENDER_OPTIONS },
  };

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    switch (flag) {
      case "--prompt":
        options.prompt = flags[++i];
        break;
      case "--policy": {
        const value = flags[++i];
        if (value !== "ask" && value !== "allow" && value !== "deny") {
          throw new Error("--policy must be ask, allow, or deny");
        }
        options.policy = value;
        break;
      }
      case "--no-reasoning":
        options.render.showReasoning = false;
        break;
      case "--show-status":
        options.render.showStatus = true;
        break;
      case "--raw":
        options.raw = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "Usage: ari-shell [flags] -- <harness command> [args...]",
            "",
            "  --prompt <text>          send one prompt, wait for the turn, exit",
            "  --policy ask|allow|deny  approval policy (default: ask)",
            "  --no-reasoning           hide reasoning/delta",
            "  --show-status            show session/status transitions",
            "  --raw                    print raw event JSON",
            "",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${flag}`);
    }
  }

  return options;
}

// ── output ──────────────────────────────────────────────────────────────

let midLine = false;
let currentStream: "message" | "reasoning" | undefined;

function write(text: string): void {
  process.stdout.write(text);
}

function writeLine(text: string): void {
  if (midLine) {
    write("\n");
    midLine = false;
    currentStream = undefined;
  }
  write(`${text}\n`);
}

function emit(chunk: ReturnType<typeof renderEvent>): void {
  if (chunk.kind === "none") return;
  if (chunk.kind === "stream") {
    // Reasoning and the answer are different streams; do not run them together
    // on one line just because both are deltas.
    if (midLine && currentStream !== undefined && currentStream !== chunk.stream) {
      write("\n");
      midLine = false;
    }
    if (!midLine && chunk.stream === "reasoning") write("  ~ ");
    write(chunk.text);
    midLine = true;
    currentStream = chunk.stream;
    return;
  }
  writeLine(chunk.text);
}

// ── main ────────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2));

const client = AriClient.spawn({
  command: options.command,
  args: options.args,
  // Harness logs belong on stderr (SPEC §4.1); surface them prefixed so they
  // never contaminate the rendered conversation.
  onStderr: (chunk) => process.stderr.write(chunk.replace(/^/gm, "  [harness] ")),
});

let pendingApproval: { approvalId: string; options?: ApprovalOption[] } | undefined;
let pendingQuestion: { questionId: string; questions: QuestionSpec[] } | undefined;
let running = false;

client.onEvent((event: AriEvent) => {
  if (options.raw) {
    writeLine(JSON.stringify(event));
  } else {
    emit(renderEvent(event, options.render));
  }

  if (event.type === "turn/started") running = true;
  if (event.type === "turn/completed") running = false;
});

// Approvals and questions are answered from the same input stream as prompts:
// while one is pending, the next line is the answer (SPEC §10).
client.on("approval/requested", (params) => {
  const approvalId = params["approvalId"];
  if (typeof approvalId !== "string") return;
  pendingApproval = {
    approvalId,
    ...(Array.isArray(params["options"]) ? { options: params["options"] as ApprovalOption[] } : {}),
  };
  if (options.policy !== "ask") {
    const decision = chooseDecision(pendingApproval.options, options.policy);
    if (decision) void respondApproval(decision);
  }
});

client.on("question/requested", (params) => {
  const questionId = params["questionId"];
  if (typeof questionId !== "string") return;
  pendingQuestion = { questionId, questions: (params["questions"] ?? []) as QuestionSpec[] };
});

async function respondApproval(decision: string): Promise<void> {
  const pending = pendingApproval;
  if (!pending) return;
  pendingApproval = undefined;
  // Never send a decision outside what was offered (Appendix A item 24).
  if (!offeredDecisions(pending.options).includes(decision as never)) {
    writeLine(`  ! ${decision} was not offered; ignoring`);
    return;
  }
  try {
    await client.respondApproval({
      sessionId: sessionId ?? "",
      approvalId: pending.approvalId,
      decision: decision as never,
    });
  } catch (error) {
    writeLine(`  ! could not answer approval: ${message(error)}`);
  }
}

async function respondQuestion(input: string): Promise<void> {
  const pending = pendingQuestion;
  if (!pending) return;
  pendingQuestion = undefined;
  try {
    await client.respondQuestion({
      sessionId: sessionId ?? "",
      questionId: pending.questionId,
      answers: buildAnswers(pending.questions, input),
    });
  } catch (error) {
    writeLine(`  ! could not answer question: ${message(error)}`);
  }
}

function message(error: unknown): string {
  if (error instanceof AriError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}

// ── handshake ───────────────────────────────────────────────────────────

let sessionId: string | undefined;

try {
  const info = await client.initialize();
  const declared = Object.entries(info.agentCapabilities)
    .filter(([, on]) => on)
    .map(([key]) => key);
  writeLine(`connected to ${info.agentInfo.name} ${info.agentInfo.version} (ARI ${info.protocolVersion})`);
  writeLine(`capabilities: ${declared.length > 0 ? declared.join(", ") : "(none declared)"}`);
  const session = await client.newSession({ cwd: process.cwd() });
  sessionId = session.sessionId;
} catch (error) {
  process.stderr.write(`could not start a session: ${message(error)}\n`);
  client.close();
  process.exit(1);
}

// ── one-shot mode ───────────────────────────────────────────────────────

if (options.prompt !== undefined) {
  await client.prompt(sessionId, options.prompt);
  await new Promise<void>((resolve) => {
    const stop = client.on("turn/completed", () => {
      stop();
      resolve();
    });
  });
  if (midLine) write("\n");
  client.close();
  process.exit(0);
}

// ── interactive mode ────────────────────────────────────────────────────

// Input is driven by `line` events rather than `rl.question()`. With piped
// stdin every line arrives before any question is asked, so a question-based
// loop silently drops them; the pending-interaction state machine below already
// knows that the next line is an answer, so no question API is needed.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });

function promptLabel(): string {
  if (pendingApproval) return "approval> ";
  if (pendingQuestion) return "answer> ";
  return running ? "… " : "> ";
}

function showPrompt(): void {
  if (!process.stdin.isTTY) return;
  rl.setPrompt(promptLabel());
  rl.prompt();
}

async function handleInput(input: string): Promise<void> {
  if (pendingApproval) {
    const decision = parseDecision(input, pendingApproval.options);
    if (!decision) {
      writeLine(`  ! answer one of: ${offeredDecisions(pendingApproval.options).join(", ")}`);
      return;
    }
    await respondApproval(decision);
    return;
  }

  if (pendingQuestion) {
    await respondQuestion(input);
    return;
  }

  const text = input.trim();
  if (text === "") return;
  if (text === "/quit" || text === "/exit") {
    await shutdown();
    return;
  }
  try {
    await client.prompt(sessionId ?? "", text);
  } catch (error) {
    writeLine(`  ! ${message(error)}`);
  }
}

rl.on("line", (input: string) => {
  void handleInput(input).then(showPrompt);
});

rl.on("close", () => {
  void shutdown();
});

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) {
    void shutdown();
    return;
  }
  interrupted = true;
  void client.cancel(sessionId ?? "").catch(() => undefined);
  writeLine("\n  (cancelled — Ctrl-C again to quit)");
  setTimeout(() => {
    interrupted = false;
  }, 1000).unref();
});

async function shutdown(): Promise<void> {
  if (midLine) write("\n");
  try {
    await client.shutdown();
  } catch {
    // The harness may already be gone; that is not an error worth reporting.
  }
  rl.close();
  client.close();
  process.exit(0);
}

showPrompt();
