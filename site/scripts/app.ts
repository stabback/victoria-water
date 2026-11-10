import type { Dashboard } from "../../src/analysis/dashboard.ts";
import {
  dayNum,
  doyOf,
  doyToIso,
  fmtDate,
  isoOf,
  MONTHS,
  MONTHS_LONG,
  type Num,
  nf0,
  nf1,
  parts,
  pct,
  signed,
} from "../lib/format.ts";
import { el, type Scale, type TimeChartSpec, type TooltipRow, timeChart } from "./charts.ts";
import { water } from "./water.ts";

type D = Dashboard;

// RULE: this script only draws the charts and their controls. Every sentence and number around
// them is rendered into the HTML at build time (site/pages/index.astro) from the same payload.

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const maxOf = (xs: number[], fallback: number) => {
  const f = xs.filter(Number.isFinite);
  return f.length ? Math.max(...f) : fallback;
};
const minOf = (xs: number[], fallback: number) => {
  const f = xs.filter(Number.isFinite);
  return f.length ? Math.min(...f) : fallback;
};
function html(target: HTMLElement, markup: string) {
  target.innerHTML = markup;
}

function legend(target: HTMLElement, items: ([string, string] | string)[]) {
  html(
    target,
    items
      .map((it) =>
        typeof it === "string" ? `<span class="soft">${it}</span>` : `<span><i class="sw ${it[0]}"></i>${it[1]}</span>`,
      )
      .join(""),
  );
}

/** "97–99%"; when both ends round to the same whole number, one decimal shows the spread. */
const range = (lo: Num, hi: Num) => {
  const a = nf0.format(lo ?? 0);
  const b = nf0.format(hi ?? 0);
  if (a !== b) return `${a}–${b}%`;
  const a1 = nf1.format(lo ?? 0);
  const b1 = nf1.format(hi ?? 0);
  return a1 === b1 ? `${a1}%` : `${a1}–${b1}%`;
};

/** Linear interpolation inside a [x, y][] series, only across short gaps. */
function interp(points: [number, number][], x: number, maxGap = 12): number | null {
  for (let i = 0; i < points.length; i++) {
    const [px, py] = points[i] as [number, number];
    if (px === x) return py;
    if (px > x) {
      if (i === 0) return null;
      const [ax, ay] = points[i - 1] as [number, number];
      if (px - ax > maxGap) return null;
      return ay + ((py - ay) * (x - ax)) / (px - ax);
    }
  }
  return null;
}

/** Month labels for a day-of-year axis (Jan 1 = 1). */
const monthTicks = (scale: Scale, width: number) => {
  const step = width < 520 ? 2 : 1;
  const out: { v: number; label: string }[] = [];
  for (let m = 0; m < 12; m += step) {
    const v = doyOf(`2025-${String(m + 1).padStart(2, "0")}-01`);
    if (v >= scale.domain[0] && v <= scale.domain[1]) out.push({ v, label: MONTHS[m] as string });
  }
  return out;
};

/** Month labels for an axis counted in days from a given first day. */
const offsetMonthTicks =
  (start: string, months: number) =>
  (scale: Scale, width: number): { v: number; label: string }[] => {
    const step = width < 520 && months > 8 ? 2 : 1;
    const s = parts(start);
    const out: { v: number; label: string }[] = [];
    for (let k = 0; k < months; k += step) {
      const y = s.y + Math.floor((s.m + k) / 12);
      const m = (s.m + k) % 12;
      const v = dayNum(`${y}-${String(m + 1).padStart(2, "0")}-01`) - dayNum(start);
      if (v >= scale.domain[0] && v <= scale.domain[1]) out.push({ v, label: MONTHS[m] as string });
    }
    return out;
  };

function dateTicks(scale: Scale, width: number) {
  const [a, b] = scale.domain;
  const spanDays = b - a;
  const out: { v: number; label: string }[] = [];
  const target = Math.max(4, Math.floor(width / 64));
  if (spanDays > 900) {
    const years = spanDays / 365;
    const every = Math.max(1, Math.ceil(years / target));
    for (let y = parts(isoOf(a)).y; y <= parts(isoOf(b)).y + 1; y++) {
      if (y % every) continue;
      const v = dayNum(`${y}-01-01`);
      if (v >= a && v <= b) out.push({ v, label: String(y) });
    }
  } else {
    const months = spanDays / 30.4;
    const every = [1, 2, 3, 4, 6].find((e) => months / e <= target) ?? 6;
    const s = parts(isoOf(a));
    for (let k = 0; k <= months + 2; k++) {
      const y = s.y + Math.floor((s.m + k) / 12);
      const m = (s.m + k) % 12;
      if (m % every) continue;
      const v = dayNum(`${y}-${String(m + 1).padStart(2, "0")}-01`);
      if (v >= a && v <= b) out.push({ v, label: m === 0 ? `Jan ’${String(y).slice(2)}` : (MONTHS[m] as string) });
    }
  }
  return out;
}

