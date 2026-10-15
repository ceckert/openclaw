import { EventEmitter } from "node:events";

export class FakeWebSocket extends EventEmitter<{
  open: [];
  message: [Buffer];
  pong: [Buffer];
  close: [number, Buffer];
  error: [unknown];
}> {
  send(_data: string): void {}
  ping(): void {}
  close(): void {}
  terminate(): void {
    this.emitClose(1000);
  }
  get openListenerCount(): number {
    return this.listenerCount("open");
  }
  emitOpen(): void {
    this.emit("open");
  }
  async emitMessage(payload: unknown): Promise<void> {
    const buffer = Buffer.from(JSON.stringify(payload), "utf8");
    await Promise.all(
      this.listeners("message").map((listener) => Promise.resolve(listener(buffer))),
    );
  }
  emitClose(code: number, reason = ""): void {
    this.emit("close", code, Buffer.from(reason, "utf8"));
  }
}
