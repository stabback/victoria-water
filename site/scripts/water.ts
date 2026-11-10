/**
 * The hero bottle's water: a row of columns joined by the wave equation. Walls reflect waves,
 * the volume never changes, short ripples die fast and the main slosh rings for a few seconds.
 * Scrolling and shaking the phone push it; a faint ripple keeps it alive at rest.
 * The geometry helpers also run at build time (site/components/Gauge.astro) for the still frame.
 */

// RULE: never call DeviceMotionEvent.requestPermission(): on iOS it opens a permission prompt.
// Listening alone never prompts; browsers that need permission (iOS Safari) just send no events.
// TRAP: requestPermission's presence doesn't mean a prompt; Chrome has it too and grants silently.

const SPEED = 460; // SVG units/s: the side-to-side slosh takes 2·width/SPEED ≈ 0.9 s
const DAMPING = 1.8; // per second: a slosh rings three or four times and is still in about 3 s
const VISCOSITY = 60; // damps short ripples (∝ 1/wavelength²) and barely touches the slosh
const DT = 1 / 240; // RULE: keep SPEED·DT/dx < 1 or the simulation blows up
const COLUMNS = 56;

/** Wave heights (up is positive) across the water, simulated with fixed sub-steps. */
export class Surface {
  readonly h: Float64Array;
  readonly v: Float64Array;
  private readonly a: Float64Array;
  private readonly dx: number;
  private readonly cap: number;
  /** The slope the surface settles to (rise per unit across); shaking the phone tilts it. */
  slope = 0;

  constructor(
    readonly width: number,
    readonly n = COLUMNS,
  ) {
    this.h = new Float64Array(n);
    this.v = new Float64Array(n);
    this.a = new Float64Array(n);
    this.dx = width / n;
    this.cap = width * 0.12;
  }

  /** Push standing wave `mode` (1: side to side, 2: middle against the sides) at `speed` units/s. */
  kick(mode: number, speed: number) {
    for (let i = 0; i < this.n; i++)
      this.v[i] = at(this.v, i) + speed * Math.cos((mode * Math.PI * (i + 0.5)) / this.n);
  }

  step(seconds: number) {
    for (let left = Math.min(seconds, 0.05); left > 1e-9; left -= DT) this.sub(Math.min(DT, left));
  }

  private sub(dt: number) {
    const { h, v, a, n, dx } = this;
    const c2 = (SPEED / dx) ** 2;
    const nu = VISCOSITY / dx ** 2;
    // Walls: mirror cells offset by the target slope. They add as much water as they take,
    // so the volume stays put.
    const s = this.slope * dx;
    for (let i = 0; i < n; i++) {
      const hi = at(h, i);
      const vi = at(v, i);
      const hl = i > 0 ? at(h, i - 1) : hi - s;
      const hr = i < n - 1 ? at(h, i + 1) : hi + s;
      const vl = i > 0 ? at(v, i - 1) : vi;
      const vr = i < n - 1 ? at(v, i + 1) : vi;
      a[i] = c2 * (hl - 2 * hi + hr) + nu * (vl - 2 * vi + vr) - DAMPING * vi;
    }
    let peak = 0;
    for (let i = 0; i < n; i++) {
      v[i] = at(v, i) + at(a, i) * dt;
      h[i] = at(h, i) + at(v, i) * dt;
      peak = Math.max(peak, Math.abs(at(h, i)));
    }
    // Hard shakes saturate instead of throwing water out of the bottle.
    if (peak > this.cap) {
      const f = this.cap / peak;
      for (let i = 0; i < n; i++) {
        h[i] = at(h, i) * f;
        v[i] = at(v, i) * f;
      }
    }
  }
}

const at = (xs: Float64Array | number[], i: number) => xs[i] ?? 0;

/** The always-on ripple: two faint wave trains crossing, different for the front and back layers. */
export function ripple(x: number, t: number, back = false) {
  return back
    ? 1.3 * Math.sin((2 * Math.PI * x) / 210 + 0.7 * t + 2) + 0.7 * Math.sin((2 * Math.PI * x) / 118 - 1.0 * t)
    : 1.5 * Math.sin((2 * Math.PI * x) / 170 - 1.1 * t) + 0.8 * Math.sin((2 * Math.PI * x) / 97 + 0.8 * t + 1.3);
}