const responsiveHeight = (desktop: number, mobile: number) => () => (window.innerWidth < 640 ? mobile : desktop);

/** A segmented control (radio group). Calls `onChange` with the chosen key. */
function segmented(host: HTMLElement, options: [string, string][], initial: string, onChange: (key: string) => void) {
  host.replaceChildren();
  for (const [key, label] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(key === initial));
    b.addEventListener("click", () => {
      for (const c of host.children) c.setAttribute("aria-checked", String(c === b));
      onChange(key);
    });
    host.appendChild(b);
  }
  host.scrollLeft = host.scrollWidth;
}

/** A scrollable row of year chips (radio group). */
function yearChips(host: HTMLElement, years: number[], selected: number, onPick: (y: number) => void, fixed?: number) {
  host.replaceChildren();
  // RULE: chips run old → new, like the charts' x axes; the row starts scrolled to the newest end.
  for (const y of [...years].sort((a, b) => a - b)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip${y === fixed ? " current" : ""}`;
    b.textContent = String(y);
    if (y === fixed) b.disabled = true;
    else {
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(y === selected));
      b.addEventListener("click", () => {
        for (const c of host.querySelectorAll("[role=radio]")) c.setAttribute("aria-checked", String(c === b));
        onPick(y);
      });
    }
    host.appendChild(b);
  }
}

// ── This year ────────────────────────────────────────────────────────────────────────────
function renderYear(d: D) {
  const { envelope, years, currentYear } = d.seasonal;
  const x = Array.from({ length: 365 }, (_, i) => i + 1);
  const current = (years[currentYear] ?? []) as [number, number][];
  let compare = currentYear - 1;
  const yearList = Object.keys(years).map(Number);

  const spec = (): TimeChartSpec => {
    const comp = (years[compare] ?? []) as [number, number][];
    const lowest = minOf([...envelope.min, ...current.map((p) => p[1]), ...comp.map((p) => p[1])], 50);
    const yMin = Math.max(0, Math.floor((lowest - 6) / 10) * 10);
    return {
      x,
      xDomain: [1, 365],
      yDomain: [yMin, 100],
      yFormat: (v) => `${v}%`,
      xTicks: monthTicks,
      height: responsiveHeight(320, 240),
      ariaLabel: `Whole-system storage through ${currentYear} compared with ${compare} and the range since ${d.seasonal.firstYear}`,
      layers: [
        { kind: "band", lo: envelope.min, hi: envelope.max, cls: "range" },
        { kind: "band", lo: envelope.p25, hi: envelope.p75, cls: "water" },
        { kind: "line", y: envelope.median, cls: "median" },
        { kind: "line", x: comp.map((p) => p[0]), y: comp.map((p) => p[1]), cls: "compare thin" },
        {
          kind: "line",
          x: current.map((p) => p[0]),
          y: current.map((p) => p[1]),
          cls: "primary",
          endDot: true,
          endLabel: pct(current.at(-1)?.[1], 0),
        },
      ],
      tooltip: (i) => {
        const doy = i + 1;
        const rows: TooltipRow[] = [];
        const cur = interp(current, doy);
        if (cur !== null) rows.push({ label: String(currentYear), value: pct(cur), swatch: "primary" });
        const cmp = interp(comp, doy);
        if (cmp !== null) rows.push({ label: String(compare), value: pct(cmp), swatch: "compare" });
        rows.push({ label: "Typical", value: pct(envelope.median[i]), swatch: "median" });
        rows.push({
          label: "Range",
          value: range(envelope.min[i], envelope.max[i]),
          swatch: "range box",
        });
        return { title: fmtDate(doyToIso(doy), false), rows };
      },
    };
  };
  const update = timeChart($("year-chart"), spec());
  const drawLegend = () =>
    legend($("year-legend"), [
      ["primary", String(currentYear)],
      ["compare", String(compare)],
      ["median", "Typical"],
      ["band box", "Middle half of years"],
      ["range box", `Full range, ${d.seasonal.firstYear}–${currentYear - 1}`],
    ]);
  drawLegend();
  yearChips(
    $("year-chips"),
    yearList,
    compare,
    (y) => {
      compare = y;
      drawLegend();
      update(spec());
    },
    currentYear,
  );
}

// ── Outlook ──────────────────────────────────────────────────────────────────────────────
function renderOutlook(d: D) {
  const { outlook, history, latest } = d;
  const startDay = dayNum(latest.date) - 120;
  const histIdx = history.dates.map((dt, i) => [dt, i] as const).filter(([dt]) => dayNum(dt) >= startDay);
  const hx = histIdx.map(([dt]) => dayNum(dt));
  const hy = histIdx.map(([, i]) => history.total[i] as number);
  const first = dayNum(outlook.start);
  const fx = outlook.p50.map((_, i) => first + i * outlook.step);
  const x = [...hx, ...fx];
  const lastDay = dayNum(latest.date);
  const bx = [lastDay, ...fx];
  const at = (s: number[]) => [latest.totalPct, ...s];
  const floor = minOf([...outlook.p10, ...hy], 50);
  timeChart($("outlook-chart"), {
    x,
    yDomain: [Math.max(0, Math.floor((floor - 8) / 10) * 10), 100],
    yFormat: (v) => `${v}%`,
    xTicks: dateTicks,
    height: responsiveHeight(300, 230),
    ariaLabel: "Whole-system storage outlook for the coming months under past years' weather",
    layers: [
      { kind: "band", x: bx, lo: at(outlook.p10), hi: at(outlook.p90), cls: "water-faint" },
      { kind: "band", x: bx, lo: at(outlook.p25), hi: at(outlook.p75), cls: "water" },
      { kind: "line", x: bx, y: at(outlook.p50), cls: "primary thin" },
      { kind: "line", x: hx, y: hy, cls: "primary", endDot: true },
      { kind: "vline", x: lastDay, cls: "today", label: `Last reading, ${fmtDate(latest.date, false)}` },
    ],
    tooltip: (i) => {
      const day = x[i] as number;
      if (i < hx.length)
        return { title: fmtDate(isoOf(day)), rows: [{ label: "Measured", value: pct(hy[i]), swatch: "primary" }] };
      const k = i - hx.length;
      return {
        title: fmtDate(isoOf(day)),
        rows: [
          { label: "Most likely", value: pct(outlook.p50[k]), swatch: "primary" },
          {
            label: "Likely",
            value: range(outlook.p25[k], outlook.p75[k]),
            swatch: "band box",
          },
          {
            label: "Possible",
            value: range(outlook.p10[k], outlook.p90[k]),
            swatch: "band-faint box",
          },
        ],
      };
    },
  });
  legend($("outlook-legend"), [
    ["primary", "Measured, then most likely"],
    ["band box", "Likely"],
    ["band-faint box", "Possible"],
  ]);
}

// ── Rain ─────────────────────────────────────────────────────────────────────────────────
function renderRain(d: D) {
  const { lake, city, months, tempNormal } = d.rain;
  const host = $("rain-chart");
  if (!lake) return;
  const monthLabel = (m: (typeof months)[number]) =>
    `${MONTHS_LONG[parts(`${m.month}-01`).m]} ${m.month.slice(0, 4)}${m.partial ? " (so far)" : ""}`;
  const monthTicksFor = (_s: Scale, width: number) =>
    months
      .map((m, i) => ({ v: i, label: MONTHS[parts(`${m.month}-01`).m] as string }))
      .filter((_, i) => width >= 640 || (months.length - 1 - i) % 2 === 0);
  // Sep 1 → about two months past the latest data, so this season's line isn't a stub in a corner.
  const end = Math.min(364, Math.max(lake.current.length, city?.current.length ?? 0) - 1 + 61);
  const win = (xs: number[]) => xs.slice(0, end + 1);
  const start = dayNum(lake.start);
  const seasonSpec = (max: number, ariaLabel: string, layers: TimeChartSpec["layers"]) => {
    const step = max > 2000 ? 250 : max > 400 ? 100 : 50;
    return {
      x: Array.from({ length: end + 1 }, (_, i) => i),
      xDomain: [0, end] as [number, number],
      yDomain: [0, Math.ceil(max / step) * step] as [number, number],
      yFormat: (v: number) => nf0.format(v),
      yUnit: "mm",
      xTicks: offsetMonthTicks(lake.start, Math.ceil(end / 30.4) + 1),
      height: responsiveHeight(280, 230),
      ariaLabel,
      layers,
    };
  };
  const mmRow = (label: string, v: number | undefined, swatch: string): TooltipRow[] =>
    v === undefined ? [] : [{ label, value: `${nf0.format(v)} mm`, swatch }];

  const views: Record<string, () => TimeChartSpec> = {
    season: () => {
      legend($("rain-legend"), [
        ["rain", "This season"],
        ["compare", "Last season"],
        ["median", "Average"],
        ["rain-band box", `Most seasons since ${lake.firstSeason - 1}`],
      ]);
      const max = maxOf([...win(lake.p90), ...lake.current, ...win(lake.lastYear), ...win(lake.normal)], 200);
      return {
        ...seasonSpec(max, "Rain at Sooke Lake since September 1 (CRD gauge)", [
          { kind: "band", lo: win(lake.p10), hi: win(lake.p90), cls: "rain" },
          { kind: "line", y: win(lake.normal), cls: "median" },
          { kind: "line", y: win(lake.lastYear), cls: "compare thin" },
          {
            kind: "line",
            y: lake.current,
            cls: "rain",
            endDot: true,
            endLabel: `${nf0.format(lake.mm)} mm · ${fmtDate(lake.asOf, false)}`,
          },
        ]),
        tooltip: (i) => ({
          title: fmtDate(isoOf(start + i), false),
          rows: [
            ...mmRow("This season", lake.current[i], "rain"),
            ...mmRow("Last season", lake.lastYear[i], "compare"),
            ...mmRow("Average", lake.normal[i], "median"),
          ],
        }),
      };
    },
    city: () => {
      if (!city) return (views.season as () => TimeChartSpec)();
      const ofNormal = (mm: number, normal: number) =>
        normal > 0 ? ` · ${nf0.format((mm / normal) * 100)}% of average` : "";
      legend($("rain-legend"), [
        ["rain", `Sooke Lake ${nf0.format(lake.mm)} mm${ofNormal(lake.mm, lake.normalMm)}`],
        ["compare", `Victoria (Gonzales) ${nf0.format(city.mm)} mm${ofNormal(city.mm, city.normalMm)}`],
        `Dashed: average${city.missingDays ? ` · ${city.missingDays} city ${city.missingDays === 1 ? "day" : "days"} missing` : ""}`,
      ]);
      const max = maxOf([...lake.current, ...city.current, ...win(lake.normal), ...win(city.normal)], 200);
      return {
        ...seasonSpec(max, "Rain since September 1: Sooke Lake compared with Victoria", [
          { kind: "line", y: win(lake.normal), cls: "rain thin dashed" },
          { kind: "line", y: win(city.normal), cls: "compare thin dashed" },
          { kind: "line", y: lake.current, cls: "rain", endDot: true },
          { kind: "line", y: city.current, cls: "compare", endDot: true },
        ]),
        tooltip: (i) => ({
          title: fmtDate(isoOf(start + i), false),
          rows: [
            ...mmRow("Sooke Lake", lake.current[i], "rain"),
            ...mmRow("average", lake.normal[i], "rain"),
            ...mmRow("Victoria", city.current[i], "compare"),
            ...mmRow("average", city.normal[i], "compare"),
          ],
        }),
      };
    },
    temp: () => {
      legend($("rain-legend"), [
        ["warm box", `Warmer than the ${tempNormal.from}–${tempNormal.to} normal`],
        ["cool box", "Cooler"],
        "Victoria (Gonzales)",
      ]);
      const anomalies = months.map((m) => (m.tmean === null ? null : Math.round((m.tmean - m.tmeanNormal) * 10) / 10));
      const lim = Math.ceil(Math.max(2, ...anomalies.map((a) => Math.abs(a ?? 0))));
      return {
        x: months.map((_, i) => i),
        xDomain: [-0.6, months.length - 0.4],
        yDomain: [-lim, lim],
        yTicks: [-lim, 0, lim],
        yFormat: (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}°`,
        yUnit: "°C vs normal",
        xTicks: monthTicksFor,
        height: responsiveHeight(280, 230),
        ariaLabel: "Monthly mean temperature in Victoria (Gonzales) compared with normal",
        layers: [
          { kind: "hline", y: 0, cls: "zero" },
          {
            kind: "bars",
            y: anomalies,
            cls: (i) => `${(anomalies[i] ?? 0) >= 0 ? "warm" : "cool"} ${months[i]?.partial ? "partial" : ""}`,
            width: 20,
          },
        ],
        tooltip: (i) => {
          const m = months[i];
          if (!m || m.tmean === null) return null;
          return {
            title: monthLabel(m),
            rows: [
              { label: "Average", value: `${nf1.format(m.tmean)}°C` },
              { label: "Normal", value: `${nf1.format(m.tmeanNormal)}°C` },
              {
                label: "Difference",
                value: `${signed(anomalies[i] ?? 0, (n) => nf1.format(n))}°`,
                swatch: `${(anomalies[i] ?? 0) >= 0 ? "warm" : "cool"} box`,
              },
            ],
          };
        },
      };
    },
  };
  const update = timeChart(host, (views.season as () => TimeChartSpec)());
  segmented(
    $("rain-view"),
    [
      ["season", "Sooke Lake"],
      ...(city ? [["city", "Lake vs city"] as [string, string]] : []),
      ["temp", "Temperature"],
    ],
    "season",
    (k) => update((views[k] as () => TimeChartSpec)()),
  );
}

