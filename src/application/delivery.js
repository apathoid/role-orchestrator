/**
 * Bounded, ephemeral FIFO for a single consumer. One in-flight delivery
 * counts against the data budget; one separate slot is reserved for a gap.
 * Neither enqueue nor close waits for the consumer.
 * @template T
 * @template G
 * @param {(notice: T | G) => void | Promise<void>} listener
 * @param {(prior: G | undefined, dropped: T) => G} gapFor
 */
export function createBoundedDelivery(listener, gapFor) {
  const maxEvents = 128, maxBytes = 1024 * 1024;
  /** @type {{value: T, bytes: number}[]} */
  const queue = [];
  /** @type {G | undefined} */
  let gap;
  let bytes = 0, inFlight = 0, running = false, closed = false;
  function wake() {
    if (running || closed) return;
    running = true;
    queueMicrotask(() => { void drain(); });
  }
  async function drain() {
    try {
      while (!closed) {
        const entry = queue.shift();
        const notice = entry?.value ?? gap;
        if (notice === undefined) break;
        if (!entry) gap = undefined;
        inFlight = 1;
        try { await listener(notice); } catch { /* Best effort, independent of execution. */ }
        inFlight = 0;
        if (entry && !closed) bytes -= entry.bytes;
      }
    } finally {
      running = false;
      if (!closed && (queue.length || gap !== undefined)) wake();
    }
  }
  return {
    /** @param {T} value @param {number} size */
    enqueue(value, size) {
      if (closed) return;
      if (gap !== undefined || queue.length + inFlight >= maxEvents - 1 || size > maxBytes - bytes) {
        gap = gapFor(gap, value);
      } else {
        queue.push({ value, bytes: size });
        bytes += size;
      }
      wake();
    },
    close() {
      closed = true;
      queue.length = 0;
      bytes = 0;
      gap = undefined;
    },
  };
}
