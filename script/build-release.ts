export const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;
export type Target = (typeof TARGETS)[number];

/** argv after `bun` for one target, derived from package.json's scripts.build. */
export function releaseArgs(build: string, target: Target | string): string[] {
  const parts = build.trim().split(/\s+/);
  if (parts[0] !== "bun") throw new Error("build script must start with `bun`");
  const args = parts.slice(1);
  const idx = args.flatMap((a, i) => (a === "--outfile" ? [i] : []));
  const at = idx[0];
  if (idx.length !== 1 || at === undefined || args[at + 1] !== "dist/olympus") {
    throw new Error("build script must contain exactly one `--outfile dist/olympus`");
  }
  args[at + 1] = `dist/olympus-${target}`;
  return [...args, `--target=bun-${target}`];
}

if (import.meta.main) {
  const pkg = await Bun.file("package.json").json();
  const sums: string[] = [];
  for (const target of TARGETS) {
    const p = Bun.spawnSync([process.execPath, ...releaseArgs(pkg.scripts.build, target)], {
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
