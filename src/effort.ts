import { EFFORTS } from "./types.ts";
import type { Backend, Effort } from "./types.ts";

/** Where a model id names its effort level, as in agy's "gemini-3.8-flash-{effort}". */
export const EFFORT_SLOT = "{effort}";

/**
 * The level a backend accepts closest to the one wanted. Halfway between two, the cheaper one
 * wins. Undefined when the backend takes no effort setting.
 */
export function nearestEffort(backend: Backend, wanted: Effort): Effort | undefined {
  const target = EFFORTS.indexOf(wanted);
  let best = backend.efforts[0];
  for (const level of backend.efforts) {
    const distance = Math.abs(EFFORTS.indexOf(level) - target);
    if (best === undefined || distance < Math.abs(EFFORTS.indexOf(best) - target)) best = level;
  }
  return best;
}

/**
 * The model id to request, and the effort still to send as a setting. A model id with an
 * {effort} slot carries the level itself, so nothing is left to send; with no effort asked
 * for, the slot gets the accepted level nearest "low".
 */
export function applyEffort(
  backend: Backend,
  effort: Effort | undefined,
): { model: string; effort?: Effort } {
  if (!backend.model.includes(EFFORT_SLOT)) {
    return effort ? { model: backend.model, effort } : { model: backend.model };
  }
  const level = effort ?? (nearestEffort(backend, "low") as Effort);
  return { model: backend.model.replaceAll(EFFORT_SLOT, level) };
}
