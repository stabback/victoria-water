/**
 * A tiny SVG charting toolkit — just what the dashboard needs, no dependencies.
 * Charts re-render on resize, draw hairline grids, smooth monotone lines, soft bands, and a
 * crosshair tooltip on hover/touch.
 */

import type { Num } from "../lib/format.ts";

const SVG = "http://www.w3.org/2000/svg";

export type { Num };

export function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

export type Scale = {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
  invert(px: number): number;
};

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const s = ((v: number) => r0 + (v - d0) * k) as Scale;
  s.domain = domain;
  s.range = range;
  s.invert = (px) => d0 + (px - r0) / (k || 1);
  return s;
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Monotone cubic (Fritsch–Carlson) path through points — smooth without overshooting. */
function monotoneSegment(pts: [number, number][]): string {
  const n = pts.length;
  if (n === 0) return "";
  const [x0, y0] = pts[0] as [number, number];
  if (n === 1) return `M${x0},${y0}`;
  if (n === 2) return `M${x0},${y0}L${pts[1]?.[0]},${pts[1]?.[1]}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i] as [number, number];
    const b = pts[i + 1] as [number, number];
    dx.push(b[0] - a[0]);
    m.push((b[1] - a[1]) / (b[0] - a[0] || 1e-9));
  }
  const t: number[] = [m[0] as number];
  for (let i = 1; i < n - 1; i++) {
    const a = m[i - 1] as number;
    const b = m[i] as number;
    if (a * b <= 0) t.push(0);
    else {
      const w1 = 2 * (dx[i] as number) + (dx[i - 1] as number);
      const w2 = (dx[i] as number) + 2 * (dx[i - 1] as number);
      t.push((w1 + w2) / (w1 / a + w2 / b));
    }
  }
  t.push(m[n - 2] as number);
  let d = `M${x0.toFixed(1)},${y0.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = pts[i] as [number, number];
    const [bx, by] = pts[i + 1] as [number, number];
    const h = (dx[i] as number) / 3;
    d += `C${(ax + h).toFixed(1)},${(ay + h * (t[i] as number)).toFixed(1)} ${(bx - h).toFixed(1)},${(by - h * (t[i + 1] as number)).toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
  }
  return d;
}

/** Splits on missing values so gaps stay gaps. */
function segments(xs: number[], ys: Num[]): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] = [];
  ys.forEach((y, i) => {
    const x = xs[i];
    if (y === null || y === undefined || Number.isNaN(y) || x === undefined) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push([x, y]);
  });
  if (cur.length) out.push(cur);
  return out;
}

export function linePath(xs: number[], ys: Num[], smooth = true): string {
  return segments(xs, ys)
    .map((seg) =>
      smooth ? monotoneSegment(seg) : `M${seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}`,
    )
    .join("");
}

export function bandPath(xs: number[], lo: Num[], hi: Num[], smooth = true): string {
  let d = "";
  let start = -1;
  const flush = (end: number) => {
    if (start < 0 || end - start < 1) return;
    const top: [number, number][] = [];
    const bottom: [number, number][] = [];
    for (let i = start; i <= end; i++) {
      top.push([xs[i] as number, hi[i] as number]);
      bottom.push([xs[i] as number, lo[i] as number]);
    }
    bottom.reverse();
    const topPath = smooth ? monotoneSegment(top) : `M${top.map(([x, y]) => `${x},${y}`).join("L")}`;
    const botPath = smooth ? monotoneSegment(bottom) : `M${bottom.map(([x, y]) => `${x},${y}`).join("L")}`;
    d += `${topPath}L${botPath.slice(1)}Z`;
  };
  for (let i = 0; i < xs.length; i++) {
    const ok = lo[i] !== null && lo[i] !== undefined && hi[i] !== null && hi[i] !== undefined;
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      flush(i - 1);
      start = -1;
    }
  }
  if (start >= 0) flush(xs.length - 1);
  return d;
}

export type Layer =
  | { kind: "band"; lo: Num[]; hi: Num[]; cls: string; x?: number[] }
  | { kind: "area"; y: Num[]; cls: string; x?: number[] }
  | {
      kind: "line";
      y: Num[];
      cls: string;
      x?: number[];
      smooth?: boolean;
      endDot?: boolean;
      endLabel?: string;
      hover?: boolean;
      /** A small marker at every point. */
      dots?: boolean;
    }
  | { kind: "hline"; y: number; cls: string; label?: string }
  | { kind: "vline"; x: number; cls: string; label?: string }
  | { kind: "bars"; y: Num[]; cls: string | ((i: number) => string); x?: number[]; width?: number }
  | { kind: "points"; y: Num[]; cls: string; x?: number[]; r?: number };

export type TooltipRow = { label: string; value: string; swatch?: string };

export type TimeChartSpec = {
  x: number[];
  xDomain?: [number, number];
  yDomain: [number, number];
  yTicks?: number[];
  yFormat?: (v: number) => string;
  xTicks: (scale: Scale, width: number) => { v: number; label: string }[];
  layers: Layer[];
  height?: number | ((width: number) => number);
  tooltip?: (i: number) => { title: string; rows: TooltipRow[] } | null;
  /** Called with the plot geometry after drawing, for bespoke annotations. */
  annotate?: (g: SVGGElement, x: Scale, y: Scale) => void;
  ariaLabel: string;
  /** No y-axis gutter (for small strips without a y scale). */
  compact?: boolean;
  /** Unit written above the y axis, e.g. "mm". */
  yUnit?: string;
};

const MARGIN = { top: 14, right: 16, bottom: 28, left: 40 };

/** Mounts a chart that redraws on resize. Returns a function to update the spec. */
export function timeChart(host: HTMLElement, initial: TimeChartSpec) {
  let spec = initial;
  host.classList.add("chart");
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "status");

  const draw = () => {
    const width = host.clientWidth;
    if (!width) return;
    const height = typeof spec.height === "function" ? spec.height(width) : (spec.height ?? 280);
    host.replaceChildren();
    host.appendChild(tip);
    tip.style.opacity = "0";
    const svg = el(
      "svg",
      { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": spec.ariaLabel },
      host,
    );
    const narrow = width < 520;
    const m = spec.compact
      ? { ...MARGIN, top: 18, left: 4, right: 4 }
      : { ...MARGIN, left: narrow ? 34 : MARGIN.left, right: narrow ? 10 : MARGIN.right };
    if (spec.yUnit) m.top += 16;
    const xDomain = spec.xDomain ?? [spec.x[0] ?? 0, spec.x.at(-1) ?? 1];
    const x = linear(xDomain, [m.left, width - m.right]);
    const y = linear(spec.yDomain, [height - m.bottom, m.top]);
    const yFormat = spec.yFormat ?? ((v: number) => String(v));

    const grid = el("g", { class: "grid" }, svg);
    if (spec.yUnit) el("text", { x: 0, y: 10, class: "tick unit" }, grid).textContent = spec.yUnit;
    for (const v of spec.yTicks ?? niceTicks(spec.yDomain[0], spec.yDomain[1], 4)) {
      el("line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v) }, grid);
      el("text", { x: m.left - 8, y: y(v), dy: "0.32em", "text-anchor": "end", class: "tick" }, grid).textContent =
        yFormat(v);
    }
    for (const t of spec.xTicks(x, width)) {
      el("text", { x: x(t.v), y: height - 8, "text-anchor": "middle", class: "tick" }, grid).textContent = t.label;
    }

    const plot = el("g", { class: "plot" }, svg);
    const clipId = `c${Math.random().toString(36).slice(2)}`;
    const clip = el("clipPath", { id: clipId }, el("defs", {}, svg));
    el("rect", { x: m.left, y: 0, width: width - m.left - m.right, height: height - m.bottom }, clip);
    plot.setAttribute("clip-path", `url(#${clipId})`);

    const hoverLines: { xs: number[]; ys: Num[]; cls: string }[] = [];
    for (const layer of spec.layers) {
      const xs = ("x" in layer && Array.isArray(layer.x) ? layer.x : spec.x).map(x);
      switch (layer.kind) {
        case "band":
          el(
            "path",
            { d: bandPath(xs, layer.lo.map(mapY(y)), layer.hi.map(mapY(y))), class: `band ${layer.cls}` },
            plot,
          );
          break;
        case "area": {
          const base = layer.y.map((v) => (v === null || v === undefined ? null : y(spec.yDomain[0])));
          el("path", { d: bandPath(xs, base, layer.y.map(mapY(y))), class: `area ${layer.cls}` }, plot);
          break;
        }
        case "line": {
          const ys = layer.y.map(mapY(y));
          el("path", { d: linePath(xs, ys, layer.smooth ?? true), class: `line ${layer.cls}` }, plot);
          if (layer.hover !== false) hoverLines.push({ xs, ys, cls: layer.cls });
          if (layer.dots)
            ys.forEach((cy, i) => {
              if (cy !== null && cy !== undefined)
                el("circle", { cx: xs[i], cy, r: 3, class: `dot small ${layer.cls}` }, plot);
            });
          if (layer.endDot || layer.endLabel) {
            let i = ys.length - 1;
            while (i >= 0 && (ys[i] === null || ys[i] === undefined)) i--;
            if (i >= 0) {
              const cx = xs[i] as number;
              const cy = ys[i] as number;
              if (layer.endDot) el("circle", { cx, cy, r: 4, class: `dot end ${layer.cls}` }, svg);
              if (layer.endLabel) {
                const right = cx > width - 90;
                // TRAP: a right-anchored label sits on the line's own path; its halo would hide the
                // last few pixels of the line and make the end dot look detached. Lift it clear.
                el(
                  "text",
                  {
                    x: right ? cx - 6 : cx + 10,
                    y: right ? cy + 16 : cy,
                    dy: "0.32em",
                    "text-anchor": right ? "end" : "start",
                    class: "end-label",
                  },
                  svg,
                ).textContent = layer.endLabel;
              }
            }
          }
          break;
        }
        case "hline":
          el(
            "line",
            { x1: m.left, x2: width - m.right, y1: y(layer.y), y2: y(layer.y), class: `rule ${layer.cls}` },
            plot,
          );
          if (layer.label)
            el(
              "text",
              { x: width - m.right - 4, y: y(layer.y) - 6, "text-anchor": "end", class: "rule-label" },
              svg,
            ).textContent = layer.label;
          break;
        case "vline":
          el(
            "line",
            { x1: x(layer.x), x2: x(layer.x), y1: m.top, y2: height - m.bottom, class: `rule ${layer.cls}` },
            plot,
          );
          if (layer.label)
            // At the foot of the line, clear of the data near the top.
            el("text", { x: x(layer.x) + 6, y: height - m.bottom - 6, class: "rule-label" }, svg).textContent =
              layer.label;
          break;
        case "points": {
          const ys = layer.y.map(mapY(y));
          ys.forEach((cy, i) => {
            if (cy !== null && cy !== undefined)
              el("circle", { cx: xs[i], cy, r: layer.r ?? 2.5, class: `pt ${layer.cls}` }, plot);
          });
          break;
        }
        case "bars": {
          const n = xs.length;
          const slot = n > 1 ? Math.abs((xs[n - 1] as number) - (xs[0] as number)) / (n - 1) : 20;
          const bw = Math.max(1.5, Math.min(layer.width ?? 24, slot - 2));
          layer.y.forEach((v, i) => {
            if (v === null || v === undefined) return;
            const y0 = y(Math.max(spec.yDomain[0], 0));
            const y1 = y(v);
            const cls = typeof layer.cls === "function" ? layer.cls(i) : layer.cls;
            el(
              "path",
              {
                d: roundedBar((xs[i] as number) - bw / 2, Math.min(y0, y1), bw, Math.abs(y0 - y1), v >= 0),
                class: `bar ${cls}`,
              },
              plot,
            );
          });
          break;
        }
      }
    }
    spec.annotate?.(el("g", { class: "annotations" }, svg), x, y);

    // ── Hover layer ────────────────────────────────────────────────────────────────────────
    if (!spec.tooltip) return;
    const hover = el("g", { class: "hover", opacity: 0 }, svg);
    const cross = el("line", { y1: m.top, y2: height - m.bottom, class: "crosshair" }, hover);
    const dots = hoverLines.map((l) => el("circle", { r: 4, class: `dot ${l.cls}` }, hover));
    const capture = el("rect", { x: m.left, y: 0, width: width - m.left - m.right, height, fill: "transparent" }, svg);
    const xsPx = spec.x.map(x);
    const move = (ev: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      let i = 0;
      let best = Number.POSITIVE_INFINITY;
      xsPx.forEach((v, j) => {
        const dist = Math.abs(v - px);
        if (dist < best) [best, i] = [dist, j];
      });
      const content = spec.tooltip?.(i);
      if (!content) {
        hide();
        return;
      }
      const cx = xsPx[i] as number;
      cross.setAttribute("x1", String(cx));
      cross.setAttribute("x2", String(cx));
      hoverLines.forEach((l, k) => {
        // Dot on each hoverable line at the same x (lines may have their own x arrays).
        let idx = -1;
        let bd = 3;
        l.xs.forEach((v, j) => {
          const dd = Math.abs(v - cx);
          if (dd < bd) [bd, idx] = [dd, j];
        });
        const dot = dots[k] as SVGCircleElement;
        const yy = idx >= 0 ? l.ys[idx] : null;
        if (yy === null || yy === undefined) dot.setAttribute("opacity", "0");
        else {
          dot.setAttribute("opacity", "1");
          dot.setAttribute("cx", String(cx));
          dot.setAttribute("cy", String(yy));
        }
      });
      hover.setAttribute("opacity", "1");
      tip.innerHTML = `<div class="tip-title">${content.title}</div>${content.rows
        .map(
          (r) =>
            `<div class="tip-row">${r.swatch ? `<i class="sw ${r.swatch}"></i>` : ""}<span>${r.label}</span><b>${r.value}</b></div>`,
        )
        .join("")}`;
      tip.style.opacity = "1";
      const tw = tip.offsetWidth;
      const left = cx + 14 + tw > width ? cx - 14 - tw : cx + 14;
      tip.style.transform = `translate(${Math.max(0, left)}px, ${m.top}px)`;
    };
    const hide = () => {
      hover.setAttribute("opacity", "0");
      tip.style.opacity = "0";
    };
    capture.addEventListener("pointermove", move);
    capture.addEventListener("pointerdown", move);
    capture.addEventListener("pointerleave", hide);
  };

  let frame = 0;
  let lastWidth = 0;
  new ResizeObserver(() => {
    if (host.clientWidth === lastWidth) return;
    lastWidth = host.clientWidth;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }).observe(host);
  draw();
  return (next: TimeChartSpec) => {
    spec = next;
    draw();
  };
}

const mapY = (y: Scale) => (v: Num) => (v === null || v === undefined || Number.isNaN(v) ? null : y(v));

/** A bar with 4px rounded data-end and a square baseline. */
function roundedBar(x: number, y: number, w: number, h: number, up: boolean): string {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return "";
  if (up)
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}
