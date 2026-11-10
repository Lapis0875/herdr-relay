/**
 * herdr-core framed connections, protocol generation 1. A connection starts in plain mode (one JSON-RPC message per
 * `\n`-terminated line); the reply to `hello {framed:true}` switches it to frames:
 *
 *   [u32 LE channel][u8 kind][u32 LE payload length][payload]
 *
 * Channel 0 carries JSON-RPC messages as DATA frames. Every other channel is a stream opened by a call:
 * `events.subscribe` (JSON lines) or `terminal.attach` (raw terminal bytes). The receiver of stream DATA returns
 * CREDIT (u32 LE byte count) so the core keeps sending; CLOSE ends a stream from either side.
 *
 * Sources: `hc schema` (`hello.framed`, `SubscribeResult.channel`, `AttachResult.channel` naming DATA, RESIZE, FOCUS,
 * FACTS, CREDIT, CLOSE and AUTOMATIC_INPUT = kind 6) and the header layout, kind numbers and credit rule of
 * Shepherdr's generation-1 client (`~/.local/share/shepherdr/service/hc/protocol.ts`, `client.ts`).
 */

import { CoreError } from "./errors.ts";

/** Frame kinds. */
export const FRAME = {
  data: 0,
  credit: 1,
  close: 2,
  resize: 3,
  focus: 4,
  facts: 5,
  automaticInput: 6,
} as const;
export type FrameKind = (typeof FRAME)[keyof typeof FRAME];

/** Channel of JSON-RPC requests, responses and connection-level notifications. */
export const CONTROL_CHANNEL = 0;
/** Bytes before a frame's payload. */
export const FRAME_HEADER_BYTES = 9;
/** Largest payload either side accepts; a bigger announced length is a protocol error. */
export const MAX_FRAME = 16 * 1024 * 1024;
/** Longest line accepted in plain mode (the `hello` reply) and on the event stream. */
export const MAX_LINE = MAX_FRAME;

const EMPTY = new Uint8Array(0);

/** One frame: header and payload in a single buffer. */
export function encodeFrame(channel: number, kind: number, payload: Uint8Array = EMPTY): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(channel) || channel < 0 || channel > 0xffff_ffff) {
    throw new RangeError(`frame channel ${channel} is not a u32`);
  }
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) throw new RangeError(`frame kind ${kind} is not a u8`);
  if (payload.length > MAX_FRAME) throw new RangeError(`frame payload of ${payload.length} bytes exceeds ${MAX_FRAME}`);
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, channel, true);
  frame[4] = kind;
  view.setUint32(5, payload.length, true);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

/** CREDIT for `bytes` received on `channel`. */
export function encodeCredit(channel: number, bytes: number): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes, true);
  return encodeFrame(channel, FRAME.credit, payload);
}

/** A RESIZE payload: `[u16 LE cols][u16 LE rows]`; null when it is not 4 bytes. */
export function decodeResize(payload: Uint8Array): { cols: number; rows: number } | null {
  if (payload.length !== 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, 4);
  return { cols: view.getUint16(0, true), rows: view.getUint16(2, true) };
}

export type FrameHandler = (channel: number, kind: number, payload: Uint8Array) => void;

/**
 * Incremental frame parser: reads need not end on a frame boundary. Work is linear in the bytes received — a frame
 * split across reads is copied once into a buffer of its announced size, never re-concatenated. A payload is either a
 * view of the received chunk or that buffer; neither is reused, so handlers may keep it.
 */
export class FrameReader {
  readonly #header = new Uint8Array(FRAME_HEADER_BYTES);
  #headerFill = 0;
  #channel = 0;
  #kind = 0;
  #payload: Uint8Array | null = null;
  #payloadFill = 0;

  /** True when no partial frame is buffered. */
  get idle(): boolean {
    return this.#headerFill === 0 && this.#payload === null;
  }

