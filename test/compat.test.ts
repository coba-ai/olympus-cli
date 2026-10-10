import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli";
import { startFake, TOKENS } from "./fake-api";

// Piped (non-TTY) human output of v0.1.0, pinned byte for byte. Do not edit a string to make a change pass.
const fake = startFake();
afterAll(() => fake.stop());

async function cli(args: string[], o: { env?: Record<string, string>; stdin?: string; home?: string } = {}) {
  const home = o.home ?? (await mkdtemp(join(tmpdir(), "oly-compat-")));
  let out = "", err = "";
  let clock = Date.now();
  const code = await run(args, {
    env: { OLYMPUS_HOST: fake.url, ...o.env }, home, stdin: async () => o.stdin ?? "",
    out: (s) => { out += s; }, err: (s) => { err += s; },
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  });
  return { code, out, err, home };
}
const owner = { OLYMPUS_API_KEY: TOKENS.owner };
const multi = { OLYMPUS_API_KEY: TOKENS.multi };

beforeAll(() => {
  const row = (id: string, name: string) => ({
    id, name, agent: "hermes", full_tools: false, url: `${fake.url}/hooks/${id}`,
    last_delivery_at: null, last_delivery_status: null, created_at: "2026-10-02T10:00:00Z", instructions: `${name} instructions`,
  });
  fake.state.webhooks.beta = [row("wh_b1", "alpha"), row("wh_b2", "gamma")];
});

test("COMPAT piped human output is byte-identical to v0.1.0", async () => {
  const ok = async (args: string[], o = {}) => {
    const r = await cli(args, o);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    return r.out;
  };
  const u = fake.url;
  expect(await ok(["whoami"], { env: owner })).toBe("owner@acme.test\ntoken test …abcd\nacme\tAcme\toperator\n");
  expect(await ok(["whoami"], { env: { OLYMPUS_API_KEY: TOKENS.pinned } })).toBe(
    "pinned@acme.test\ntoken test …abcd (pinned to acme)\nacme\tAcme\toperator\n");
  expect(await ok(["org", "list"], { env: multi })).toBe("acme\tAcme\toperator\nbeta\tBeta\toperator\n");
  expect(await ok(["org", "use", "beta"], { env: multi })).toBe("default org: beta\n");
  expect(await ok(["agents", "list"], { env: owner })).toBe("hermes\tHermes\tactive\nhera\tHera\tpaused\n");
  expect(await ok(["webhook", "list", "--org", "beta"], { env: multi })).toBe(
    "wh_b1\talpha\thermes\t-\t-\nwh_b2\tgamma\thermes\t-\t-\n");
  expect(await ok(["webhook", "get", "wh_b1", "--org", "beta"], { env: multi })).toBe(
    `id: wh_b1\nname: alpha\nagent: hermes\nfull_tools: false\nurl: ${u}/hooks/wh_b1\nlast_delivery_at: null\nlast_delivery_status: null\ncreated_at: 2026-10-02T10:00:00Z\ninstructions: alpha instructions\n`);
  expect(await ok(["webhook", "update", "wh_b1", "--no-full-tools", "--org", "beta"], { env: multi })).toBe(
    `id: wh_b1\nname: alpha\nagent: hermes\nfull_tools: false\nurl: ${u}/hooks/wh_b1\nlast_delivery_at: null\nlast_delivery_status: null\ncreated_at: 2026-10-02T10:00:00Z\n`);
  expect(await ok(["webhook", "delete", "wh_b2", "--yes", "--org", "beta"], { env: multi })).toBe("deleted wh_b2\n");
  const home = await mkdtemp(join(tmpdir(), "oly-compat-"));
  expect(await ok(["login", "--with-token"], { home, stdin: TOKENS.owner + "\n" })).toBe(`logged in to ${u} as owner@acme.test\n`);
  expect(await ok(["logout"], { home })).toBe("logged out\n");
  expect(await ok(["logout"], { home })).toBe("no stored credentials\n");
  const created = await ok(["webhook", "create", "--name", "n", "--agent", "hermes", "--instructions", "do it"], { env: owner });
  expect(created).toMatch(/^id: wh_\d+\nname: n\nagent: hermes\nfull_tools: false\nurl: .*\/hooks\/wh_\d+\nlast_delivery_at: null\nlast_delivery_status: null\ncreated_at: \S+\nsecret \(shown once\): whsec_[0-9a-f]+\n$/);
});
