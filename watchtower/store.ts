import { DatabaseSync } from "node:sqlite";
import type { WatchState } from "./core.ts";

/**
 * Watchtower persistence (built-in SQLite): which chat watches which multisig
 * or guard, the last status seen per proposal / action, and bot offsets.
 * One file, no server; `:memory:` in tests.
 */

export type TargetKind = "multisig" | "guard";
export interface Subscription {
  chat: string;
  target: string;
  kind: TargetKind;
}

export class WatchStore {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      create table if not exists subscriptions (chat text not null, target text not null, kind text not null, added_at integer not null, primary key (chat, target));
      create table if not exists items (target text not null, id text not null, status text not null, primary key (target, id));
      create table if not exists posture (target text primary key, level text not null);
      create table if not exists meta (key text primary key, value text not null);
    `);
  }

  subscribe(chat: string, target: string, kind: TargetKind): void {
    this.db.prepare("insert into subscriptions (chat, target, kind, added_at) values (?, ?, ?, ?) on conflict (chat, target) do update set kind = excluded.kind").run(chat, target, kind, Date.now());
  }

  unsubscribe(chat: string, target: string): boolean {
    return Number(this.db.prepare("delete from subscriptions where chat = ? and target = ?").run(chat, target).changes) > 0;
  }

  subscriptions(chat?: string): Subscription[] {
    const rows = chat ? this.db.prepare("select chat, target, kind from subscriptions where chat = ? order by added_at").all(chat) : this.db.prepare("select chat, target, kind from subscriptions order by added_at").all();
    return rows as unknown as Subscription[];
  }

  targets(): Array<{ target: string; kind: TargetKind }> {
    return this.db.prepare("select target, min(kind) as kind from subscriptions group by target").all() as unknown as Array<{ target: string; kind: TargetKind }>;
  }

  chatsFor(target: string): string[] {
    return (this.db.prepare("select chat from subscriptions where target = ?").all(target) as Array<{ chat: string }>).map((r) => r.chat);
  }

  hasBaseline(target: string): boolean {
    return this.db.prepare("select 1 from posture where target = ?").get(target) !== undefined;
  }

  state(): WatchState {
    const state: WatchState = { proposals: {}, posture: {} };
    for (const r of this.db.prepare("select target, id, status from items").all() as Array<{ target: string; id: string; status: string }>) {
      (state.proposals[r.target] ??= {})[r.id] = r.status;
    }
    for (const r of this.db.prepare("select target, level from posture").all() as Array<{ target: string; level: string }>) state.posture[r.target] = r.level;
    return state;
  }

  /** Persists what is now known about one target (all-or-nothing). */
  saveTarget(target: string, state: WatchState): void {
    const items = state.proposals[target] ?? {};
    this.db.exec("begin");
    try {
      const upsert = this.db.prepare("insert into items (target, id, status) values (?, ?, ?) on conflict (target, id) do update set status = excluded.status");
      for (const [id, status] of Object.entries(items)) upsert.run(target, id, status);
      const level = state.posture[target];
      if (level !== undefined) this.db.prepare("insert into posture (target, level) values (?, ?) on conflict (target) do update set level = excluded.level").run(target, level);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("select value from meta where key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
