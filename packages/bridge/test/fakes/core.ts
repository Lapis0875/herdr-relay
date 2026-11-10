import type { CoreTransport } from "../../src/core/transport.ts";

const methods = [
  "hello",
  "rpc.discover",
  "doc.get",
  "terminal.list",
  "terminal.get",
  "events.subscribe",
  "terminal.attach",
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FakeOptions {
  version?: string;
  generation?: number;
  framed?: boolean;
  methods?: string[];
  described?: string[];
  chunks?: number;
  seq?: number;
  address?: string;
}

export interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** A deliberately independent wire encoder; it does not use the client's frame implementation. */
export function frame(channel: number, kind: number, payload = new Uint8Array()): Uint8Array {
  const result = new Uint8Array(9 + payload.length);
  const header = new DataView(result.buffer);
  header.setUint32(0, channel, true);
  header.setUint8(4, kind);
  header.setUint32(5, payload.length, true);
  result.set(payload, 9);
  return result;
}

/** In-memory hc connect peer, with recorded JSON-RPC calls and stream frames. */
export class FakeCore {
  readonly requests: Request[] = [];
  readonly frames: { channel: number; kind: number; payload: Uint8Array }[] = [];
  readonly transport: CoreTransport;
  readonly terminal: { address: string; state: string; cols: number; rows: number };
  readonly #options: FakeOptions;
  readonly #output: ReadableStreamDefaultController<Uint8Array>;
  readonly #settle: (reason: string) => void;
  #buffer = new Uint8Array(0);
  #framed = false;
  #closed = false;

  constructor(options: FakeOptions = {}) {
    this.#options = options;
    this.terminal = { address: options.address ?? "t1", state: "running", cols: 80, rows: 24 };
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
    });
    this.#output = output;
    const ended = Promise.withResolvers<string>();
    this.#settle = ended.resolve;
    this.transport = {
      readable,
      writable: new WritableStream<Uint8Array>({ write: (bytes) => this.#receive(bytes) }),
      closed: ended.promise,
      close: () => this.disconnect(),
    };
  }

  disconnect(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#output.close();
    } catch { /* client may already have cancelled */ }
    this.#settle("fake core disconnected");
  }

  send(bytes: Uint8Array): void {
    const size = this.#options.chunks ?? bytes.length;
    for (let offset = 0; offset < bytes.length && !this.#closed; offset += size) {
      this.#output.enqueue(bytes.slice(offset, offset + size));
    }
  }

  #receive(bytes: Uint8Array): void {
    const combined = new Uint8Array(this.#buffer.length + bytes.length);
    combined.set(this.#buffer);
    combined.set(bytes, this.#buffer.length);
    this.#buffer = combined;
    if (!this.#framed) {
      const end = this.#buffer.indexOf(10);
      if (end < 0) return;
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      this.#request(JSON.parse(decoder.decode(line)) as Request, true);
    }
    while (this.#framed && this.#buffer.length >= 9) {
      const header = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 9);
      const channel = header.getUint32(0, true);
      const kind = header.getUint8(4);
      const length = header.getUint32(5, true);
      if (this.#buffer.length < 9 + length) break;
      const payload = this.#buffer.slice(9, 9 + length);
      this.#buffer = this.#buffer.slice(9 + length);
      this.frames.push({ channel, kind, payload });
      if (channel === 0 && kind === 0) this.#request(JSON.parse(decoder.decode(payload)) as Request, false);
      else if (kind === 2) this.send(frame(channel, 2));
    }
  }

  #request(request: Request, plain: boolean): void {
    this.requests.push(request);
    const advertised = this.#options.methods ?? methods;
    let result: unknown;
    switch (request.method) {
      case "hello":
        result = {
          generation: this.#options.generation ?? 1,
          version: this.#options.version ?? "0.1.19",
          framed: this.#options.framed ?? true,
          methods: advertised,
          features: [],
          core: { id: "fake", name: "fake" },
        };
        break;
      case "rpc.discover":
        result = {
          openrpc: "1.3.2",
          info: { version: this.#options.version ?? "0.1.19" },
          methods: (this.#options.described ?? methods).map((name) => ({ name })),
        };
        break;
      case "events.subscribe":
        result = { seq: this.#options.seq ?? 1, terminals: [this.terminal], channel: 1 };
        break;
      case "terminal.get":
        result = this.terminal;
        break;
      case "terminal.list":
        result = { terminals: [this.terminal] };
        break;
      case "doc.get":
        result = { value: { spaces: [] }, version: 1 };
        break;
      case "terminal.attach":
        result = { channel: 2, terminal: this.terminal };
        break;
      default:
        throw new Error(`Unexpected fake core method: ${request.method}`);
    }
    const body = encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + (plain ? "\n" : ""));
    this.send(plain ? body : frame(0, 0, body));
    if (plain && this.#options.framed !== false) this.#framed = true;
  }
}
