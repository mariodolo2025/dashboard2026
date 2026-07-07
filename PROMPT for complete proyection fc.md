# Add "Complete Projection" report to AIM 2026

## Context
We have an inventory dashboard called **AIM 2026** that already exists in this codebase. It includes a `Reports` dropdown button next to the date range / Sync / Export controls. The dropdown currently has three entries: **Future Projected Demand**, **Real Inbound Stock Curve**, **Container Feasibility**.

I need you to add a fourth entry called **Complete Projection** that opens a new modal. The modal answers this question:

> Given the demand calculated using the date range `1/1/2026 → 1/5/2026`, the global SOH and the units in the pipeline, **how many units of each SKU will I have on hand on a date that I select?**

## Where it goes
- Add `Complete Projection` as a new item at the **bottom** of the existing Reports dropdown (`AIM 2026` view). Mark it with a small purple `NEW` pill.
- Clicking it opens a full-screen modal centered on the AIM 2026 view (same overlay pattern used by other reports).

## Data model the report needs (per SKU)
Take this from the same source the AIM 2026 table already uses. Each row needs:

| Field        | Where it comes from                          |
| ---          | ---                                          |
| `sku`        | product SKU                                  |
| `group`      | Unleashed "Group" (the brand filter)         |
| `demand`     | units consumed in the demand window (already computed) |
| `sohMain`    | SOH in main warehouse                        |
| `sohChina`   | SOH in China warehouse                       |
| `dhl`        | units in DHL transit                         |
| `container`  | units in container transit                   |
| `onProd`     | units on production                          |
| `pipeline`   | `dhl + container + onProd`                   |
| `leadTime`   | lead time in days (e.g. 90)                  |
| `safety`     | safety stock units                           |
| `target`     | target stock units                           |

## Projection formula
For a date `D` chosen by the user, let `t = days_between(today, D)`:

```
SOH_global       = sohMain + sohChina + dhl + container
dailyDemand      = demand / demand_window_days           // demand_window_days = 120 for 1/1→1/5
pipelineReceived = pipeline * min(t / leadTime, 1)        // linear arrival
demandConsumed   = dailyDemand * t
projectedOnHand  = SOH_global + pipelineReceived − demandConsumed
daysOfCover      = max(projectedOnHand, 0) / dailyDemand
```

**Scenario multiplier on demand** (UI control):
- Optimistic: `demand × 0.85`
- Expected: `demand × 1.00`
- Pessimistic: `demand × 1.20`

**Status badge per SKU at the projection date:**
- `Stockout` — `projectedOnHand ≤ 0` (red)
- `At risk` — `projectedOnHand < safety` (amber)
- `Surplus` — `projectedOnHand > target × 2.5` (blue)
- `Healthy` — otherwise (green)

## Modal layout (top to bottom)

### Header
- Left: a small violet sparkle icon, title `Complete Projection`, a `NEW` pill, and a one-liner subtitle: `On-hand forecast per SKU · demand · global SOH · pipeline arrivals`
- Right: close button (X)

### Config strip (on a slightly off-white band)
Three controls in a row:
1. **Projection date** — a `<input type="date">` with calendar icon, today as min, today+365 as max, and a `+Nd` chip showing days from today. Below it, preset chips: `30d 60d 90d 120d 180d` (active preset = solid black).
2. **Demand window** — readonly chip showing `1 Jan 2026 → 1 May 2026 · 120d`. Pull these dates from the same date range the AIM 2026 view is using.
3. **Demand scenario** — segmented control with `Optimistic −15% / Expected 0% / Pessimistic +20%`. Selected option = solid black background, white text.

### Body — two-pane layout
- **Left pane (flex 1):** filterable SKU table card.
- **Right pane:** SKU detail panel, only renders when a row is selected. Width ~440px, slides in from the right.

### Footer
- Left: the formula in mono font: `On hand = SOH_global + Pipeline·min(t/LT,1) − DailyDemand·t`
- Right: `Close` / `Export projection` (dark) / `Create PO from stockouts` (amber gradient, primary).

## Table specs

**Header row of the card** has:
- Title "SKU-LEVEL PROJECTION" + subtitle showing the projection date and `X of Y SKUs · click a row for the curve`.
- Top-right: `Status` and `Export` pill buttons (visual only is fine).
- A second row: **search input** (icon-prefixed, placeholder `Search SKU…`) on the left, **Groups filter** dropdown on the right.

**Groups filter** behaviour:
- Multi-select checkbox dropdown listing every Group (Brand) available in Unleashed for the current AIM dataset.
- Button label = `All Groups` when empty, the single group name when 1 selected, `N groups` when more.
- A `Clear` button inside the dropdown when any are selected.
- When some are selected the trigger button switches to a violet-tinted style so it's obviously filtering.

**Columns** (in order):
1. `SKU` — blue link-style mono text. Shows a small external-link icon when this row is the selected one.
2. `Daily demand` — mono, 2 decimals.
3. `SOH global` — **expandable column**. Click the column header chevron to split it into two child columns: `Main` and `China`. When expanded, these two columns share a violet-tinted background and a banner row above them that says `SOH global breakdown` and collapses on click.
4. `Pipeline` — **expandable column**, same pattern. When expanded, splits into `DHL`, `Container`, `On Prod.` with the same violet background + banner.
5. `Consumed` — `−N` in red.
6. `On hand on date` — bold, larger; red if ≤ 0.
7. `Cover` — `Nd` (days of cover).
8. `Status` — colored pill (see status rules above).

