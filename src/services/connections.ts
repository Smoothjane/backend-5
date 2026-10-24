/**
 * Bookkeeping for live sockets, kept separate from Socket.IO so it can be
 * tested directly. Each user may hold at most `maxPerUser` sockets; opening
 * one more evicts that user's oldest (typically a tab left open on another
 * device), so a long-running server cannot accumulate abandoned sockets.
 */
export interface Closable {
  id: string;
  disconnect(close?: boolean): unknown;
}

export class ConnectionRegistry<S extends Closable = Closable> {
  private byUser = new Map<string, S[]>();

  constructor(readonly maxPerUser = 5) {}

  /** Registers a socket and returns any sockets evicted to stay under the cap. */
  add(userId: string, socket: S): S[] {
    const list = this.byUser.get(userId) ?? [];
    list.push(socket);
    const evicted =
      list.length > this.maxPerUser ? list.splice(0, list.length - this.maxPerUser) : [];
    this.byUser.set(userId, list);
    for (const s of evicted) s.disconnect(true);
    return evicted;
  }

  remove(userId: string, socket: S): void {
    const list = this.byUser.get(userId);
    if (!list) return;
    const next = list.filter((s) => s.id !== socket.id);
    if (next.length) this.byUser.set(userId, next);
    else this.byUser.delete(userId);
  }

  count(userId?: string): number {
    if (userId) return this.byUser.get(userId)?.length ?? 0;
    let n = 0;
    for (const list of this.byUser.values()) n += list.length;
    return n;
  }

  users(): number {
    return this.byUser.size;
  }
}

/** Milliseconds until a JWT `exp` (seconds since epoch), floored at 0. */
export const msUntilExpiry = (exp: number | undefined, now = Date.now()): number | null =>
  exp ? Math.max(0, exp * 1000 - now) : null;
