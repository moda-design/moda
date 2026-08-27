# Charts — the `<chart>` markup element

A chart is a single generated node: its bars/series/labels are rendered natively and are NOT individually addressable child nodes. Create with `moda canvas markup`; edit in place with `moda canvas edit` (below).

## Syntax

```xml
<chart type="bar" x="50" y="50" width="500" height="350"
       title="Quarterly Revenue" subtitle="FY 2025" color="#3b82f6"
       show-labels="true" y-format="compact">
  <data>
    category | value
    Q1       | 70
    Q2       | 50
  </data>
</chart>
```

**Data columns:** `category` + `value` (bar/line/area/pie), `x` + `y` (scatter), plus optional `series` for multi-series, `label` for custom display text, `size` for bubbles. The pipe-table header row is required.

**Single-series charts use `color` / `fill` / `stroke` on `<chart>` directly.** Multi-series charts use `palette="#3b82f6, #22c55e, …"` and/or per-series overrides:

```xml
<series name="Products" fill="linear-gradient(180deg, #3b82f6, #1d4ed8)" fill-opacity="0.85" shadow="0 2px 4px rgba(0,0,0,0.1)" />
<series name="Projected" stroke="#94a3b8" stroke-width="2" stroke-style="dashed" opacity="0.7" show-points="false" />
```

Shared chrome attributes: `title-size`, `title-weight`, `font-family`, `font-size`, `label-color`, `background`, `corner-radius`, `padding`, `show-legend`, `legend-position`, `show-grid`, `grid-style`, `grid-color`, `grid-width`, `show-x-axis`, `show-y-axis`, `axis-color`, `axis-width`, `show-x-labels`, `show-y-labels`, `x-tick-count`/`y-tick-count`, `x-format`/`y-format`, `x-scale` (`linear`/`log`/`time`, with `x-time-format`), `y-scale` (`linear`/`log`), `x-label`, `y-label`, `x-min`/`x-max`/`y-min`/`y-max`. That list is the real axis-display surface — attributes like `y-label-size` do not exist: axis tick labels take the chart-wide `font-size` and `label-color`, value labels take `value-label-size`/`value-label-color`.

**Chart type does not scale with the canvas.** It defaults to 12px whatever the size — legible in a 794px-wide document, sub-legible on a 1920×1080 slide or a poster. Set `font-size` explicitly (plus `title-size` and `value-label-size`) on any canvas wider than a page, then screenshot and read the axis labels before you call it done.

## Per-type attributes

- **Bar** — `mode="grouped" | "stacked" | "stacked-percent"`, `orientation="horizontal"` (pair with `bar-radius="0 6 6 0"`; vertical uses `bar-radius="6 6 0 0"`), `label-position="inside" | "outside" | "top"`.
- **Line / area** — `curve="linear" | "smooth" | "step" | "step-before" | "step-after" | "basis" | "cardinal" | "catmull-rom"`, `stroke-width`, `show-points`, `point-size`, `point-fill`, `point-shape="circle" | "square" | "diamond" | "triangle" | "triangle-down" | "cross" | "x" | "star"`. Area adds `mode="stacked"`, `fill`, `fill-opacity`, and inherits every line attribute. To hand a line off to a second series (actual → projected), repeat the overlap point in both series so the lines connect.
- **Scatter** — `point-opacity`, `point-size`, `show-trend-line`, `trend-style`. Add a `size` column for bubbles, with `size-scale="area" | "radius"`, `min-point-size`, `max-point-size`.
- **Combo** — `dual-axis="true"`, `left-axis-label` / `right-axis-label`, `left-axis-format` / `right-axis-format`, and per-series `chart-type="bar" | "line" | "area"` with `y-axis="left" | "right"`.
- **Pie / donut** — `type="donut"` is an alias for `type="pie"` and defaults `inner-radius` to `0.6`; `inner-radius` (`0` = pie, `0.5`–`0.7` = donut), `pad-angle`, `center-label`, `center-sublabel`, `label-format="value" | "percent" | "both" | "category"`, `label-position="inside" | "outside" | "callout" | "none"`, `explode="SliceName"` with `explode-distance`.

## Styling

`y-format="currency"` for money, `"compact"` for large numbers, `"percent"` for ratios (0–1 renders as 0–100%). A `label` column overrides display text per point (`$125K` instead of `125000`). `label-position="inside"` auto-contrasts label color against the bar fill.

## Editing existing charts

Prefer editing in place whenever the change keeps the same chart object — data, labels, title, axes, legend, mode, colors, series styling. Use the patch shorthand in `moda canvas edit` code, and preserve `x`, `y`, `width`, `height`, page, parent/group and layer position unless asked otherwise:

```js
update(chartId, {
  chartData: { columns: ['category', 'series', 'value'], data: [['Q1', 'NA', 120]] },
  chartConfig: { title: 'Regional Revenue', yFormat: 'compact', showLegend: true },
  chartSeries: [{ name: 'NA', fill: '#3b82f6' }],
});
```

Delete and recreate only when the user wants a structure charts can't express (waterfall, funnel, heatmap — rebuild with shapes), when it's no longer a chart (a table or cards), when the node is malformed or unfindable, or when an in-place update fails validation. Data preservation rules (references/design-quality.md) apply to every chart edit: N source bars → exactly N bars, same labels, same values.
