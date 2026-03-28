/**
 * Change Store — In-Memory Storage for Proposed Changes
 * CLA-1797 / FAVRO-035: Propose & Execute Change System
 *
 * Stores proposed change entries with a 10-minute TTL.
 * Auto-deletes expired entries on retrieval.
 */

export interface ApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  data?: unknown;
  description: string;
}

export interface Change {
  changeId: string;
  boardName: string;
  actionText: string;
  apiCalls: ApiCall[];
  status: 'proposed' | 'executed' | 'failed';
  expiresAt: number;
  error?: string;
}

/** 10 minutes in milliseconds */
const TTL_MS = 10 * 60 * 1000;

class ChangeStore {
  private store = new Map<string, Change>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Store a proposed change with a 10-minute TTL.
   */
  storeChange(changeId: string, change: Change): void {
    // Clear any existing timer for this ID
    const existing = this.timers.get(changeId);
    if (existing) clearTimeout(existing);

    this.store.set(changeId, {
      ...change,
      expiresAt: change.expiresAt ?? Date.now() + TTL_MS,
    });

    // Auto-delete after TTL
    const timer = setTimeout(() => {
      this.store.delete(changeId);
      this.timers.delete(changeId);
    }, TTL_MS);

    // Allow the Node.js process to exit even with pending timers
    if (timer.unref) timer.unref();
    this.timers.set(changeId, timer);
  }

  /**
   * Retrieve a stored change. Returns null if not found or expired.
   */
  getChange(changeId: string): Change | null {
    const change = this.store.get(changeId);
    if (!change) return null;

    // Check expiry
    if (Date.now() > change.expiresAt) {
      this.removeChange(changeId);
      return null;
    }

    return change;
  }

  /**
   * Remove a change entry (called after execution).
   */
  removeChange(changeId: string): void {
    const timer = this.timers.get(changeId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(changeId);
    }
    this.store.delete(changeId);
  }

  /**
   * Clear all stored changes (useful for testing).
   */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.store.clear();
  }

  /**
   * Number of currently stored (non-expired) changes.
   */
  size(): number {
    return this.store.size;
  }
}

// Singleton instance
export const changeStore = new ChangeStore();
export { ChangeStore, TTL_MS };
