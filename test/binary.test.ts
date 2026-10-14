import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAIR_CODE, startFake, TOKENS } from "./fake-api";
import { RELAY_PATH, startFakeRelay } from "./fake-relay";

const fake = startFake();
const tmp = await mkdtemp(join(tmpdir(), "oly-bin-"));
afterAll(async () => { fake.stop(); await rm(tmp, { recursive: true, force: true }); });

const CLI = join(import.meta.dir, "../src/cli.ts");
// A path that cannot run, so discoverChrome succeeds without a browser on the machine.
const browserEnv = (home: string) => ({ PATH: process.env.PATH!, HOME: home, OLYMPUS_CHROME: "/nonexistent/chromium" });
const until = async (p: () => boolean, what: string) => {
  for (let i = 0; i < 5000 && !p(); i++) await Bun.sleep(1);
  if (!p()) throw new Error(`timed out waiting for ${what}`);
};
const browserFile = (home: string) => join(home, ".config/olympus/browser.json");

// B9: the compiled binary must not autoload .env from its cwd.
test("binary ignores cwd .env, honours real env", async () => {
  const bin = join(tmp, "olympus");
  const root = join(import.meta.dir, "..");
  const build: string = (await Bun.file(join(root, "package.json")).json()).scripts.build;
  const cmd = build.replace("dist/olympus", bin).split(/\s+/);
  expect(cmd[0]).toBe("bun");
  const b = Bun.spawnSync([process.execPath, ...cmd.slice(1)], { cwd: root });
  expect(b.exitCode).toBe(0);
  await writeFile(join(tmp, ".env"), `OLYMPUS_API_KEY=${TOKENS.owner}\n`);
  const spawn = async (env: Record<string, string>) => {
    const p = Bun.spawn([bin, "whoami", "--json"], { cwd: tmp, env: { PATH: process.env.PATH!, HOME: tmp, OLYMPUS_HOST: fake.url, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: await p.exited, out: await new Response(p.stdout).text() };
  };
  expect((await spawn({})).code).toBe(2);
  const ok = await spawn({ OLYMPUS_API_KEY: TOKENS.owner });
  expect(ok.code).toBe(0);
  expect(JSON.parse(ok.out).data.user.email).toBeString();
  // AC12: piped human output of the compiled binary is exact bytes (also proves node:http works under --compile).
  const l = Bun.spawn([bin, "org", "list"], { cwd: tmp, env: { PATH: process.env.PATH!, HOME: tmp, OLYMPUS_HOST: fake.url, OLYMPUS_API_KEY: TOKENS.multi }, stdout: "pipe", stderr: "pipe" });
  expect(await l.exited).toBe(0);
  expect(await new Response(l.stdout).text()).toBe("acme\tAcme\toperator\nbeta\tBeta\toperator\n");
}, 60_000);

// C2: Ctrl-C while polling exits 130 promptly and writes nothing.
test("login SIGINT exits 130 without credentials", async () => {
  fake.state.device = { script: [], interval: 5 };
  const home = await mkdtemp(join(tmp, "home-"));
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "login", "--no-browser", "--host", fake.url], {
    env: { PATH: process.env.PATH!, HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  let err = "";
  let seen!: () => void;
  const ready = new Promise<void>((r) => (seen = r));
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of p.stderr) { err += dec.decode(chunk); if (err.includes("ABCD-EFGH")) seen(); }
  })();
  await ready;
  const t0 = Date.now();
  p.kill("SIGINT");
  expect(await p.exited).toBe(130);
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(await Bun.file(join(home, ".config/olympus/credentials.json")).exists()).toBe(false);
}, 20_000);

// A11/C19: the in-process tests abort an AbortController; only a real process proves that the SIGINT
// listener cli.ts installs reaches an attach that is sitting on a live relay socket.
test("browser attach SIGINT exits 130 while attached", async () => {
  const relay = startFakeRelay({ token: "obm_fake_binary_test_token" });
  const host = relay.url.replace(/^ws/, "http").replace(RELAY_PATH, "");
  const home = await mkdtemp(join(tmp, "home-"));
  await mkdir(join(home, ".config/olympus"), { recursive: true, mode: 0o700 });
  await writeFile(browserFile(home), JSON.stringify({ machines: { [host]: { machine_id: "bm_binarytest", token: relay.token, name: "laptop" } } }), { mode: 0o600 });

  const p = Bun.spawn(["bun", CLI, "browser", "attach", "--host", host], { env: browserEnv(home), stdout: "pipe", stderr: "pipe" });
  let err = "";
  void (async () => {
    const dec = new TextDecoder();
    for await (const chunk of p.stderr) err += dec.decode(chunk);
  })();
  try {
    await until(() => err.includes("Attached"), "the attached line");
    const t0 = Date.now();
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
    expect(Date.now() - t0).toBeLessThan(1500);
  } finally {
    p.kill();
    relay.stop();
  }
}, 20_000);

// Finding 2: the pair request is the one window where a late success could still write a credential.
test("browser attach SIGINT during a pending pair request exits 130 and writes nothing", async () => {
  const home = await mkdtemp(join(tmp, "home-"));
  const pairs = () => fake.state.requests.filter((r) => r.path === "/api/v1/browser/pair").length;
  const before = pairs();
  // Answers a valid 201, but only after the SIGINT below: a cancelled pairing must not store it.
  fake.state.next = { status: 201, delayMs: 2000, body: { data: { token: "obm_fake_late_token", machine_id: "bm_latetoken", relay_url: `${fake.url.replace(/^http/, "ws")}/api/v1/browser/relay` } } };

  const p = Bun.spawn(["bun", CLI, "browser", "attach", PAIR_CODE, "--host", fake.url], { env: browserEnv(home), stdout: "pipe", stderr: "pipe" });
  try {
    await until(() => pairs() > before, "the pair request");
    const t0 = Date.now();
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await Bun.file(browserFile(home)).exists()).toBe(false);
  } finally {
    p.kill();
  }
}, 20_000);
