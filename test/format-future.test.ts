import { expect, test } from "bun:test";
import { ago, when } from "../src/format";

const NOW = Date.parse("2026-10-10T14:00:00Z");
const after = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

test("ago: up to 5 min ahead is clock skew, still 'just now'", () => {
  expect(ago(after(0), NOW)).toBe("just now");
  expect(ago(after(300_000), NOW)).toBe("just now");
});

test("ago: future buckets mirror the past ones", () => {
  expect(ago(after(301_000), NOW)).toBe("+5m");
  expect(ago(after(6 * MIN), NOW)).toBe("+6m");
  expect(ago(after(3 * HOUR), NOW)).toBe("+3h");
  expect(ago(after(8 * DAY), NOW)).toBe("+8d");
  expect(ago(after(40 * DAY), NOW)).toBe("2026-11-19");
});

test("when: a future time reads '+8d (date UTC)'", () => {
  expect(when("2026-10-18T14:00:00Z", NOW)).toBe("+8d (2026-10-18 14:00 UTC)");
});
