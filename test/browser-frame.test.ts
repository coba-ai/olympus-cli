import { describe, expect, test } from "bun:test";
import {
  cdpReader, chunkPayload, CLOSE, DATA, decodeFrame, encodeCdp, encodeFrame, isLaptopStream, isWorkbenchStream, MAX_PAYLOAD, OPEN,
  type CdpSend, type Stream, type StreamOpener,
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
  test("ops are pinned 0 OPEN / 1 DATA / 2 CLOSE (binding on the workbench bridge)", () => {
    expect([OPEN, DATA, CLOSE]).toEqual([0, 1, 2]);
  });

  test("the header is [u32 BE stream id][u8 op], 5 bytes", () => {
    expect(encodeFrame(0x01020304, DATA, bytes(9))).toEqual(bytes(1, 2, 3, 4, 1, 9));
    expect(encodeFrame(0, CLOSE)).toEqual(bytes(0, 0, 0, 0, 2));
  });

  test("round-trips id, op and payload", () => {
    const cases: [number, 0 | 1 | 2, Uint8Array][] = [
      [0, OPEN, ENC.encode("cdp")],
      [1, OPEN, ENC.encode("tcp:127.0.0.1:443")],
      [7, DATA, bytes(0, 255, 128, 0)],
      [0xffffffff, CLOSE, new Uint8Array(0)],
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

  test("a truncated buffer is an error, never a partial frame", () => {
    for (let n = 0; n < 5; n++) expect(thrown(() => decodeFrame(new Uint8Array(n))).message).toContain(`is ${n} bytes`);
    const empty = decodeFrame(bytes(0, 0, 0, 3, 2)); // 5 bytes is whole: a CLOSE with no payload
    expect([empty.id, empty.op, empty.payload.length]).toEqual([3, CLOSE, 0]);
  });

  test("an op §4 does not define is an error, not silently DATA", () => {
    for (const op of [3, 255]) expect(thrown(() => decodeFrame(bytes(0, 0, 0, 1, op, 7))).message).toContain(`op ${op}`);
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
});

describe("A1 seam types", () => {
  test("an opener allocates the even id; a CdpSend length-prefixes onto a reader", () => {
    const wire: Uint8Array[] = [];
    let last = 0;
    const open: StreamOpener = (target) => {
      const id = (last += 2);
      wire.push(encodeFrame(id, OPEN, ENC.encode(target)));
      return {
        write: (b) => void chunkPayload(b).forEach((c) => wire.push(encodeFrame(id, DATA, c))),
        close: () => void wire.push(encodeFrame(id, CLOSE)),
      };
    };
    const s: Stream = open("tcp:127.0.0.1:443");
    const seen: Uint8Array[] = [];
    s.onData = (b) => void seen.push(b);
    s.write(bytes(1, 2, 3));
    s.close();

    const frames = wire.map(decodeFrame);
    expect(frames.map((f) => f.op)).toEqual([OPEN, DATA, CLOSE]);
    expect(frames.every((f) => isLaptopStream(f.id))).toBe(true);
    expect(DEC.decode(frames[0]!.payload)).toBe("tcp:127.0.0.1:443");
    s.onData(frames[1]!.payload);
    expect(seen).toEqual([bytes(1, 2, 3)]);

    const r = cdpReader();
    const read: string[] = [];
    const send: CdpSend = (m) => void read.push(...r.push(encodeCdp(m)));
    send('{"id":1,"method":"Page.navigate"}');
    expect(read).toEqual(['{"id":1,"method":"Page.navigate"}']);
  });
});
