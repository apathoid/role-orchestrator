/** @param {number} limit */
export function capturePrefix(limit) {
  const empty = Buffer.alloc(0);
  let buffer = empty;
  let length = 0;
  let receivedBytes = 0;
  const view = () => buffer.subarray(0, length);
  return {
    /** @param {Buffer} chunk */
    append(chunk) {
      receivedBytes += chunk.length;
      const count = Math.min(limit - length, chunk.length);
      if (count === 0) return;
      if (buffer === empty) buffer = Buffer.allocUnsafe(limit);
      chunk.copy(buffer, length, 0, count);
      length += count;
    },
    view,
    result: () => ({ bytes: Buffer.from(view()), receivedBytes, truncated: receivedBytes > length }),
  };
}
