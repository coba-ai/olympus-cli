import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS, releaseArgs } from "../script/build-release";

const build: string = (await Bun.file("package.json").json()).scripts.build;

describe("releaseArgs", () => {
  test("keeps every flag, sets target and outfile for all targets", () => {
    const noCompile = build.split(/\s+/).filter((a) => a.startsWith("--no-compile-"));
    expect(noCompile.length).toBeGreaterThan(0);
    expect(TARGETS.length).toBe(4);
    for (const t of TARGETS) {
      const args = releaseArgs(build, t);
      for (const f of noCompile) expect(args).toContain(f);
      expect(args).toContain(`--target=bun-${t}`);
      expect(args[args.indexOf("--outfile") + 1]).toBe(`dist/olympus-${t}`);
      expect(args.filter((a) => a === "--outfile").length).toBe(1);
      expect(args).toContain("--compile");
      expect(args).toContain("src/cli.ts");
    }
  });
  test("throws on 0 or 2 --outfile", () => {
    expect(() => releaseArgs("bun build src/cli.ts", "linux-x64")).toThrow();
    expect(() => releaseArgs(`${build} --outfile dist/olympus`, "linux-x64")).toThrow();
  });
});

const mk = () => mkdtempSync(join(tmpdir(), "olyrel-"));
const sha = (b: string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

function setup(opts: { tamper?: boolean; uname?: string; noCurl?: boolean } = {}) {
  const root = mk();
  const bin = join(root, "bin");
  const fixtures = join(root, "fixtures");
  mkdirSync(bin);
  mkdirSync(fixtures);
  const content = "#!/bin/sh\necho olympus\n";
  const a = "olympus-linux-x64";
  writeFileSync(join(fixtures, a), opts.tamper ? content + "evil" : content);
  const sums = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]
    .map((t) => `${t === "linux-x64" ? sha(content) : sha(t)}  olympus-${t}`)
    .join("\n");
  writeFileSync(join(fixtures, "SHA256SUMS"), sums + "\n");
  if (!opts.noCurl) {
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) o=$2; shift;; http*) u=$1;; esac; shift; done\necho "$u" >> "$FIXTURES/../urls"\ncp "$FIXTURES/\${u##*/}" "$o"\n`,
    );
    chmodSync(join(bin, "curl"), 0o755);
  }
  const u = opts.uname ?? "x86_64";
  writeFileSync(join(bin, "uname"), `#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo ${u}\n`);
  chmodSync(join(bin, "uname"), 0o755);
  const dir = join(root, "install");
  const home = join(root, "home");
  mkdirSync(home);
  // curl-less run: PATH is only the stub dir, holding symlinks to the utilities
  // install.sh uses (never curl), so a system curl cannot leak in.
  if (opts.noCurl) {
    for (const t of ["sh", "mktemp", "rm", "mkdir", "cp", "mv", "chmod", "grep", "cut", "cat", "sha256sum", "shasum"]) {
      const p = Bun.which(t);
      if (p) symlinkSync(p, join(bin, t));
    }
  }
  const path = opts.noCurl ? bin : `${bin}:${process.env.PATH}`;
  const run = (...args: string[]) =>
    Bun.spawnSync(["sh", "install.sh", ...args], {
      env: { PATH: path, HOME: home, OLYMPUS_INSTALL_DIR: dir, FIXTURES: fixtures },
      stdout: "pipe",
      stderr: "pipe",
    });
  const urls = () => readFileSync(join(root, "urls"), "utf8").trim().split("\n");
  return { run, dir, content, urls };
}

describe("install.sh", () => {
  test("good checksum installs 0755 with matching content", () => {
    const s = setup();
    const r = s.run();
    expect(r.exitCode).toBe(0);
    const f = join(s.dir, "olympus");
    expect(readFileSync(f, "utf8")).toBe(s.content);
    expect(statSync(f).mode & 0o777).toBe(0o755);
  });
  test("tampered binary is refused, nothing installed", () => {
    const s = setup({ tamper: true });
    const r = s.run();
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(s.dir, "olympus"))).toBe(false);
  });
  test("no curl on PATH exits 1 with the message", () => {
    const r = setup({ noCurl: true }).run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("olympus install needs curl");
  });
  test("downloads the latest release by default, a tag when given", () => {
    const s = setup();
    expect(s.run().exitCode).toBe(0);
    expect(s.urls()).toEqual([
      "https://github.com/coba-ai/olympus-cli/releases/latest/download/olympus-linux-x64",
      "https://github.com/coba-ai/olympus-cli/releases/latest/download/SHA256SUMS",
    ]);
    const t = setup();
    expect(t.run("v9.9.9").exitCode).toBe(0);
    expect(t.urls()[0]).toBe("https://github.com/coba-ai/olympus-cli/releases/download/v9.9.9/olympus-linux-x64");
  });
  test("unsupported arch refused", () => {
    const s = setup({ uname: "riscv64" });
    const r = s.run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("unsupported architecture");
    expect(existsSync(join(s.dir, "olympus"))).toBe(false);
  });
});
