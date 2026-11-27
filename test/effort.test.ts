import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEffort, nearestEffort } from "../src/effort.ts";
import { makeBackend } from "./helpers.ts";

const claude = makeBackend({ id: "c", efforts: ["low", "medium", "high", "xhigh", "max"] });

test("a wanted effort is clamped to the nearest level the model accepts", () => {
  assert.equal(nearestEffort(claude, "max"), "max");
  assert.equal(nearestEffort(claude, "minimal"), "low");
  const twoLevels = makeBackend({ id: "t", efforts: ["low", "high"] });
  assert.equal(nearestEffort(twoLevels, "max"), "high");
  // Halfway between two levels, the cheaper one wins.
  assert.equal(nearestEffort(twoLevels, "medium"), "low");
});

test("a model without effort levels gets no effort", () => {
  assert.equal(nearestEffort(makeBackend({ id: "n" }), "max"), undefined);
});

test("an {effort} slot puts the level in the model id instead of a setting", () => {
  const agy = makeBackend({ id: "a", model: "gemini-flash-{effort}", efforts: ["low", "high"] });
  assert.deepEqual(applyEffort(agy, "high"), { model: "gemini-flash-high" });
  assert.deepEqual(applyEffort(agy, undefined), { model: "gemini-flash-low" });
  assert.deepEqual(applyEffort(claude, "xhigh"), { model: "test-model", effort: "xhigh" });
  assert.deepEqual(applyEffort(claude, undefined), { model: "test-model" });
});
