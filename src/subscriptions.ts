import { usage } from "./core";
import type { Plan } from "./tasks";

export function subscriptionPlan(pos: string[], _v: Record<string, unknown>, _io: unknown, _json: boolean, _now: () => number): Plan {
  throw usage(`unknown subscription command: ${pos.slice(1).join(" ")}`);
}