/** Column centres across [left, right]. */
export function columns(left: number, right: number, n = COLUMNS) {
  const dx = (right - left) / n;
  return Array.from({ length: n }, (_, i) => left + (i + 0.5) * dx);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The surface through (xs, ys) as a smooth curve, run flat past both walls by `overhang`.
 * `open` is the line itself; `closed` is the water under it, down to `floor`.
 */
export function surfacePath(xs: number[], ys: number[], floor: number, overhang = 30) {
  const n = xs.length;
  const x = (i: number) => at(xs, Math.max(0, Math.min(n - 1, i)));
  const y = (i: number) => at(ys, Math.max(0, Math.min(n - 1, i)));
  const x0 = x(0) - overhang;
  const xn = x(n - 1) + overhang;
  let open = `M${r1(x0)},${r1(y(0))} L${r1(x(0))},${r1(y(0))}`;
  // Catmull-Rom through the column tops, written as cubic Béziers.
  for (let i = 0; i < n - 1; i++) {
    const c1x = x(i) + (x(i + 1) - x(i - 1)) / 6;
    const c1y = y(i) + (y(i + 1) - y(i - 1)) / 6;
    const c2x = x(i + 1) - (x(i + 2) - x(i)) / 6;
    const c2y = y(i + 1) - (y(i + 2) - y(i)) / 6;
    open += ` C${r1(c1x)},${r1(c1y)} ${r1(c2x)},${r1(c2y)} ${r1(x(i + 1))},${r1(y(i + 1))}`;
  }
  open += ` L${r1(xn)},${r1(y(n - 1))}`;
  return { open, closed: `${open} V${floor} H${r1(x0)} Z` };
}

/** Everything outside `closed`, for clipping (with clip-rule="evenodd"). */
export const outside = (closed: string) => `M-1000,-1000 H2000 V2000 H-1000 Z ${closed}`;

export const BACK_OFFSET = 4; // the far side of the surface sits this much higher

/** Wires the gauge in the page to a Surface. Does nothing for reduced motion: the build's still frame stays. */
export function water() {
  const svg = document.querySelector<SVGSVGElement>("svg[data-water]");
  if (!svg) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const left = Number(svg.dataset.left);
  const right = Number(svg.dataset.right);
  const level = Number(svg.dataset.level);
  const floor = Number(svg.dataset.floor);
  if (![left, right, level, floor].every(Number.isFinite)) return;

  const part = (name: string) => svg.querySelector(`[data-surface="${name}"]`);
  const [front, crest, back, below, above] = ["front", "crest", "back", "below", "above"].map(part);
  const surface = new Surface(right - left);
  const xs = columns(left, right, surface.n);
  const ys = xs.map(() => level);
  const ysBack = xs.map(() => level);

  const draw = (t: number) => {
    for (let i = 0; i < xs.length; i++) {
      const x = at(xs, i);
      const h = at(surface.h, i);
      ys[i] = level - h - ripple(x, t);
      ysBack[i] = level - BACK_OFFSET - 0.75 * h - ripple(x, t, true);
    }
    const f = surfacePath(xs, ys, floor);
    front?.setAttribute("d", f.closed);
    crest?.setAttribute("d", f.open);
    below?.setAttribute("d", f.closed);
    above?.setAttribute("d", outside(f.closed));
    back?.setAttribute("d", surfacePath(xs, ysBack, floor).closed);
  };

  let frame = 0;
  let last = 0;
  const tick = (now: number) => {
    surface.step((now - last) / 1000);
    last = now;
    draw(now / 1000);
    frame = requestAnimationFrame(tick);
  };
  let visible = false;
  let settled = false;
  new IntersectionObserver(([e]) => {
    visible = e?.isIntersecting ?? false;
    if (visible && !frame) {
      // The first time it's seen, the bottle has just been set down: one gentle slosh.
      if (!settled) surface.kick(1, 90);
      settled = true;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    } else if (!visible && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }).observe(svg);

  // Scrolling jolts the bottle up or down: the water bounces in the middle and rocks a little.
  const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
  let lastY = window.scrollY;
  window.addEventListener(
    "scroll",
    () => {
      const dy = clamp(window.scrollY - lastY, 80);
      lastY = window.scrollY;
      if (!visible || dy === 0) return;
      surface.kick(2, dy * 1.4);
      surface.kick(1, dy * 0.5);
    },
    { passive: true },
  );

  // High-pass accelerationIncludingGravity: shakes and jolts pass, gravity and slow tilts don't.
  let gx = Number.NaN;
  let gy = Number.NaN;
  window.addEventListener("devicemotion", (e) => {
    const a = e.accelerationIncludingGravity;
    if (a?.x == null || a.y == null) return;
    if (Number.isNaN(gx)) [gx, gy] = [a.x, a.y];
    gx = gx * 0.9 + a.x * 0.1;
    gy = gy * 0.9 + a.y * 0.1;
    // Device axes to screen axes (screen y up), for landscape.
    const r = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
    const [hx, hy] = [a.x - gx, a.y - gy];
    const sx = hx * Math.cos(r) - hy * Math.sin(r);
    const sy = hx * Math.sin(r) + hy * Math.cos(r);
    // Ignore hand tremor so the water can come to rest.
    const quiet = !visible || Math.hypot(sx, sy) < 0.6;
    // Pushed right, the water piles up on the left (and the other way round).
    surface.slope = quiet ? 0 : clamp(-sx * 0.03, 0.2);
    if (!quiet) surface.kick(2, clamp(sy, 6) * 1.5);
  });
}
