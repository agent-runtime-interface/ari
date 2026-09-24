/**
 * NDJSON framing — SPEC.md §4.1–§4.3.
 *
 * Rules:
 *  - One complete JSON value per line, terminated by a single \n; embedded newlines are forbidden inside JSON.
 *  - A single line is ≤ 1 MiB (1,048,576 bytes, UTF-8, excluding the newline).
 *  - The write side must apply backpressure (blocking writes); unbounded buffering is forbidden.
 */

import type { Writable } from "node:stream";

export const MAX_FRAME_BYTES = 1_048_576;

export class FrameTooLargeError extends Error {
  bytes: number;

  constructor(bytes: number, where: string) {
    super(`frame exceeds ${MAX_FRAME_BYTES} bytes (${bytes}) ${where}`);
    this.name = "FrameTooLargeError";
    this.bytes = bytes;
  }
}

/**
 * Encode a message as one line of NDJSON (including the trailing newline).
 * Throws FrameTooLargeError when the frame limit is exceeded — the caller must split at the **event layer** (SPEC §4.2).
 */
export function encodeFrame(message: unknown): string {
  const line = JSON.stringify(message);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_FRAME_BYTES) throw new FrameTooLargeError(bytes, "while encoding");
  return line + "\n";
}

/**
 * Cut NDJSON frames out of a byte/string stream and parse them into JSON values.
 *
 * - Empty lines are ignored.
 * - A frame over the limit throws FrameTooLargeError (including the accumulated buffer when no newline has been received yet).
 * - JSON parse failures are handled by the caller (corresponding to -32700).
 */
export async function* readFrames(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let newlineAt = buffer.indexOf("\n");
    while (newlineAt >= 0) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      if (line.trim() !== "") {
        const bytes = Buffer.byteLength(line, "utf8");
        if (bytes > MAX_FRAME_BYTES) throw new FrameTooLargeError(bytes, "while decoding");
        yield JSON.parse(line);
      }
      newlineAt = buffer.indexOf("\n");
    }

    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
      throw new FrameTooLargeError(Buffer.byteLength(buffer, "utf8"), "in incomplete frame");
    }
  }

  const tail = buffer.trim();
  if (tail !== "") {
    const bytes = Buffer.byteLength(tail, "utf8");
    if (bytes > MAX_FRAME_BYTES) throw new FrameTooLargeError(bytes, "while decoding tail");
    yield JSON.parse(tail);
  }
}

/**
 * A non-throwing variant of {@link readFrames}.
 *
 * A Harness must be able to answer `-32700` for a malformed frame and keep
 * serving the connection (SPEC §11.1), so a parse failure cannot be allowed to
 * tear down the read loop. Each yielded item is either a decoded value or the
 * error for one frame.
 */
export type FrameResult =
  | { ok: true; value: unknown }
  | { ok: false; error: Error; line: string };

export async function* readFramesSafe(
  source: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<FrameResult> {
  const decoder = new TextDecoder();
  let buffer = "";

  const decode = (line: string): FrameResult => {
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_FRAME_BYTES) return { ok: false, error: new FrameTooLargeError(bytes, "while decoding"), line };
    try {
      return { ok: true, value: JSON.parse(line) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)), line };
    }
  };

  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let newlineAt = buffer.indexOf("\n");
    while (newlineAt >= 0) {
      const line = buffer.slice(0, newlineAt);
      buffer = buffer.slice(newlineAt + 1);
      if (line.trim() !== "") yield decode(line);
      newlineAt = buffer.indexOf("\n");
    }

    if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
      // Oversized with no newline in sight: drop the buffer and report one frame.
      const dropped = buffer;
      buffer = "";
      yield {
        ok: false,
        error: new FrameTooLargeError(Buffer.byteLength(dropped, "utf8"), "in incomplete frame"),
        line: dropped.slice(0, 200),
      };
    }
  }

  const tail = buffer.trim();
  if (tail !== "") yield decode(tail);
}

/**
 * Create a frame writer with backpressure.
 *
 * The returned function waits for `drain` when the underlying buffer is full, so it never piles up without bound (SPEC §4.3).
 */
export function createFrameWriter(
  target: Writable,
): (message: unknown) => Promise<void> {
  return async (message: unknown): Promise<void> => {
    const frame = encodeFrame(message);
    if (target.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        target.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        target.off("drain", onDrain);
        reject(err);
      };
      target.once("drain", onDrain);
      target.once("error", onError);
    });
  };
}