// ── Water use ────────────────────────────────────────────────────────────────────────────
function renderUse(d: D) {
  const { envelope, series, highest, lowest, trend } = d.demand;
  const cy = d.seasonal.currentYear;
  // RULE: annual comparisons use complete years only; a part year can't be set against whole ones.
  const years = d.demand.years.filter((y) => !y.partial);
  const UNIT = "million litres a day";
  const ys = years.map((y) => y.year);
  const yearTicks = (xs: number[]) => (_s: unknown, width: number) => {
    const every = width < 420 ? 4 : width < 760 ? 2 : 1;
    const lastYear = xs.at(-1) ?? 0;
    return xs
      .filter((y) => ((y - (xs[0] ?? 0)) % every === 0 && lastYear - y >= every) || y === lastYear)
      .map((y) => ({ v: y, label: width < 640 ? `’${String(y).slice(2)}` : String(y) }));
  };
  /** A padded y-domain on round steps, so a yearly line shows its change, not just its size. */
  const fitDomain = (vals: number[]): Pick<TimeChartSpec, "yDomain" | "yTicks"> => {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.25, hi * 0.02);
    const step = 10 ** Math.floor(Math.log10(Math.max(hi - lo + 2 * pad, 1))) / 2;
    const d0 = Math.max(0, Math.floor((lo - pad) / step) * step);
    const d1 = Math.ceil((hi + pad) / step) * step;
    // RULE: the ticks start at the domain's floor, so the lowest gridline is labelled.
    const tick = (d1 - d0) / step > 6 ? step * 2 : step;
    const yTicks: number[] = [];
    for (let v = d0; v <= d1 + 1e-9; v += tick) yTicks.push(v);
    return { yDomain: [d0, d1], yTicks };
  };
  /** One point a complete year for a per-year measure (litres per person, or people served). */
  const yearLineSpec = (
    pick: (y: (typeof years)[number]) => number | null,
    unit: string,
    label: string,
  ): TimeChartSpec => {
    const rows = years.filter((y) => pick(y) !== null);
    const xs = rows.map((y) => y.year);
    const vals = rows.map((y) => pick(y) as number);
    legend($("use-legend"), [["primary", label]]);
    return {
      x: xs,
      xDomain: [(xs[0] ?? 2009) - 0.4, (xs.at(-1) ?? 2025) + 0.4],
      ...fitDomain(vals),
      yFormat: (v) => nf0.format(v),
      yUnit: unit,
      xTicks: yearTicks(xs),
      height: responsiveHeight(300, 240),
      ariaLabel: label,
      layers: [{ kind: "line", y: vals, cls: "primary", smooth: false, dots: true, endDot: true }],
      tooltip: (i) => {
        const v = vals[i];
        return v === undefined
          ? null
          : { title: String(xs[i]), rows: [{ label: unit, value: nf0.format(v), swatch: "primary" }] };
      },
    };
  };
  const yearsSpec = (): TimeChartSpec => {
    legend($("use-legend"), [
      ["primary", "Average water use, each complete year"],
      ...(trend
        ? [
            ["trend", `Trend since ${trend.fromYear}: ${signed(trend.pctPerYear, (n) => nf1.format(n))}% a year`] as [
              string,
              string,
            ],
          ]
        : []),
    ]);
    return {
      x: ys,
      xDomain: [(ys[0] ?? 2009) - 0.4, (ys.at(-1) ?? 2025) + 0.4],
      ...fitDomain(years.map((y) => y.avgMld)),
      yFormat: (v) => nf0.format(v),
      yUnit: UNIT,
      xTicks: yearTicks(ys),
      height: responsiveHeight(300, 240),
      ariaLabel: "Average water use, each complete year, with its trend",
      layers: [
        { kind: "line", y: years.map((y) => y.avgMld), cls: "primary", smooth: false, dots: true, endDot: true },
        ...(trend
          ? [
              {
                kind: "line" as const,
                x: trend.line.map((p) => p[0]),
                y: trend.line.map((p) => p[1]),
                cls: "trend",
                smooth: false,
                hover: false,
              },
            ]
          : []),
      ],
      annotate: (g, xs, yScale) => {
        for (const [tag, y] of [
          ["highest", highest],
          ["lowest", lowest],
        ] as const) {
          const row = y && years.find((r) => r.year === y.year);
          if (!row) continue;
          el(
            "text",
            {
              x: xs(row.year),
              y: yScale(row.avgMld) + (tag === "highest" ? -10 : 18),
              "text-anchor": "middle",
              class: "bar-label",
            },
            g,
          ).textContent = tag;
        }
      },
      tooltip: (i) => {
        const y = years[i];
        if (!y) return null;
        return {
          title: String(y.year),
          rows: [
            { label: "Average", value: `${nf0.format(y.avgMld)} million L/day`, swatch: "primary" },
            { label: "Summer use", value: y.summerMld === null ? "–" : `${nf0.format(y.summerMld)} million L/day` },
          ],
        };
      },
    };
  };

  let picked = cy;
  const weeksSpec = (): TimeChartSpec => {
    const cur = (series[picked] ?? []) as [number, number][];
    legend($("use-legend"), [
      ["primary", String(picked)],
      ["median", "Typical"],
      ["band-faint box", "Most years"],
    ]);
    const hi = maxOf([...envelope.p90, ...cur.map((p) => p[1])], 200);
    return {
      x: Array.from({ length: 365 }, (_, i) => i + 1),
      xDomain: [1, 365],
      yDomain: [0, Math.ceil(hi / 50) * 50],
      yFormat: (v) => nf0.format(v),
      yUnit: UNIT,
      xTicks: monthTicks,
      height: responsiveHeight(300, 240),
      ariaLabel: `Weekly water use through ${picked} compared with other years`,
      layers: [
        { kind: "band", lo: envelope.p10, hi: envelope.p90, cls: "water-faint" },
        { kind: "line", y: envelope.median, cls: "median" },
        { kind: "line", x: cur.map((p) => p[0]), y: cur.map((p) => p[1]), cls: "primary", endDot: true },
      ],
      tooltip: (i) => {
        const doy = i + 1;
        const rows: TooltipRow[] = [];
        const c = interp(cur, doy, 10);
        if (c !== null)
          rows.push({ label: String(picked), value: `${nf0.format(c)} million L/day`, swatch: "primary" });
        rows.push({
          label: "Typical",
          value: `${nf0.format(envelope.median[i] ?? 0)} million L/day`,
          swatch: "median",
        });
        return { title: fmtDate(doyToIso(doy), false), rows };
      },
    };
  };

  const update = timeChart($("use-chart"), weeksSpec());
  const chips = $("use-chips");
  yearChips(
    chips,
    d.demand.years.map((y) => y.year),
    picked,
    (y) => {
      picked = y;
      update(weeksSpec());
    },
  );
  segmented(
    $("use-view"),
    [
      ["weeks", "Through the year"],
      ["years", "By year"],
      ...(d.demand.perPerson
        ? ([
            ["person", "Per person"],
            ["people", "Population"],
          ] as [string, string][])
        : []),
    ],
    "weeks",
    (k) => {
      chips.hidden = k !== "weeks";
      $("use-estimate").hidden = k !== "person" && k !== "people";
      update(
        k === "weeks"
          ? weeksSpec()
          : k === "person"
            ? yearLineSpec((y) => y.perPersonL, "litres a person a day", "Average use per person, each complete year")
            : k === "people"
              ? yearLineSpec((y) => y.population, "people", "People in the municipalities served, July 1")
              : yearsSpec(),
      );
    },
  );
}

