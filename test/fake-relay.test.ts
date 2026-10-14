import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { startFakeRelay, type FakeRelay, type RelayStatus } from "./fake-relay";

const relay = startFakeRelay();
afterAll(() => relay.stop());
beforeEach(() => {
  delete relay.state.status;
  relay.state.handshakes.length = 0;
});

const live: WebSocket[] = [];
afterEach(() => {
  for (const ws of live.splice(0)) ws.close();
});

const http = (r: FakeRelay) => r.url.replace(/^ws/, "http");
const bytes = (b: Uint8Array | ArrayBuffer) => Array.from(new Uint8Array(b));

// A laptop: Bun's WebSocket client with the bearer in a header, as PLAN A4 requires of the real one.
function laptop(r: FakeRelay, o: { url?: string; headers?: Record<string, string> } = {}) {
  const ws = new WebSocket(o.url ?? r.url, { headers: o.headers ?? { Authorization: `Bearer ${r.token}` } });
  ws.binaryType = "arraybuffer";
  live.push(ws);
  const opened = new Promise<boolean>((done) => {
    ws.addEventListener("open", () => done(true));
    ws.addEventListener("close", () => done(false));
    ws.addEventListener("error", () => done(false));
  });
  const closed = new Promise<{ code: number; reason: string }>((done) =>
    ws.addEventListener("close", (e) => done({ code: e.code, reason: e.reason })),
  );
  const message = () =>
    new Promise<Uint8Array>((done) =>
      ws.addEventListener("message", (e) => done(new Uint8Array(e.data as ArrayBuffer)), { once: true }),
    );
  return { ws, opened, closed, message };
}

test("401s every bearer but its own, and reads neither a cookie nor a ?token=", async () => {
  const cases: Record<string, string>[] = [
    {},
    { Authorization: "Bearer" },
    { Authorization: `Bearer oly_${relay.token.slice(4)}` },
    { Authorization: "Bearer obm_someone_else" },
  ];
  for (const headers of cases) {
    const res = await fetch(http(relay), { headers });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  }

  // The real token, but in the two places §1.2 says are never read.
  const sneak = laptop(relay, {
    url: `${relay.url}?token=${relay.token}`,
    headers: { Cookie: `_olympus_session=${relay.token}` },
  });
  expect(await sneak.opened).toBe(false);
  const last = relay.state.handshakes.at(-1)!;
  expect(last.upgraded).toBe(false);
  expect(last.auth).toBeNull();
  expect(last.search).toBe(`?token=${relay.token}`); // seen and ignored, not merely absent
  expect(last.cookie).toContain(relay.token);
  expect(relay.state.handshakes.every((h) => !h.upgraded)).toBe(true);
});

test("injects each pre-upgrade status of §1.2, over a valid bearer, and upgrades once cleared", async () => {
  const codes: Record<RelayStatus, string> = {
    400: "bad_handshake",
    401: "unauthorized",
    404: "not_found",
    501: "no_hijack",
    502: "bad_gateway",
    503: "companion_unavailable",
  };
  for (const [status, code] of Object.entries(codes)) {
    relay.state.status = Number(status) as RelayStatus;
    const res = await fetch(http(relay), { headers: { Authorization: `Bearer ${relay.token}` } });
    expect(res.status).toBe(Number(status));
    expect(await res.json()).toEqual({ error: code });
    expect(await laptop(relay).opened).toBe(false); // a real handshake is refused too
  }
  expect(relay.state.handshakes.every((h) => !h.upgraded)).toBe(true);

  delete relay.state.status;
  expect(await laptop(relay).opened).toBe(true);
  expect(relay.state.handshakes.at(-1)).toMatchObject({ upgraded: true, cookie: null, search: "" });
});

test("404s another path, and 400s a request that is not a handshake", async () => {
  const auth = { Authorization: `Bearer ${relay.token}` };
  expect((await fetch(`${http(relay)}/../elsewhere`, { headers: auth })).status).toBe(404);
  expect((await fetch(http(relay), { headers: auth })).status).toBe(400); // no Upgrade: websocket
});

test("echoes bytes both ways through a workbench-opened stream, parsing none of them", async () => {
  const c = laptop(relay);
  expect(await c.opened).toBe(true);
  const l = await relay.laptop();

  // [u32 BE id 1][op 0 OPEN]["cdp"] — built here, because the double never reads a frame (§4).
  const open = new Uint8Array([0, 0, 0, 1, 0, 0x63, 0x64, 0x70]);
  const arrived = c.message();
  l.send(open);
  expect(bytes(await arrived)).toEqual(bytes(open));

  const data = new Uint8Array([0, 0, 0, 1, 1, 0xff, 0x00, 0x7f]);
  c.ws.send(data);
  expect(bytes(await l.next())).toEqual(bytes(data));
  expect(l.received.map(bytes)).toEqual([bytes(data)]);
});

test("closes on command with each code of §1.5", async () => {
  for (const code of [4401, 4409, 4410, 1009]) {
    const c = laptop(relay);
    expect(await c.opened).toBe(true);
    (await relay.laptop()).close(code, "commanded");
    expect(await c.closed).toEqual({ code, reason: "commanded" });
  }
});

test("drops the connection with no close frame, so the laptop sees 1006", async () => {
  const c = laptop(relay);
  expect(await c.opened).toBe(true);
  (await relay.laptop()).drop();
  expect((await c.closed).code).toBe(1006);
});

test("closes a text sender with 1003, and records nothing it sent", async () => {
  const c = laptop(relay);
  expect(await c.opened).toBe(true);
  const l = await relay.laptop();
  c.ws.send("a CDP message as text");
  expect((await c.closed).code).toBe(1003);
  expect(l.received).toEqual([]);
});

test("several doubles run at once, each with its own port, token and injected status", async () => {
  const other = startFakeRelay({ token: "obm_other", status: 502 });
  try {
    expect(other.url).not.toBe(relay.url);
    expect(other.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/v1\/browser\/relay$/);
    expect((await fetch(http(other), { headers: { Authorization: "Bearer obm_other" } })).status).toBe(502);

    delete other.state.status;
    expect(await laptop(other, { headers: { Authorization: `Bearer ${relay.token}` } }).opened).toBe(false);
    expect(await laptop(other).opened).toBe(true);
    expect(await laptop(relay).opened).toBe(true);
    expect(relay.state.handshakes.length).toBe(1); // the other double's traffic is not this one's
  } finally {
    other.stop();
  }
});