  /** Parses `chunk`, calling `receive` per complete frame. Throws `CoreError("protocol")` for an oversized frame. */
  push(chunk: Uint8Array, receive: FrameHandler): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#payload !== null) {
        const n = Math.min(this.#payload.length - this.#payloadFill, chunk.length - offset);
        this.#payload.set(chunk.subarray(offset, offset + n), this.#payloadFill);
        this.#payloadFill += n;
        offset += n;
        if (this.#payloadFill === this.#payload.length) {
          const payload = this.#payload;
          this.#payload = null;
          receive(this.#channel, this.#kind, payload);
        }
        continue;
      }
      if (this.#headerFill === 0 && chunk.length - offset >= FRAME_HEADER_BYTES) {
        const view = new DataView(chunk.buffer, chunk.byteOffset + offset, FRAME_HEADER_BYTES);
        const length = checkedLength(view.getUint32(5, true));
        const channel = view.getUint32(0, true);
        const kind = chunk[offset + 4];
        const start = offset + FRAME_HEADER_BYTES;
        if (chunk.length - start >= length) {
          offset = start + length;
          receive(channel, kind, chunk.subarray(start, offset));
          continue;
        }
        this.#begin(channel, kind, length);
        offset = start;
        continue;
      }
      const n = Math.min(FRAME_HEADER_BYTES - this.#headerFill, chunk.length - offset);
      this.#header.set(chunk.subarray(offset, offset + n), this.#headerFill);
      this.#headerFill += n;
      offset += n;
      if (this.#headerFill < FRAME_HEADER_BYTES) return;
      this.#headerFill = 0;
      const view = new DataView(this.#header.buffer);
      const length = checkedLength(view.getUint32(5, true));
      const channel = view.getUint32(0, true);
      const kind = this.#header[4];
      if (length === 0) receive(channel, kind, EMPTY);
      else this.#begin(channel, kind, length);
    }
  }

  #begin(channel: number, kind: number, length: number): void {
    this.#channel = channel;
    this.#kind = kind;
    this.#payload = new Uint8Array(length);
    this.#payloadFill = 0;
  }
}

function checkedLength(length: number): number {
  if (length > MAX_FRAME) throw new CoreError("protocol", `core frame of ${length} bytes exceeds ${MAX_FRAME}`);
  return length;
}

/**
 * Splits a byte stream into `\n`-terminated lines (the terminator is dropped, empty lines are skipped). A line split
 * across reads is kept as parts and joined once, so work stays linear. Throws `CoreError("protocol")` when a line
 * exceeds `max` bytes.
 */
export class LineReader {
  readonly #max: number;
  #parts: Uint8Array[] = [];
  #partBytes = 0;

  constructor(max: number = MAX_LINE) {
    this.#max = max;
  }

  /** Bytes of the unterminated line held so far. */
  get pending(): number {
    return this.#partBytes;
  }

  /**
   * Feeds `chunk`, calling `receive` per complete line. Returns how many bytes of `chunk` were consumed: all of them,
   * unless `receive` returned `false`, which stops right after that line (the plain → framed switch after `hello`).
   */
  push(chunk: Uint8Array, receive: (line: Uint8Array) => boolean | void): number {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline < 0) break;
      const tail = chunk.subarray(start, newline);
      start = newline + 1;
      let line = tail;
      if (this.#partBytes > 0) {
        line = new Uint8Array(this.#partBytes + tail.length);
        let at = 0;
        for (const part of this.#parts) {
          line.set(part, at);
          at += part.length;
        }
        line.set(tail, at);
        this.#parts = [];
        this.#partBytes = 0;
      }
      if (line.length > this.#max) {
        throw new CoreError("protocol", `core line of ${line.length} bytes exceeds ${this.#max}`);
      }
      if (line.length > 0 && receive(line) === false) return start;
    }
    if (start < chunk.length) {
      this.#partBytes += chunk.length - start;
      if (this.#partBytes > this.#max) {
        throw new CoreError("protocol", `core line of over ${this.#max} bytes has no end`);
      }
      this.#parts.push(chunk.subarray(start));
    }
    return chunk.length;
  }
}