// ── History ──────────────────────────────────────────────────────────────────────────────
function renderHistory(d: D) {
  const { dates, total } = d.history;
  const all = dates.map(dayNum);
  // Break the line where reports are missing for more than three weeks (a null point between).
  const points: { x: number; y: number | null; k: number }[] = [];
  all.forEach((x, i) => {
    if (i > 0 && x - (all[i - 1] as number) > 24) points.push({ x: x - 1, y: null, k: -1 });
    points.push({ x, y: total[i] ?? null, k: i });
  });
  const floor = Math.max(
    0,
    Math.floor(
      (minOf(
        total.filter((v): v is number => v !== null),
        50,
      ) -
        5) /
        10,
    ) * 10,
  );
  const spec = (): TimeChartSpec => {
    const shown = points;
    const xs = shown.map((p) => p.x);
    const yv = shown.map((p) => p.y);
    return {
      x: xs,
      yDomain: [floor, 100],
      yFormat: (v) => `${v}%`,
      xTicks: dateTicks,
      height: responsiveHeight(280, 220),
      ariaLabel: "Whole-system storage history",
      layers: [
        { kind: "area", y: yv, cls: "water" },
        { kind: "line", y: yv, cls: "primary", smooth: xs.length < 400, endDot: true },
      ],
      // Anchors: the record low and today, so the chart says on its own whether today is unusual.
      annotate: (g, xScale, yScale) => {
        let lowK = 0;
        total.forEach((v, k) => {
          if (v !== null && v < (total[lowK] ?? Number.POSITIVE_INFINITY)) lowK = k;
        });
        const lastK = total.length - 1;
        const mark = (k: number, text: string, anchor: "start" | "end") => {
          const v = total[k];
          if (v === null || v === undefined) return;
          el(
            "text",
            {
              x: xScale(all[k] as number) + (anchor === "start" ? 6 : -6),
              y: yScale(v) + 16,
              "text-anchor": anchor,
              class: "end-label",
            },
            g,
          ).textContent = text;
        };
        if (lowK !== lastK) mark(lowK, `${(dates[lowK] as string).slice(0, 4)} low: ${pct(total[lowK], 0)}`, "start");
        mark(lastK, `now ${pct(total[lastK], 0)}`, "end");
      },
      tooltip: (i) => {
        const k = shown[i]?.k;
        if (k === undefined || k < 0) return null;
        return {
          title: fmtDate(dates[k] as string),
          rows: [{ label: "Full", value: pct(total[k]), swatch: "primary" }],
        };
      },
    };
  };
  timeChart($("history-chart"), spec());
}

