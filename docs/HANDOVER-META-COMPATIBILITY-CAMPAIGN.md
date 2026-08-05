# Handover — Meta campaign driving traffic to the Compatibility Guide

**For:** a separate working session focused on building the campaign.
**Written:** 2026-08-04. Figures cover **23 Jul – 4 Aug 2026** unless stated.
**You do not need this repo.** Everything below is the evidence and the
constraints; the work is in Meta Ads Manager and the Shopify theme.

---

## 1. The case in one paragraph

The Compatibility Guide converts **3.4× better than the machine finder** and
returns **4× more revenue per session** than any other module on the site, but
almost nobody is sent to it on purpose. It gets traffic only from people who
stumble onto it. A campaign pointed straight at it is the obvious move, and the
numbers below are what justifies it — and what constrains it.

---

## 2. Evidence

### Module performance, 23 Jul – 4 Aug

| Module | Sessions | Orders | Conversion | AUD / session | AOV |
|---|---|---|---|---|---|
| **Compatibility Guide** | 2,964 | 168 | **5.67%** | **$5.73** | $138.92 |
| Compatible Additions (cart) | 5,244 | 135 | 2.57% | $1.79 | $181.56 |
| Machine finder (product page) | 50,498 | 839 | 1.66% | $1.39 | $99.40 |
| Compatible Additions (product page) | 10,902 | 32 | 0.29% | $0.18 | $146.56 |

Read the first two columns together: the machine finder gets **17× the traffic**
of the guide and produces only 5× the orders. The guide is the most efficient
surface on the site and the least fed.

### The guide's own funnel

| Step | Count | Rate |
|---|---|---|
| Page views | 4,646 | — |
| Model selected | 4,357 | 94% of views |
| Add-to-cart clicked | 746 | 17% of selections |
| Add succeeded | 734 | 98% of clicks |
| **Orders** | **168** | **5.67% of sessions** |

The drop is at one step only: **selection → add (17%)**. Everything before it is
near-perfect — people who land on the guide do use it. That is the number a
campaign will move or fail to move, and the one to watch.

`completeKit` — the "buy the whole set" path — drove 339 events and 14 orders at
**$162 AOV**, the highest of any source. Worth a creative of its own.

### Who is searching, and for what

Brand selections:

| Brand | Selections | Adds |
|---|---|---|
| **Breville / Sage** | 3,546 | 588 |
| De'Longhi | 227 | 32 |
| Gaggia | 135 | 17 |
| La Marzocco | 69 | 11 |
| Lelit / Rocket / Rancilio / Quick Mill | ~140 combined | ~33 |

**Breville is 88% of all demand.** Everything else is a rounding error at
campaign scale. Top models, with selections and adds:

| Model | Selections | Adds | Add rate |
|---|---|---|---|
| Barista Express / Sage | 884 | 155 | 17.5% |
| Barista Express Impress | 362 | 50 | 13.8% |
| The Barista Touch | 305 | 54 | 17.7% |
| The Barista Pro | 295 | 52 | 17.6% |
| The Barista Touch Impress | 228 | 46 | 20.2% |
| The Bambino Plus | 207 | 48 | **23.2%** |
| The Dual Boiler | 204 | 32 | 15.7% |
| The Oracle | 173 | 39 | 22.5% |
| The Oracle Jet | 173 | 15 | **8.7%** |
| The Bambino | 151 | 15 | **9.9%** |

Those add rates are the targeting signal. **Bambino Plus (23.2%) and Oracle
(22.5%) convert more than twice as well as Oracle Jet (8.7%) and Bambino
(9.9%)** on comparable traffic. Ad sets by machine model, not by brand.

### What actually sells through the guide

| SKU | Product | Orders | Revenue AUD |
|---|---|---|---|
| PSD-HD-BR54 | HD Shower Screen — Breville 54mm | 110 | $8,911 |
| PSD-HD-BR58 | HD Shower Screen — Breville 58mm | 26 | $2,186 |
| PF02BR54-BBK-HY | Hybrid Breville Portafilter | 4 | $719 |
| PSD-HE-XL | He[%] High Extraction Basket | 1 | $558 |

**One product is 76% of guide revenue: the 54mm shower screen.** The creative
should almost certainly lead with it, and the landing experience should not
bury it.

### Store context

