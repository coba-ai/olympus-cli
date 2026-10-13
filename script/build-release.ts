export const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
export type Target = (typeof TARGETS)[number];

/** argv after `bun` for one target, derived from package.json's scripts.build. */
export function releaseArgs(build: string, target: Target | string, version?: string): string[] {
  const parts = build.trim().split(/\s+/);
  if (parts[0] !== "bun") throw new Error("build script must start with `bun`");
  const args = parts.slice(1);
  const idx = args.flatMap((a, i) => (a === "--outfile" ? [i] : []));
  const at = idx[0];
  if (idx.length !== 1 || at === undefined || args[at + 1] !== "dist/olympus") {
    throw new Error("build script must contain exactly one `--outfile dist/olympus`");
  }
  args[at + 1] = `dist/olympus-${target}`;
  return [...args, `--target=bun-${target}`, ...(version === undefined ? [] : ["--define", `OLYMPUS_VERSION=${JSON.stringify(version)}`])];
}

/** The version a tag build reports: `v1.2.3` -> `1.2.3`. Anything but a tag build gets undefined (the binary says "dev"). */
export function releaseVersion(env: Record<string, string | undefined>): string | undefined {
  if (env.GITHUB_REF_TYPE !== "tag") return undefined;
  const m = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(env.GITHUB_REF_NAME ?? "");
  if (!m) throw new Error(`tag "${env.GITHUB_REF_NAME}" is not vMAJOR.MINOR.PATCH`);
  return m[1];
}

if (import.meta.main) {
  const version = releaseVersion(process.env);
  const pkg = await Bun.file("package.json").json();
  const sums: string[] = [];
  for (const target of TARGETS) {
    const p = Bun.spawnSync([process.execPath, ...releaseArgs(pkg.scripts.build, target, version)], {
      stdout: "inherit",
      stderr: "inherit",
    });
    if (p.exitCode !== 0) {
      console.error(`build failed for ${target}`);
      process.exit(p.exitCode || 1);
    }
    const name = `olympus-${target}`;
    const h = new Bun.CryptoHasher("sha256");
    h.update(await Bun.file(`dist/${name}`).arrayBuffer());
    sums.push(`${h.digest("hex")}  ${name}`);
  }
  await Bun.write("dist/SHA256SUMS", sums.join("\n") + "\n");
}
