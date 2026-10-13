import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseArgs, releaseVersion } from "../script/build-release";
import { run } from "../src/cli";

const build: string = (await Bun.file("package.json").json()).scripts.build;

// No host, no key, empty HOME, and an out/err that would show any request attempt: version needs none of it.
async function cli(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "", reads = 0;
  const code = await run(args, {
    env: {}, home, stdin: async () => { reads++; return ""; }, out: (s) => { out += s; }, err: (s) => { err += s; },
  });
  return { code, out, err, reads };
}

test("--version and version print the version without credentials", async () => {
  for (const args of [["--version"], ["version"]]) {
    expect(await cli(args)).toEqual({ code: 0, out: "olympus dev\n", err: "", reads: 0 });
  }
});

test("version --json", async () => {
  expect(await cli(["version", "--json"])).toMatchObject({ code: 0, out: '{"data":{"version":"dev"}}\n', err: "" });
});

test("version takes no arguments or flags", async () => {
  for (const args of [["version", "x"], ["version", "--tag", "a"], ["--version", "--json"], ["--version", "x"]]) {
    const r = await cli(args);
    expect([args.join(" "), r.code, r.out]).toEqual([args.join(" "), 1, ""]);
  }
});

test("releaseArgs adds the define only when given a version", () => {
  expect(releaseArgs(build, "linux-x64")).not.toContain("--define");
  const a = releaseArgs(build, "linux-x64", "1.2.3");
  expect(a.slice(-2)).toEqual(["--define", 'OLYMPUS_VERSION="1.2.3"']);
  expect(a.slice(0, -2)).toEqual(releaseArgs(build, "linux-x64"));
});

test("releaseVersion reads a version tag and nothing else", () => {
  const tag = (n: string) => ({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: n });
  expect(releaseVersion(tag("v0.7.0"))).toBe("0.7.0");
  expect(releaseVersion(tag("v1.2.3-rc.1"))).toBe("1.2.3-rc.1");
  for (const bad of ["0.7.0", "v1.2", "v1.2.3;x", "vx", ""]) expect(() => releaseVersion(tag(bad))).toThrow();
  expect(releaseVersion({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" })).toBeUndefined();
  expect(releaseVersion({})).toBeUndefined();
});

test("a compiled binary reports the injected version", async () => {
  const dir = await mkdtemp(join(tmpdir(), "olyver-"));
  const args = releaseArgs(build, "x", "9.9.9").filter((a) => !a.startsWith("--target="));
  args[args.indexOf("--outfile") + 1] = join(dir, "olympus");
  const b = Bun.spawnSync([process.execPath, ...args], { stdout: "pipe", stderr: "pipe" });
  expect(b.exitCode).toBe(0);
  const p = Bun.spawnSync([join(dir, "olympus"), "--version"], { env: { HOME: dir }, stdout: "pipe" });
  expect(p.stdout.toString()).toBe("olympus 9.9.9\n");
}, 60_000);