- Modules touched **58.2% of all store orders** and **50.5% of revenue** in the
  window.
- Store AOV before the launch (frozen 84-day baseline, 29 Apr – 21 Jul, 14,939
  orders): **$103.96**. Guide AOV is **$138.92** — about **34% higher**.

---

## 3. Constraints and traps

Read these before writing a media plan. Each one is a measured fact, not an
opinion.

**Meta is already ~85% of the business.** Between 83% and 89% of store revenue
passes through a Meta ad first. This campaign competes with existing campaigns
for the same audience — expect cannibalisation, and plan how to tell it apart
(geo holdout or a clean incrementality window).

**July was a creative-fatigue month, and it is not fully over.** June → July:
CPM flat (+1%), CTR −11%, cost per purchase +30% ($36.04 → $46.93), Meta ROAS
−27% (2.63 → 1.93). Reaching people costs the same; convincing them costs 30%
more. New creative launched 23 July is measurably better — ROAS 2.35 vs 1.78,
CTR 1.87% vs 1.39%, cost per purchase $48.89 vs $62.44 — but carries only
**11% of spend**. Shifting budget to the new sets is likely cheaper than any new
campaign, and should probably happen first or alongside.

**Do not cut spend to fund this.** Roughly 40% of Meta spend does prospecting;
cutting it drops the top of the funnel and revenue falls more than
proportionally, with a 4–8 week lag. Fund the campaign as incremental budget or
by reallocating within Meta, not by pausing.

**The guide page is a poor mobile experience relative to desktop.** Same page,
different behaviour: the mobile entry bar converts at **1.24% CTR vs 3.24% on
desktop**, and on product pages it is 0.84% vs 2.24%. If the campaign sends
mostly mobile traffic — it will — the landing experience needs checking before
spend goes live. Fixing the mobile bar may be worth more than the campaign.

**Attribution is by last-touch source tag.** An order counts to the guide only
if a line carried `_pesado_source = compatibility_*`. A user who uses the guide
and then buys from a product page three days later is credited to the product
page. Guide revenue here is a floor, not a ceiling.

---

## 4. What to build (a starting shape, not a prescription)

1. **Landing page**: `/pages/compatibility-guide`. Confirm it accepts a
   pre-selected machine via URL parameter — if the ad says "Barista Express"
   the guide should open already filtered. If it cannot, that is the first
   development task, and it matters more than the creative.
2. **Ad sets by model**, not by brand. Start with the five highest add rates:
   Bambino Plus, Oracle, Barista Touch Impress, Barista Touch, Barista Pro.
3. **Creative** leads with the 54mm shower screen — 76% of guide revenue — and
   the "will it fit my machine" question, which is the job the guide does.
4. **Consider a complete-kit variant**: $162 AOV, the highest of any source.
5. **Success metric**: cost per purchase, not ROAS or CTR. It is the number
   that moved first when the new July creative started working, and it is
   directly comparable to the $46.93 the account currently pays.

---

## 5. Where the numbers live

Everything above is reproducible from the dashboard at
**dashboard2026.dolo.au**:

- **Web Upgrade** tab → Daily brief and Modules views (module table, funnel,
  brands, models, entry point mobile vs desktop).
- **E-commerce** tab → "Ads by spend" section (per-ad ROAS, CTR, cost per
  purchase, new-vs-existing creative).
- **B2C Sales Explorer** → any SKU's Shopify sales, by day/week/month.

Data refreshes 3× a day. Money is in AUD with USD in brackets; every amount
excludes sales tax, matching Shopify's Net sales.

**One caveat on dates.** Web Upgrade events are bucketed by **UTC day** while
sales are bucketed by **Brisbane day**. Range totals are comparable; day-for-day
comparisons across the two tabs are not exact. This is a settled decision, not a
bug — the underlying sales data only ever stored a store-local day.

---

## 6. Open question worth resolving early

Is the guide good because of what it does, or because of **who reaches it**?
Today it is found mostly by people already deep in a decision — that is a
selected audience, and cold traffic from Meta will not be the same people. The
5.67% conversion is the best case, not the expected case.

The cheapest way to find out is a small test budget against one model
(Barista Express, the largest at 884 selections) before committing to the full
build. If cost per purchase lands anywhere near $46.93, the case is proven; if
it lands at double, the guide's strength was the audience, not the page.
