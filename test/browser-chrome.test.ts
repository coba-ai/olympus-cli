import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeFlags,
  discoverChrome,
  launchChrome,
  MAC_CHROME_PATHS,
  PROXY_SCHEME,
  type ChromeProcess,
} from "../src/browser-chrome";
import { CliError, type Io } from "../src/core";

// Nothing in this file launches a browser: `spawn` is the injected seam and the profile directory is
// one the test makes and writes DevToolsActivePort into itself, so the real port read runs for real.
const made: string[] = [];
const tmp = async (prefix: string) => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
afterAll(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
});

type TestIo = Io & { e: string[]; sleeps: number };
const makeIo = (env: Record<string, string | undefined> = {}): TestIo => {
  const e: string[] = [];
  const io: TestIo = {
    env,
    home: "/nonexistent",
    stdin: async () => "",
    out: (s) => {
      throw new Error(`nothing here writes to stdout: ${s}`);
    },
    err: (s) => e.push(s),
    e,
    sleeps: 0,
    sleep: async () => void io.sleeps++,
  };
  return io;
};

type FakeProc = ChromeProcess & { exit: () => void; kills: number };
const fakeProc = (): FakeProc => {
  let done!: () => void;
  const exited = new Promise<void>((res) => (done = res));
  const p: FakeProc = { exited, kills: 0, exit: () => done(), kill: () => (p.kills++, done()) };
  return p;
};

const thrown = async (p: Promise<unknown>): Promise<CliError> => {
  try {
    await p;
  } catch (e) {
    return e as CliError;
  }
  throw new Error("did not throw");
};

const BIN = "/fake/bin/chromium";
// One launch against a profile dir the test owns. `argv` is what the browser would have been given.
async function launch(o: { io?: TestIo; profileDir: string; socksPort?: number; proc?: FakeProc }) {
  const proc = o.proc ?? fakeProc();
  const argv: string[][] = [];
  const io = o.io ?? makeIo({ OLYMPUS_CHROME: BIN });
  const chrome = launchChrome(io, { socksPort: o.socksPort ?? 1080 }, {
    spawn: (a) => (argv.push(a), proc),
    mkProfile: async () => o.profileDir,
  });
  return { io, proc, argv, chrome };
}
const port = async (profileDir: string, text: string) => writeFile(join(profileDir, "DevToolsActivePort"), text);

