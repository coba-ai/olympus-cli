import { describe, expect, test } from "bun:test";
import {
  ACK, cdpReader, chunkPayload, CLOSE, DATA, decodeFrame, encodeCdp, encodeFrame, isLaptopStream, isWorkbenchStream, MAX_PAYLOAD, OPEN,
} from "../src/browser-frame";

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const bytes = (...n: number[]) => new Uint8Array(n);
const thrown = (f: () => unknown): Error => {
  try {
    f();
  } catch (e) {
    return e as Error;
  }
  throw new Error("did not throw");
};
// A CDP message whose UTF-8 encoding is exactly `n` bytes (the padding is ASCII, one byte each).
const cdpMessage = (n: number) => {
  const shell = JSON.stringify({ id: 1, result: { data: "" } });
  return JSON.stringify({ id: 1, result: { data: "x".repeat(n - shell.length) } });
};

describe("A1 frame codec", () => {
  test("ops are pinned 0 OPEN / 1 DATA / 2 CLOSE / 3 ACK (binding on the workbench bridge)", () => {
    expect([OPEN, DATA, CLOSE, ACK]).toEqual([0, 1, 2, 3]);
  });

  test("an ACK is a bare header: the stream id, op 3, and no payload", () => {
    expect(encodeFrame(2, ACK)).toEqual(bytes(0, 0, 0, 2, 3));
    const f = decodeFrame(encodeFrame(2, ACK));
    expect([f.id, f.op, f.payload.length]).toEqual([2, ACK, 0]);
  });

  test("the header is [u32 BE stream id][u8 op], 5 bytes", () => {
    expect(encodeFrame(0x01020304, DATA, bytes(9))).toEqual(bytes(1, 2, 3, 4, 1, 9));
    expect(encodeFrame(0, CLOSE)).toEqual(bytes(0, 0, 0, 0, 2));
  });

  test("round-trips id, op and payload", () => {
    const cases: [number, 0 | 1 | 2 | 3, Uint8Array][] = [
      [0, OPEN, ENC.encode("cdp")],
      [1, OPEN, ENC.encode("tcp:127.0.0.1:443")],
      [7, DATA, bytes(0, 255, 128, 0)],
      [0xffffffff, CLOSE, new Uint8Array(0)],
      [4, ACK, new Uint8Array(0)],
      [2, DATA, new Uint8Array(MAX_PAYLOAD).fill(0x5a)],
    ];
    for (const [id, op, payload] of cases) {
      const f = decodeFrame(encodeFrame(id, op, payload));
      expect([f.id, f.op]).toEqual([id, op]);
      expect(f.payload).toEqual(payload);
    }
  });

  test("an OPEN target is UTF-8, multi-byte included", () => {
    const f = decodeFrame(encodeFrame(4, OPEN, ENC.encode("tcp:xn--caf-dma.example:443")));
    expect(DEC.decode(f.payload)).toBe("tcp:xn--caf-dma.example:443");
  });

  test("refuses a payload over 256 KiB on encode, and that cap keeps a frame inside the hub's 1 MiB limit", () => {
    expect(encodeFrame(2, DATA, new Uint8Array(MAX_PAYLOAD)).length).toBe(MAX_PAYLOAD + 5);
    const e = thrown(() => encodeFrame(2, DATA, new Uint8Array(MAX_PAYLOAD + 1)));
    expect(e.message).toContain(String(MAX_PAYLOAD + 1));
    expect(MAX_PAYLOAD + 5).toBeLessThan(1024 * 1024);
  });

  // The inbound direction is the one the untrusted peer writes (§3), so it gets the same cap.
  test("refuses an oversize payload on decode too, exactly where encode refuses it", () => {
    const over = new Uint8Array(5 + MAX_PAYLOAD + 1);
    expect(thrown(() => decodeFrame(over)).message).toContain(String(MAX_PAYLOAD + 1));
    expect(decodeFrame(new Uint8Array(5 + MAX_PAYLOAD)).payload.length).toBe(MAX_PAYLOAD);
  });

  test("a truncated buffer is an error, never a partial frame", () => {
    for (let n = 0; n < 5; n++) expect(thrown(() => decodeFrame(new Uint8Array(n))).message).toContain(`is ${n} bytes`);
    const empty = decodeFrame(bytes(0, 0, 0, 3, 2)); // 5 bytes is whole: a CLOSE with no payload
    expect([empty.id, empty.op, empty.payload.length]).toEqual([3, CLOSE, 0]);
  });

  test("an op §4 does not define is an error, not silently DATA", () => {
    for (const op of [4, 255]) expect(thrown(() => decodeFrame(bytes(0, 0, 0, 1, op, 7))).message).toContain(`op ${op}`);
  });

  test("odd ids are the workbench's, even ids the laptop's", () => {
    for (const id of [1, 3, 0xffffffff]) expect([isWorkbenchStream(id), isLaptopStream(id)]).toEqual([true, false]);
    for (const id of [0, 2, 0xfffffffe]) expect([isWorkbenchStream(id), isLaptopStream(id)]).toEqual([false, true]);
  });
});

