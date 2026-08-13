/**
 * Read a newline-delimited JSON stream, one parsed object at a time.
 *
 * NDJSON rather than SSE: SSE buys named events and automatic reconnection, and reconnection is
 * actively wrong here — the run is bound to this request, so there is nothing to reconnect to.
 */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      /**
       * `stream: true` is load-bearing. A multi-byte UTF-8 character — any smart quote in a gate
       * rejection reason — can straddle a chunk boundary, and decoding without it yields a
       * replacement character in the middle of the JSON and a parse error.
       */
      buf += dec.decode(value, { stream: !done });

      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as T;
      }
      if (done) break;
    }
    // Bytes left over with no terminating newline mean the connection died mid-event.
    if (buf.trim()) throw new Error('The connection ended in the middle of an event.');
  } finally {
    reader.cancel().catch(() => {});
  }
}