describe("A10 Chromium launch", () => {
  test("assembles the flags exactly, with the SOCKS port as a parameter", () => {
    expect(chromeFlags({ profileDir: "/tmp/olympus-browser-abc", socksPort: 1080 })).toEqual([
      "--user-data-dir=/tmp/olympus-browser-abc",
      "--remote-debugging-port=0",
      "--proxy-server=socks5://127.0.0.1:1080",
      "--proxy-bypass-list=<-loopback>",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ]);
    expect(chromeFlags({ profileDir: "/p", socksPort: 42123 })).toContain(`--proxy-server=${PROXY_SCHEME}://127.0.0.1:42123`);
    // The scheme is 2.3's to change if Chromium pre-resolves names; it is one constant, in one flag.
    expect(PROXY_SCHEME).toBe("socks5");
  });

  test("the profile is the fresh directory it was given, and the browser is the discovered binary", async () => {
    const profileDir = await tmp("oly-chrome-");
    await port(profileDir, "9311\n/devtools/browser/4f2e\n");
    const { argv, chrome } = await launch({ profileDir, socksPort: 1234 });
    const c = await chrome;

    expect(argv).toEqual([[BIN, ...chromeFlags({ profileDir, socksPort: 1234 })]]);
    expect(c.port).toBe(9311);
  });

  test("the port is the first line of DevToolsActivePort, written while we wait", async () => {
    const profileDir = await tmp("oly-chrome-");
    const io = makeIo({ OLYMPUS_CHROME: BIN });
    io.sleep = async () => {
      if (++io.sleeps === 3) await port(profileDir, "45678\n/devtools/browser/abc\n");
    };
    const c = await (await launch({ io, profileDir })).chrome;
    expect(c.port).toBe(45678);
    expect(io.sleeps).toBe(3);
  });

  test("the profile directory is removed when the browser exits", async () => {
    const profileDir = await tmp("oly-chrome-");
    await port(profileDir, "9311\n");
    const { proc, chrome } = await launch({ profileDir });
    const c = await chrome;
    expect(existsSync(profileDir)).toBe(true);

    proc.exit();
    await c.exited;
    expect(existsSync(profileDir)).toBe(false);
    expect(proc.kills).toBe(0);
  });

  test("close() kills the browser once however often it is called, and removes the profile", async () => {
    const profileDir = await tmp("oly-chrome-");
    await port(profileDir, "9311\n");
    const { proc, chrome } = await launch({ profileDir });
    const c = await chrome;

    await Promise.all([c.close(), c.close()]);
    await c.close();
    expect(proc.kills).toBe(1);
    expect(existsSync(profileDir)).toBe(false);
    await c.exited; // already settled, and never rejects
  });

  test("a browser that exits before it listens is exit 5, with the profile removed", async () => {
    const profileDir = await tmp("oly-chrome-");
    const proc = fakeProc();
    proc.exit();
    const { chrome, io } = await launch({ profileDir, proc });
    const e = await thrown(chrome);

    expect([e.exit, e.body.error.code]).toEqual([5, "chrome_failed"]);
    expect(e.message).toContain(BIN);
    expect(e.message).toContain("exited before it was listening");
    expect(existsSync(profileDir)).toBe(false);
    expect(io.sleeps).toBe(0); // it gave up on the exit, not on the clock
  });

  test("a browser that never writes a readable port is killed and is exit 5", async () => {
    const profileDir = await tmp("oly-chrome-");
    await port(profileDir, "not a port\n");
    const { proc, chrome, io } = await launch({ profileDir });
    const e = await thrown(chrome);

    expect([e.exit, e.body.error.code]).toEqual([5, "chrome_failed"]);
    expect(e.message).toContain("did not report a debugging port");
    expect(proc.kills).toBe(1);
    expect(io.sleeps).toBe(99);
    expect(existsSync(profileDir)).toBe(false);
  });

  test("a spawn that throws names the binary and leaves no profile behind", async () => {
    const profileDir = await tmp("oly-chrome-");
    const io = makeIo({ OLYMPUS_CHROME: BIN });
    const e = await thrown(
      launchChrome(io, { socksPort: 1080 }, {
        spawn: () => {
          throw Object.assign(new Error("no such file"), { code: "ENOENT" });
        },
        mkProfile: async () => profileDir,
      }),
    );

    expect([e.exit, e.body.error.code]).toEqual([5, "chrome_failed"]);
    expect(e.message).toContain(BIN);
    expect(e.message).toContain("ENOENT");
    expect(existsSync(profileDir)).toBe(false);
  });

  test("nothing is spawned and no profile is made when no browser is found", async () => {
    const io = makeIo({ PATH: await tmp("oly-empty-") });
    let spawned = 0;
    const e = await thrown(
      launchChrome(io, { socksPort: 1080 }, {
        spawn: () => (spawned++, fakeProc()),
        mkProfile: async () => {
          throw new Error("the profile must not be created before the browser is found");
        },
      }),
    );
    expect([e.exit, e.body.error.code]).toEqual([1, "usage"]);
    expect(spawned).toBe(0);
  });
});

describe("Assumption 3 discovery", () => {
  test("$OLYMPUS_CHROME wins and is taken verbatim", async () => {
    const dir = await tmp("oly-path-");
    await exe(dir, "chromium");
    expect(discoverChrome(makeIo({ OLYMPUS_CHROME: "  /opt/my/chrome  ", PATH: dir }))).toBe("/opt/my/chrome");
    // Blank is unset, as everywhere else in this CLI.
    expect(discoverChrome(makeIo({ OLYMPUS_CHROME: "   ", PATH: dir }))).toBe(join(dir, "chromium"));
  });

  test("PATH is searched in Assumption 3's order", async () => {
    const dir = await tmp("oly-path-");
    for (const name of ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"]) {
      await exe(dir, name);
      expect(discoverChrome(makeIo({ PATH: dir }))).toBe(join(dir, name));
      await rm(join(dir, name));
    }
  });

  test("a file on PATH that is not executable is not a browser", async () => {
    const dir = await tmp("oly-path-");
    await writeFile(join(dir, "chromium"), "");
    await chmod(join(dir, "chromium"), 0o644);
    expect(() => discoverChrome(makeIo({ PATH: dir }))).toThrow(/OLYMPUS_CHROME/);
  });

  test("none found is exit 1 naming OLYMPUS_CHROME, and an unset PATH is not the process PATH", async () => {
    for (const env of [{ PATH: await tmp("oly-empty-") }, {}]) {
      const e = await thrown(Promise.resolve().then(() => discoverChrome(makeIo(env))));
      expect([e.exit, e.body.error.code]).toEqual([1, "usage"]);
      expect(e.message).toContain("OLYMPUS_CHROME");
    }
  });

  test("the macOS fallbacks are the two standard install paths", () => {
    // The darwin gate itself is not exercised here: `process.platform` is not a seam.
    expect(MAC_CHROME_PATHS).toEqual([
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
  });
});

async function exe(dir: string, name: string) {
  const p = join(dir, name);
  await writeFile(p, "#!/bin/sh\nexit 0\n");
  await chmod(p, 0o755);
  return p;
}
