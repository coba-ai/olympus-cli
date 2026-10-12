import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { seedCrm, startFake, TOKENS } from "./fake-api";

const fake = startFake();
afterAll(() => fake.stop());
const NOW = Date.parse("2026-10-12T14:00:00Z");
beforeEach(() => {
  fake.state.requests.length = 0;
  delete fake.state.next;
  delete fake.state.onRequest;
  fake.state.now = () => NOW;
  fake.state.crm = seedCrm();
});

async function cli(args: string[], o: { env?: Record<string, string>; tty?: boolean; stdin?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "", err = "", reads = 0;
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => { reads++; return o.stdin ?? ""; },
    out: (s) => { out += s; }, err: (s) => { err += s; }, now: () => NOW, tty: o.tty ?? false,
  });
  return { code, out, err, reads };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };

test("unknown or space-spelled subcommands exit 1 with no request", async () => {
  const cases = [
    ["crm", "pipeline", "nope"],
    ["crm", "task", "nope", "x"],
    ["crm", "person", "task add", "p", "T"],
    ["crm", "pipeline get", "p"],
    ["crm", "task", "done x"],
  ];
  for (const c of cases) {
    const r = await cli([...c, "--org", "acme"], { env: owner });
    expect([c.join(" "), r.code]).toEqual([c.join(" "), 1]);
    expect(fake.state.requests.length).toBe(0);
  }
});

test("crm pipelines still dispatches through PIPELINE_SPECS", async () => {
  const r = await cli(["crm", "pipelines", "--org", "acme"], { env: owner });
  expect(r.code).toBe(0);
  expect(fake.state.requests.map((q) => q.path)).toEqual(["/api/v1/orgs/acme/crm/pipelines"]);
});