**Row behaviour:**
- Click a row → opens the right side panel for that SKU; row gets a violet left-border accent and light violet background.
- Click the same row again (or the X in the side panel) → closes the panel.
- Rows where status is `At risk` or `Stockout` get a soft amber background even when not selected.

**Empty state:** if search + group filters yield no rows, show "No SKUs match the current filters" centered in the tbody.

**Sorting:** click any non-expandable column header to sort (asc/desc, arrow indicator). Default sort: `On hand on date` ascending so the worst SKUs are at the top.

## Side panel (right pane) specs
When a SKU is selected:

1. **Header:**
   - "SKU DETAIL" eyebrow
   - The SKU code (mono, large, bold)
   - The status pill
   - Close (X) on the right

2. **Projection chart** (SVG, ~420×180):
   - Y axis: units. X axis: months from today out to +180 days.
   - **Solid violet line + filled gradient area** = projection with pipeline arrivals.
   - **Dashed grey line** = demand-only (no pipeline) — shows what would happen without inbound.
   - **Dashed red line + label** = safety stock level.
   - **Solid black vertical line** at "today".
   - **Solid amber vertical line + circle marker + label tag** at the currently selected projection date. The label shows the date + projected units.
   - **Red dot + dashed red vertical line** at the day the SKU goes to zero (if it does within 180d).
   - Clicking anywhere on the chart moves the projection date marker to that day.

3. **Big number block** — "On-hand projection for <date>" eyebrow, then the projected units in large mono numerals, with the delta vs today below in green/red.

4. **Calculation breakdown** — a small white card with rows:
   ```
       SOH global today          NNN
   +   Pipeline received         NNN     (X% of P units)
   −   Demand consumed           NNN     (D u/day · N days)
   =   Projected on hand         NNN
   ```
   The `=` row sits in a slightly elevated white sub-card to emphasise it.

5. **Warehouse breakdown** — five rows of horizontal bars (`Main, China, DHL, Container, On Prod.`) each with a colored bar proportional to the largest value, label on the left, value on the right. Use blue for SOH warehouses and violet for pipeline ones.

6. **Key dates** — list:
   - `Projected stockout` — date + `in Nd` sub-label, red tone (or "No stockout within 365d / Safe / Pipeline covers all demand", green tone, if no stockout).
   - `Pipeline fully arrived` — date `today + leadTime` + `lead time Nd` sub-label.

## Visual / style conventions to match the rest of AIM 2026
- Font: same as AIM 2026 body (Inter or similar). All numbers use a monospace face (JetBrains Mono) with `font-variant-numeric: tabular-nums`.
- Colors:
  - Background: warm white `#ffffff`, page `#f7f7f5`
  - Borders: `#e8e8e3`, strong border `#d8d8d2`
  - Ink scale: `#0f1115 / #2a2f38 / #5b6270 / #828a98 / #b6bcc7`
  - Primary amber (CTA): `#f59e0b` gradient with `#3b1f00` text
  - Violet (this report's accent + AI features): `#7c3aed`, soft `#ede9fe`, ink `#4c1d95`
  - Red `#dc2626` / Green `#059669` / Blue `#2563eb`
- Card pattern: white bg, 1px `--line` border, `border-radius: 10–12px`, no shadow.
- Hover on table rows: very light warm grey, **not** a strong tint unless selected.

## Implementation hints (adapt to our stack)
- This codebase is React. Build it as a single `<CompleteProjectionModal />` component plus a few sub-components (`ProjectionTable`, `SkuProjectionPanel`, `SkuProjectionChart`, `GroupsFilter`).
- Reuse the existing Reports menu component; just add a new menu item that toggles modal open state.
- Reuse the existing date range source so `demand_window_days` and the "1 Jan 2026 → 1 May 2026" label come from one source of truth.
- The Unleashed Group list should come from the same selector the existing "All Groups" filter uses on the AIM 2026 toolbar.
- Persist nothing — the modal is read-only and stateless across sessions. (We can add Save Scenario later.)

## Acceptance checklist
- [ ] New "Complete Projection" item appears in Reports dropdown with a NEW pill.
- [ ] Modal opens / closes cleanly; backdrop-click closes it.
- [ ] Changing the projection date or scenario recalculates the table and the side panel **without** flicker.
- [ ] SOH global and Pipeline columns expand/collapse with chevrons + banner row.
- [ ] Search filters SKUs case-insensitively as you type.
- [ ] Groups filter is multi-select, syncs with the AIM 2026 group list, and visually indicates when active.
- [ ] Click row → side panel slides in with the correct SKU's chart, calculation, warehouse bars and key dates.
- [ ] Clicking on the chart sets the projection date globally.
- [ ] Empty state shown when filters yield zero rows.
- [ ] Default sort is `On hand on date` ascending; clicking headers re-sorts.
- [ ] Footer formula label and three buttons render.

## Out of scope (do NOT build yet)
- The Export projection CSV download (button can be visual-only).
- The Create PO from stockouts wire-up (button visual-only).
- Save scenarios / share links.
- Backend changes — assume all data is already in the existing AIM 2026 store.
