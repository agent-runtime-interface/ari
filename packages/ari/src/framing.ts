/**
 * NDJSON 分帧 —— SPEC.md §4.1–§4.3。
 *
 * 规则：
 *  - 每行一条完整 JSON，以单个 \n 结束；JSON 内禁止嵌入换行。
 *  - 单行 ≤ 1 MiB（1,048,576 字节，UTF-8，不含换行）。
 *  - 写入侧必须施加背压（阻塞写），禁止无界缓冲。
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
 * 把一个消息编码为一行 NDJSON（含结尾换行）。
 * 超过帧上限时抛 FrameTooLargeError —— 调用方必须在**事件层**拆分（SPEC §4.2）。
 */
export function encodeFrame(message: unknown): string {
  const line = JSON.stringify(message);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_FRAME_BYTES) throw new FrameTooLargeError(bytes, "while encoding");
  return line + "\n";
}

/**
 * 从字节/字符串流中切出 NDJSON 帧并解析为 JSON 值。
 *
 * - 空行被忽略。
 * - 单帧超限抛 FrameTooLargeError（包含尚未收到换行的累积缓冲）。
 * - JSON 解析失败由调用方处理（对应 -32700）。
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
 * 创建一个带背压的帧写入器。
 *
 * 返回值在底层缓冲写满时等待 `drain`，因此不会无界堆积（SPEC §4.3）。
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
