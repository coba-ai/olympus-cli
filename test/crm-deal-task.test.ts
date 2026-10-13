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
  delete fake.state.next;
  fake.state.now = () => NOW;
  fake.state.crm = seedCrm();
});

async function go(extra: string[], tty: boolean) {
  const home = await mkdtemp(join(tmpdir(), "oly-"));
  let out = "";
  await run(["crm", "deal", "task", "add", "d_renewal", "T", "--org", "acme", ...extra], {
    env: { OLYMPUS_HOST: fake.url, OLYMPUS_API_KEY: TOKENS.owner }, home, stdin: async () => "",
    out: (s) => { out += s; }, err: () => {}, now: () => NOW, tty,
  });
  return out;
}

test("deal task add does not name a task id (issue #20)", async () => {
  const body = { data: { id: "d_renewal", name: "Initech renewal", tasks: [
    { id: "ct_new", title: "T", status: "open" }, { id: "ct_done", title: "Old", status: "done" }] } };
  fake.state.next = { status: 201, body };
  const tty = await go([], true);
  expect(tty).toStartWith("Added a task to deal d_renewal.\n\n");
  expect(tty).not.toMatch(/Added task ct_/);
  fake.state.next = { status: 201, body };
  const piped = await go([], false);
  expect(piped).toStartWith("id: d_renewal\n");
  expect(piped).toContain("ct_done");
  fake.state.next = { status: 201, body };
  expect(await go(["--json"], false)).toBe(JSON.stringify(body) + "\n");
});
