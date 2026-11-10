import { describe, expect, test } from "bun:test";
import { Surface } from "../site/scripts/water.ts";

const sum = (xs: Float64Array) => xs.reduce((a, b) => a + b, 0);
const peak = (xs: Float64Array) => Math.max(...xs.map(Math.abs));

describe("water surface", () => {
  test("keeps its volume through kicks and tilts", () => {
    const s = new Surface(204);
    s.kick(1, 90);
    s.kick(2, -60);
    s.slope = 0.15;
    for (let i = 0; i < 120; i++) s.step(1 / 60);
    expect(Math.abs(sum(s.h))).toBeLessThan(1e-6);
  });

  test("a slosh is visible, then settles within a few seconds", () => {
    const s = new Surface(204);
    s.kick(1, 90);
    for (let i = 0; i < 12; i++) s.step(1 / 60);
    expect(peak(s.h)).toBeGreaterThan(5);
    for (let i = 0; i < 300; i++) s.step(1 / 60);
    expect(peak(s.h)).toBeLessThan(0.5);
  });

  test("hard shakes stay inside the bottle", () => {
    const s = new Surface(204);
    for (let i = 0; i < 60; i++) {
      s.kick(1, 400);
      s.kick(2, -400);
      s.step(1 / 60);
      expect(peak(s.h)).toBeLessThanOrEqual(204 * 0.12 + 1e-9);
      expect(Number.isFinite(sum(s.v))).toBe(true);
    }
  });

  test("a held tilt settles to a sloped surface", () => {
    const s = new Surface(204);
    s.slope = 0.1;
    for (let i = 0; i < 600; i++) s.step(1 / 60);
    const n = s.n;
    expect((s.h[n - 1] ?? 0) - (s.h[0] ?? 0)).toBeCloseTo(0.1 * 204 * (1 - 1 / n), 0);
  });
});
