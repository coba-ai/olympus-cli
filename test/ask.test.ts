import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { lineAsker } from "../src/cli";
import { CliError } from "../src/core";

function stub() {
  const rl = new (class extends EventEmitter {
    prompts: string[] = [];
    shown = 0;
    setPrompt(p: string) { this.prompts.push(p); }
    prompt() { this.shown++; }
    close() { this.emit("close"); }
  })();
  return { rl, ask: lineAsker(rl as any) };
}

test("a line typed ahead is returned without prompting", async () => {
  const { rl, ask } = stub();
  rl.emit("line", "early");
  expect(await ask("Q? ")).toBe("early");
  expect(rl.shown).toBe(0);
});

test("a pending question shows its prompt and gets the next line", async () => {
  const { rl, ask } = stub();
  const p = ask("Name? ");
  expect(rl.prompts).toEqual(["Name? "]);
  expect(rl.shown).toBe(1);
  rl.emit("line", "ann");
  expect(await p).toBe("ann");
});

test("lines answer pending questions in order", async () => {
  const { rl, ask } = stub();
  const a = ask("1 ");
  rl.emit("line", "one");
  const b = ask("2 ");
  rl.emit("line", "two");
  expect([await a, await b]).toEqual(["one", "two"]);
});

test("close while pending resolves null, and later asks are null", async () => {
  const { rl, ask } = stub();
  const p = ask("Q? ");
  rl.emit("close");
  expect(await p).toBeNull();
  expect(await ask("again? ")).toBeNull();
});

test("SIGINT while pending rejects 130 cancelled and closes", async () => {
  const { rl, ask } = stub();
  const p = ask("Q? ");
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.emit("SIGINT");
  const e = await p.catch((x) => x);
  expect(e).toBeInstanceOf(CliError);
  expect(e.exit).toBe(130);
  expect(e.body.error.code).toBe("cancelled");
  expect(closed).toBe(true);
});

test("SIGINT with lines already queued cancels the next ask", async () => {
  const { rl, ask } = stub();
  rl.emit("line", "queued");
  rl.emit("SIGINT");
  const e = await ask("Q? ").catch((x) => x);
  expect(e).toBeInstanceOf(CliError);
  expect(e.exit).toBe(130);
  expect(e.body.error.code).toBe("cancelled");
});