describe("A1 cdp length prefix", () => {
  test("prefixes the BYTE length, not the character count", () => {
    const framed = encodeCdp('{"t":"é"}');
    expect(framed.subarray(0, 4)).toEqual(bytes(0, 0, 0, 10)); // 9 characters, 10 bytes
    expect(framed.length).toBe(14);
    expect(cdpReader().push(framed)).toEqual(['{"t":"é"}']);
  });

  test("a 1 MiB CDP message fragments into 4 DATA frames and reassembles byte-identical", () => {
    const message = cdpMessage(1024 * 1024 - 4); // 1 MiB on the wire once the 4-byte prefix is on
    const chunks = chunkPayload(encodeCdp(message));
    expect(chunks.map((c) => c.length)).toEqual([MAX_PAYLOAD, MAX_PAYLOAD, MAX_PAYLOAD, MAX_PAYLOAD]);
    const r = cdpReader();
    const got = chunks.flatMap((c) => r.push(decodeFrame(encodeFrame(1, DATA, c)).payload));
    expect(got).toEqual([message]);
    expect(ENC.encode(got[0]!)).toEqual(ENC.encode(message));
  });

  test("one byte past a full frame takes a fifth one; an empty write sends nothing", () => {
    expect(chunkPayload(encodeCdp(cdpMessage(1024 * 1024 - 3))).length).toBe(5);
    expect(chunkPayload(new Uint8Array(0))).toEqual([]);
  });

  test("reads several messages out of one payload, and one message out of byte-sized dribs", () => {
    const r = cdpReader();
    const three = ['{"id":1}', '{"id":2}', '{"id":3}'];
    const joined = three.map(encodeCdp);
    const all = new Uint8Array(joined.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of joined) (all.set(p, at), (at += p.length));
    expect(r.push(all)).toEqual(three);

    const one = encodeCdp('{"method":"Page.loadEventFired"}');
    const out: string[] = [];
    for (const b of one) out.push(...r.push(bytes(b)));
    expect(out).toEqual(['{"method":"Page.loadEventFired"}']);
  });

  test("a fragment arriving on a closed stream is dropped, not buffered", () => {
    const framed = encodeCdp('{"id":9}');
    const r = cdpReader();
    expect(r.push(framed.subarray(0, 6))).toEqual([]);
    r.close();
    expect(r.push(framed.subarray(6))).toEqual([]);
    expect(r.push(encodeCdp('{"id":10}'))).toEqual([]); // nothing resumes it, and the tail is gone
  });

  // `held` is what a ceiling may be counted in, and the two ways the untrusted side gets it wrong.
  test("held is wire bytes; an oversize declaration throws before its body is buffered, and invalid UTF-8 throws", () => {
    const r = cdpReader(1024);
    expect(r.held).toBe(0);
    r.push(encodeCdp('{"id":1}').subarray(0, 7)); // one byte short of whole
    expect(r.held).toBe(7);
    expect(r.push(encodeCdp('{"id":1}').subarray(7))).toEqual(['{"id":1}']);
    expect(r.held).toBe(0);

    // Declared 2048, limit 1024: refused on the prefix alone, with no body behind it at all.
    const over = new Uint8Array(4);
    new DataView(over.buffer).setUint32(0, 2048);
    expect(thrown(() => r.push(over)).message).toContain("the limit is 1024");
    expect(r.held).toBe(4); // the prefix, and nothing it declared

    // A completed message whose bytes are not UTF-8. Decoding them yields replacement characters
    // three bytes each, which is the arithmetic a decode-derived count was fooled by.
    const bad = cdpReader();
    const body = new Uint8Array(4 + 8).fill(0xff);
    new DataView(body.buffer).setUint32(0, 8);
    expect(thrown(() => bad.push(body)).message).toContain("not valid UTF-8");
    expect(ENC.encode("\uFFFD").length).toBe(3); // the receipt for "three bytes each"
  });

  // The byte budgets alone do not bound the OBJECTS the tail is held in: one retained typed array
  // and one list entry per arriving fragment let a peer sending one-byte DATA payloads hold
  // millions of both while `held` stayed well inside its ceiling. Small fragments are coalesced
  // into blocks now, so the object count is budgeted by the same bytes.
  test("many tiny fragments are coalesced, so the tail's block count stays bounded", () => {
    const r = cdpReader(1024 * 1024);
    const message = cdpMessage(256 * 1024 - 4);
    const framed = encodeCdp(message); // 256 KiB on the wire
    for (let i = 0; i < framed.length - 1; i++) r.push(framed.subarray(i, i + 1));

    expect(r.held).toBe(framed.length - 1);
    // 262 143 one-byte fragments. All-small input fills its blocks end to end, so the bound is one
    // block per 64 KiB held plus the one being filled — four here, not a quarter of a million.
    expect(r.buffers).toBeLessThanOrEqual(1 + r.held / (64 * 1024));
    expect(r.buffers).toBeGreaterThan(0);

    // And they still reassemble byte-identically, consumed by index rather than by shifting.
    expect(r.push(framed.subarray(framed.length - 1))).toEqual([message]);
    expect([r.held, r.buffers]).toEqual([0, 0]);
  });

  test("a fragment of a block or more is its own block, so a big one is still held by reference", () => {
    const r = cdpReader();
    r.push(new Uint8Array(4)); // a prefix declaring 0 bytes completes at once; nothing is held
    expect(r.buffers).toBe(0);
    const big = encodeCdp(cdpMessage(512 * 1024));
    r.push(big.subarray(0, 128 * 1024));
    r.push(big.subarray(128 * 1024, 128 * 1024 + 10));
    expect(r.buffers).toBe(2); // the big one, then the block the ten bytes went into
    r.close();
    expect([r.held, r.buffers]).toEqual([0, 0]);
  });
});
