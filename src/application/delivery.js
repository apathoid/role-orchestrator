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
  let bytes = 0, inFlight = 0, running = false, closed = false, finishing = false, dropped = 0, flightCount = 0, failed = 0;
  const drained = Promise.withResolvers();
  /** @type {Promise<number> | undefined} */
  let finishResult;
  function remaining() { return queue.length + dropped + flightCount + failed; }
  function close() {
    if (closed) return;
    closed = true;
    const omitted = remaining();
    queue.length = 0; bytes = 0; gap = undefined; dropped = 0;
    drained.resolve(omitted);
  }
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
        flightCount = entry ? 1 : dropped;
        if (!entry) { gap = undefined; dropped = 0; }
        inFlight = 1;
        try { await listener(notice); } catch { failed += flightCount; /* Best effort, independent of execution. */ }
        inFlight = 0; flightCount = 0;
        if (entry && !closed) bytes -= entry.bytes;
      }
    } finally {
      running = false;
      if (!closed && (queue.length || gap !== undefined)) wake();
      else if (finishing) close();
    }
  }
  return {
    /** @param {T} value @param {number} size */
    enqueue(value, size) {
      if (closed || finishing) return;
      if (gap !== undefined || queue.length + inFlight >= maxEvents - 1 || size > maxBytes - bytes) {
        gap = gapFor(gap, value); dropped++;
      } else {
        queue.push({ value, bytes: size });
        bytes += size;
      }
      wake();
    },
    close,
    /** Stop accepting new notices, allow the queued prefix/gap to drain.
     * The caller is a presentation transport, never the execution coordinator.
     * Returns the number of notices not confirmed delivered (callback failure or finish deadline).
     * @param {number} [timeoutMs]
     */
    finish(timeoutMs = 250) {
      if (finishResult) return finishResult;
      finishing = true;
      if (!running && !queue.length && gap === undefined) close();
      else wake();
      const timer = setTimeout(close, timeoutMs);
      finishResult = drained.promise.then(omitted => { clearTimeout(timer); return omitted; });
      return finishResult;
    },
  };
}
