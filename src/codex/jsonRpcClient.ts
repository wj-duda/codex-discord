import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  isJsonRpcFailure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  type JsonRpcFailure,
  type JsonRpcIncomingMessage,
  type JsonRpcRequest,
} from "../types/jsonrpc.js";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
}

export interface JsonRpcNotificationEvent {
  method: string;
  params: unknown;
}

export interface JsonRpcRequestEvent {
  id: number;
  method: string;
  params: unknown;
}

export class JsonRpcClient extends EventEmitter {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private readonly lineReader: readline.Interface;

  constructor(
    private readonly output: Writable,
    input: Readable,
  ) {
    super();
    this.lineReader = readline.createInterface({ input });
    this.lineReader.on("line", (line) => {
      void this.handleLine(line);
    });
    this.lineReader.on("close", () => {
      this.rejectPending(new Error("codex app-server closed the JSON-RPC stream"));
      this.emit("close");
    });
  }

  async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    await this.write(payload);

    return new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async respond(id: number, result: unknown): Promise<void> {
    await this.write({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  async respondError(id: number, code: number, message: string, data?: unknown): Promise<void> {
    await this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        data,
      },
    });
  }

  dispose(): void {
    this.lineReader.close();
    this.rejectPending(new Error("JSON-RPC client disposed"));
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: JsonRpcIncomingMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcIncomingMessage;
    } catch (error) {
      this.emit("error", new Error(`Invalid JSON-RPC payload: ${trimmed}`, { cause: error }));
      return;
    }

    if (isJsonRpcSuccess(message)) {
      this.resolvePending(message.id, message.result);
      return;
    }

    if (isJsonRpcFailure(message)) {
      this.rejectPendingById(message);
      return;
    }

    if (isJsonRpcRequest(message)) {
      this.emit("request", {
        id: message.id,
        method: message.method,
        params: message.params,
      } satisfies JsonRpcRequestEvent);
      return;
    }

    if (isJsonRpcNotification(message)) {
      this.emit("notification", {
        method: message.method,
        params: message.params,
      } satisfies JsonRpcNotificationEvent);
    }
  }

  private resolvePending(id: number, result: unknown): void {
    const request = this.pending.get(id);
    if (!request) {
      this.emit("error", new Error(`Received response for unknown request id ${id}`));
      return;
    }

    this.pending.delete(id);
    request.resolve(result);
  }

  private rejectPendingById(message: JsonRpcFailure): void {
    if (message.id === null) {
      this.emit("error", new Error(message.error.message));
      return;
    }

    const request = this.pending.get(message.id);
    if (!request) {
      this.emit("error", new Error(`Received error for unknown request id ${message.id}`));
      return;
    }

    this.pending.delete(message.id);
    request.reject(new Error(message.error.message));
  }

  private rejectPending(error: Error): void {
    for (const [id, request] of this.pending.entries()) {
      this.pending.delete(id);
      request.reject(error);
    }
  }

  private async write(payload: JsonRpcRequest | Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(payload)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.output.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
