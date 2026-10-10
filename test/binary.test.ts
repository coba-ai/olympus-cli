import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFake, TOKENS } from "./fake-api";

const fake = startFake();
const tmp = await mkdtemp(join(tmpdir(), "oly-bin-"));
afterAll(async () => { fake.stop(); await rm(tmp, { recursive: true, force: true }); });

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
