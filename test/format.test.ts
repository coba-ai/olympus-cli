import { describe, expect, test } from "bun:test";
import { ago, clean, delivery, keyValue, table, when } from "../src/format";

const NOW = Date.parse("2026-10-10T14:00:00Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

describe("clean", () => {
  test("strips controls, flattens whitespace, keeps newlines on request, stringifies", () => {
    expect(clean("a\x1b]52;c;AAAA\x07b\x9bc")).toBe("a]52;c;AAAAbc");
    expect(clean("a\nb\tc")).toBe("a b c");
    expect(clean("a\nb", true)).toBe("a\nb");
    expect(clean({ a: 1 })).toBe('{"a":1}');
    expect(clean(null)).toBe("");
    expect(clean(5)).toBe("5");
  });
});

describe("table", () => {
  test("aligns with two-space gaps, last column unpadded, no trailing spaces", () => {
    const t = table(["ID", "NAME", "X"], [["a", "long name", "1"], ["bbb", "n", ""]]);
    expect(t).toBe("ID   NAME       X\na    long name  1\nbbb  n");
    for (const l of t.split("\n")) expect(l).toBe(l.trimEnd());
  });
  test("null/undefined -> '-', empty string stays empty", () => {
    expect(table(["A", "B"], [["", null], [undefined, "x"]])).toBe("A  B\n   -\n-  x");
  });
  test("control characters stripped", () => {
    expect(table(["A"], [["x\x1b[31my"]])).toBe("A\nx[31my");
  });
});

describe("keyValue", () => {
  test("pads labels, indents continuation lines, keeps newlines", () => {
    expect(keyValue([["id", "wh_1"], ["instructions", "a\nb"], ["gone", null]])).toBe(
      "id            wh_1\ninstructions  a\n              b\ngone          -",
    );
  });
  test("strips controls", () => {
    expect(keyValue([["k", "v\x1b\x9b"]])).toBe("k  v");
  });
});

describe("ago", () => {
  test("boundaries", () => {
    expect(ago(null, NOW)).toBe("never");
    expect(ago(undefined, NOW)).toBe("never");
    expect(ago(before(-5 * MIN), NOW)).toBe("just now");
    expect(ago(before(44_000), NOW)).toBe("just now");
    expect(ago(before(50_000), NOW)).toBe("1m ago");
    expect(ago(before(5 * MIN), NOW)).toBe("5m ago");
    expect(ago(before(3 * HOUR), NOW)).toBe("3h ago");
    expect(ago(before(4 * DAY), NOW)).toBe("4d ago");
    expect(ago(before(29 * DAY), NOW)).toBe("29d ago");
    expect(ago("2026-08-01T10:00:00Z", NOW)).toBe("2026-08-01");
  });
  test("invalid input comes back cleaned", () => {
    expect(ago("not a date", NOW)).toBe("not a date");
    expect(ago("bad\x1b]52;c;AAAA\x07\x9b", NOW)).toBe("bad]52;c;AAAA");
  });
});

describe("when", () => {
  test("relative plus absolute UTC", () => {
    expect(when("2026-10-10T11:00:00Z", NOW)).toBe("3h ago (2026-10-10 11:00 UTC)");
    expect(when(null, NOW)).toBe("never");
    expect(when("nope\x1b", NOW)).toBe("nope");
  });
});

describe("delivery", () => {
  test("status labels", () => {
    expect(delivery(null, null, NOW)).toBe("never");
    expect(delivery(202, null, NOW)).toBe("202 accepted");
    expect(delivery(599, null, NOW)).toBe("599");
    expect(delivery(202, "2026-10-10T11:00:00Z", NOW)).toBe("202 accepted, 3h ago");
  });
});