// ── Freshness ────────────────────────────────────────────────────────────────────────────
/** Build-time dates (`<time data-relative>`) as "3 days ago", against today in Victoria. */
function relativeDates() {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
  const rtf = new Intl.RelativeTimeFormat("en-CA", { numeric: "auto" });
  for (const t of document.querySelectorAll<HTMLTimeElement>("time[data-relative]")) {
    const days = dayNum(today) - dayNum(t.dateTime);
    if (days < 0) continue;
    t.title = fmtDate(t.dateTime);
    t.textContent = rtf.format(-days, "day");
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────────────────
function main() {
  const onScroll = () => document.body.classList.toggle("scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  relativeDates();
  water();
  // The parts of the build's payload this page draws, inlined by Base.astro (all of it: /data/dashboard.json).
  const d = JSON.parse(($("dashboard").textContent as string) || "null") as D;
  // Keyed by section id: each page draws only the sections it has.
  const sections: [string, (d: D) => void][] = [
    ["year", renderYear],
    ["outlook", renderOutlook],
    ["rain", renderRain],
    ["use", renderUse],
    ["history", renderHistory],
  ];
  for (const [name, render] of sections) {
    if (!document.getElementById(name)) continue;
    try {
      render(d);
    } catch (error) {
      console.error(`Failed to render ${name}`, error);
    }
  }
}

main();
