import { usage, type Io } from "./core";
import type { Plan } from "./tasks";
// Placeholder until the command lands.
export const askPlan = async (_pos: string[], _v: Record<string, unknown>, _io: Io, _json: boolean, _now: () => number, _signal: AbortSignal): Promise<Plan> => { throw usage("ask is not available yet"); };
