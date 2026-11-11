// Ledger storage. Upstash Redis (REST) when configured, otherwise a local ./runs directory
// (CLI) or process memory (web, ephemeral, and the UI says so).
import type { Position } from "./policy";
import type { Receipt } from "./receipt";

export interface IndexEntry {
  id: string;
  at: string;
  headline: string;
  hash: string;
  pick: string | null;
}

export interface LedgerState {
  positions: Position[];
  index: IndexEntry[]; // newest first
  head: string | null;
  realized_pnl_usd: number;
}

export interface Store {
  kind: "upstash" | "file" | "memory";
  load(): Promise<LedgerState>;
  save(r: Receipt, state: LedgerState): Promise<void>;
  receipt(id: string): Promise<Receipt | null>;
  lock(ttlSec: number): Promise<boolean>;
  unlock(): Promise<void>;
}

const EMPTY: LedgerState = { positions: [], index: [], head: null, realized_pnl_usd: 0 };
const PREFIX = "tenbin:v1:";

class UpstashStore implements Store {
  kind = "upstash" as const;
  constructor(private url: string, private token: string) {}
  private async cmd(...args: (string | number)[]): Promise<unknown> {
    const res = await fetch(this.url.replace(/\/+$/, ""), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    const body = (await res.json()) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`upstash: ${body.error ?? res.status}`);
    return body.result;
  }
  async load(): Promise<LedgerState> {
    const raw = (await this.cmd("GET", PREFIX + "state")) as string | null;
    return raw ? (JSON.parse(raw) as LedgerState) : structuredClone(EMPTY);
  }
  async save(r: Receipt, state: LedgerState) {
    await this.cmd("SET", PREFIX + "receipt:" + r.id, JSON.stringify(r));
    await this.cmd("SET", PREFIX + "state", JSON.stringify(state));
  }
  async receipt(id: string) {
    const raw = (await this.cmd("GET", PREFIX + "receipt:" + id)) as string | null;
    return raw ? (JSON.parse(raw) as Receipt) : null;
  }
  async lock(ttl: number) {
    return (await this.cmd("SET", PREFIX + "lock", Date.now(), "NX", "EX", ttl)) === "OK";
  }
  async unlock() {
    await this.cmd("DEL", PREFIX + "lock");
  }
}

class FileStore implements Store {
  kind = "file" as const;
  constructor(private dir: string) {}
  private async fs() {
    return await import("node:fs/promises");
  }
  async load() {
    const fs = await this.fs();
    try {
      return JSON.parse(await fs.readFile(`${this.dir}/state.json`, "utf8")) as LedgerState;
    } catch {
      return structuredClone(EMPTY);
    }
  }
  async save(r: Receipt, state: LedgerState) {
    const fs = await this.fs();
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(`${this.dir}/${r.id}.json`, JSON.stringify(r, null, 2));
    await fs.writeFile(`${this.dir}/state.json`, JSON.stringify(state, null, 2));
  }
  async receipt(id: string) {
    const fs = await this.fs();
    if (!/^[\w-]+$/.test(id)) return null;
    try {
      return JSON.parse(await fs.readFile(`${this.dir}/${id}.json`, "utf8")) as Receipt;
    } catch {
      return null;
    }
  }
  async lock() {
    return true;
  }
  async unlock() {}
}

const mem: { state: LedgerState; receipts: Map<string, Receipt>; locked: boolean } = { state: structuredClone(EMPTY), receipts: new Map(), locked: false };
class MemoryStore implements Store {
  kind = "memory" as const;
  async load() {
    return structuredClone(mem.state);
  }
  async save(r: Receipt, state: LedgerState) {
    mem.receipts.set(r.id, r);
    mem.state = structuredClone(state);
  }
  async receipt(id: string) {
    return mem.receipts.get(id) ?? null;
  }
  async lock() {
    if (mem.locked) return false;
    mem.locked = true;
    return true;
  }
  async unlock() {
    mem.locked = false;
  }
}

export function getStore(opts: { preferFile?: string } = {}): Store {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  if (opts.preferFile) return new FileStore(opts.preferFile);
  return new MemoryStore();
}
