import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { format, subDays } from 'date-fns';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';

interface DateRange { from?: Date; to?: Date; }
interface WebUpgradeTabProps { dateRange?: DateRange; setDateRange?: (r: DateRange) => void; }
type Env = 'production' | 'preview' | 'all';

interface Dash {
  params: { from: string; to: string; environment: string };
  totals: { exposedSessions: number; totalEvents: number; directOrders: number; directLines: number; directRevenue: number; assistedOrders: number };
  modules: Array<{ module: string; sessions: number; views: number; selects: number; clicks: number; adds: number; ctr: number | null; addsPerSession: number | null }>;
  compatFunnel: { pageViews: number; modelSelect: number; addClicks: number; addSuccess: number; sessions: number; completeKit: number } | null;
  byBrand: Array<{ brand: string; selects: number; addClicks: number; adds: number }>;
  byScreen: Array<{ sku: string; fitment: string | null; title: string; clicks: number; adds: number; attributedRevenue: number; unitsPerWeek: number; baselineUnitsPerWeek: number; deltaPct: number | null }>;
  rewards: Array<{ name: string; unlocks: number; sessions: number }>;
  orderImpact: { upgradeOrders: number; upgradeAov: number | null; upgradeItems: number | null; otherOrders: number; otherAov: number | null; otherItems: number | null; aovLiftPct: number | null; itemsLiftPct: number | null } | null;
  bySource: Array<{ source: string; orders: number; lines: number; revenue: number; addedItems: number; addedPerOrder: number | null; aov: number | null; itemsPerOrder: number | null }>;
  byMachine: Array<{ machine: string; orders: number; lines: number; revenue: number }>;
  byFamily: Array<{ family: string; lines: number; revenue: number }>;
  trend: Array<{ d: string; events: number; sessions: number }>;
}

const HELP: Record<string, string> = {
  exposed: 'Distinct anonymous sessions (attribution_id) that fired at least one upgrade-module event in the period.',
  directRevenue: 'AUD revenue of order lines that were added by an upgrade module (line carries _pesado_source). Comes from Shopify orders via the sync — refreshed 3×/day (or on the main Update button), not instantly.',
  directOrders: 'Distinct orders that contain at least one upgrade-added line (direct attribution).',
  assisted: 'Orders linked to a prior module interaction via the order-level attribution id (from note_attributes). Requires the theme to write __pesado_* cart attributes. Like all sales here, refreshed with the Shopify sync (3×/day or on Update).',
  module: 'Per module: sessions exposed, views → clicks → confirmed adds, click-through rate (clicks ÷ views) and adds per session (a session can add more than once, so this is an average, not a percentage).',
  rewards: 'Reward tiers a shopper crossed during their session (free shipping / 10% off / 15% off). A tier only appears once a cart actually reached its threshold — if the basket stayed below $200, the 10% tier will not show even though free shipping did.',
  source: 'Direct sales grouped by the module that added the line (_pesado_source). AOV and items are the WHOLE basket of those orders, not just the added line. An order that used two modules is counted under each, so these rows do not sum to the totals.',
  impact: 'Orders that used an upgrade module vs every other order in the window, compared on the full basket. This is an observed difference between two groups of shoppers, not a controlled test — people who engage with an upgrade module may simply be buying more anyway.',
  machine: 'Direct sales grouped by the espresso machine the customer selected in the upgrade guide (pesado_machine). Tells you which machines drive the most upgrade revenue.',
  compat: 'The compatibility guide, end to end: landed on the page → picked their machine → clicked add → add confirmed. The middle step is the one that tells you whether the guide is actually being used.',
  brand: 'Which machine brand visitors picked in the guide. A brand with many picks but few adds means the guide finds their machine but the offer does not land.',
  screen: 'Only products a customer added THROUGH an upgrade module (machine finder or a recommendation). A product added with the normal Add-to-cart button is the base product, not a module add, so it will not appear here. Shows module clicks/adds plus sales now vs the frozen pre-launch run rate — the delta is a before/after observation (ad spend and seasonality move it too), not proof the modules caused it.',
  family: "Direct sales grouped by the purchased product's family (Shower Screens, Filter Baskets, Portafilters…), derived from the SKU with the same mapping as the E-commerce tab.",
  env: 'preview = test traffic (theme preview). production = live customers. Commercial stats use production.',
};

// Plain-language explanation of each on-site module, keyed by the exact label the
// RPC emits. Shown on hover of the module name in the By-module table.
const MODULE_HELP: Record<string, string> = {
  'Compatibility Guide': 'The dedicated Compatibility Guide page. The shopper browses by machine brand → model to find the parts that fit their machine, and can add them straight from the guide.',
  'Machine finder (product page)': 'The "Find your machine" tool built into a product page: the shopper picks their espresso machine and it shows — and adds — the exact shower screen that fits it. Screens added here appear under "By screen & product".',
  'Compatible Additions (product page)': 'The "Complete your setup" recommendations rendered ON the product page itself, while the shopper is still looking at the product (before opening the cart). Same look as the cart one — different place and different code, so we count them apart to see which surface actually converts.',
  'Compatible Additions (cart)': 'The "Complete your setup" recommendations that appear INSIDE the cart / mini-cart drawer (the panel in your screenshot), as the shopper reviews the basket right before checkout.',
  'Other': 'Events that did not match a known module (e.g. a new event name the theme started sending).',
};

const REWARD_LABEL: Record<string, string> = { free_shipping: 'Free shipping', discount_10: '10% off', discount_15: '15% off' };
const money = (v: number | null | undefined) => { const n = Number(v) || 0; return Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`; };
const int = (v: number | null | undefined) => (Number(v) || 0).toLocaleString('en-US');
const toYMD = (d: Date) => format(d, 'yyyy-MM-dd');

function Info({ k }: { k: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="wu-info" tabIndex={0} aria-label="What is this?">i</span></TooltipTrigger>
      <TooltipContent className="max-w-[280px] text-xs leading-relaxed">{HELP[k]}</TooltipContent>
    </Tooltip>
  );
}

// A hover target that shows explanatory text on the TEXT itself (dotted underline
// signals it), so you don't have to aim at a tiny "i".
function Tip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="wu-help">{children}</span></TooltipTrigger>
      <TooltipContent className="max-w-[300px] text-xs leading-relaxed">{content}</TooltipContent>
    </Tooltip>
  );
}
function HelpTitle({ k, children }: { k: string; children: ReactNode }) {
  return <Tip content={HELP[k]}>{children}</Tip>;
}
// Hoverable table-column header: the header text itself explains the column.
function Th({ children, tip, right }: { children: ReactNode; tip: string; right?: boolean }) {
  return <th className={right ? 'r' : undefined}><Tip content={tip}>{children}</Tip></th>;
}

export default function WebUpgradeTab({ dateRange, setDateRange }: WebUpgradeTabProps) {
  const [env, setEnv] = useState<Env>('production');
  const [data, setData] = useState<Dash | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo<DateRange>(() => {
    if (dateRange?.from && dateRange?.to) return dateRange;
    const now = new Date();
    return { from: subDays(now, 30), to: now };
  }, [dateRange]);

  const fetchData = useCallback(async () => {
    if (!range.from || !range.to) return;
    setLoading(true); setError(null);
    const { data: res, error: err } = await supabase.rpc('web_upgrade_performance', {
      p_from: toYMD(range.from), p_to: toYMD(range.to), p_environment: env,
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setData(res as Dash); setLoading(false);
  }, [range.from, range.to, env]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const t = data?.totals;
  const noData = !!data && (data.totals.totalEvents === 0);

  return (
    <TooltipProvider delayDuration={120}>
      <style>{WU_CSS}</style>
      <div className="wu">
        <div className="wu-head">
          <div>
            <div className="wu-eyebrow">Pesado · Website upgrades</div>
            <h1 className="wu-title">Web Upgrade <em>Performance</em></h1>
          </div>
          <span className="wu-pill"><span className="wu-live" />Live from DB</span>
        </div>

        <div className="wu-ctx">
          <div className="wu-seg" role="group" aria-label="Environment">
            {(['production', 'preview', 'all'] as Env[]).map((e) => (
              <button key={e} aria-pressed={env === e} onClick={() => setEnv(e)}>
                {e === 'production' ? 'Production' : e === 'preview' ? 'Preview (test)' : 'All'}
              </button>
            ))}
          </div>
          <Info k="env" />
          {setDateRange && (
            <div className="wu-seg">
              {[7, 30, 90].map((d) => (
                <button key={d} onClick={() => { const now = new Date(); setDateRange({ from: subDays(now, d), to: now }); }}>Last {d}d</button>
              ))}
            </div>
          )}
          <span className="wu-range tnum">{range.from && format(range.from, 'MMM d')} – {range.to && format(range.to, 'MMM d, yyyy')}</span>
          <Button variant="ghost" size="sm" className="h-8" onClick={fetchData} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {error && <div className="wu-err"><AlertTriangle className="h-4 w-4 shrink-0" /><span>{error}</span></div>}

        {t && (
          <>
            <div className="wu-kpis">
              <Kpi label="Exposed sessions" help="exposed" val={int(t.exposedSessions)} sub={`${int(t.totalEvents)} events`} accent />
              <Kpi label="Direct revenue" help="directRevenue" val={money(t.directRevenue)} sub={`${int(t.directLines)} lines`} accent />
              <Kpi label="Direct orders" help="directOrders" val={int(t.directOrders)} sub="with an upgrade line" />
              <Kpi label="Assisted orders" help="assisted" val={int(t.assistedOrders)} sub="via attribution id" />
            </div>

            {noData && (
              <div className="wu-empty">
                No <b>{env}</b> events in this window.{env === 'production' ? ' Switch to Preview (test) to see the test session, or wait for the theme to go live.' : ''}
              </div>
            )}

            {/* Module funnel */}
            <SectionH eyebrow="Funnel" title="By module" help="module" note="sessions → views → clicks → adds" />
            <div className="wu-card">
              {data!.modules.length === 0 ? <div className="wu-muted">No module events.</div> : (
                <table className="wu-table">
                  <thead><tr>
                    <Th tip="The on-site upgrade surface. Hover the name for what it is.">Module</Th>
                    <Th right tip="Distinct anonymous sessions that saw this module at least once.">Sessions</Th>
                    <Th right tip="Times the module was shown on screen (its panel or nudge appeared).">Views</Th>
                    <Th right tip="Times a shopper engaged the middle step — picked their machine, or opened a recommendation to look at it.">Picks</Th>
                    <Th right tip="Times a shopper clicked 'add' on something the module offered.">Clicks</Th>
                    <Th right tip="Times an add was confirmed by the cart — the item actually went in.">Adds</Th>
                    <Th right tip="Click-through rate: clicks ÷ views.">CTR</Th>
                    <Th right tip="Average confirmed adds per session. A session can add more than once, so this is an average, not a percentage.">Adds/sess</Th>
                  </tr></thead>
                  <tbody>
                    {data!.modules.map((m) => (
                      <tr key={m.module}>
                        <td className="wu-mod">{MODULE_HELP[m.module] ? <Tip content={MODULE_HELP[m.module]}>{m.module}</Tip> : m.module}</td>
                        <td className="r tnum">{int(m.sessions)}</td>
                        <td className="r tnum wu-dim">{int(m.views)}</td>
                        <td className="r tnum wu-dim">{int(m.selects)}</td>
                        <td className="r tnum wu-dim">{int(m.clicks)}</td>
                        <td className="r tnum">{int(m.adds)}</td>
                        <td className="r tnum">{m.ctr != null ? `${m.ctr}%` : '—'}</td>
                        <td className="r tnum" style={{ color: 'var(--wu-crema)', fontWeight: 600 }}>{m.addsPerSession != null ? m.addsPerSession.toFixed(2) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="wu-two">
              {/* Rewards */}
              <div className="wu-card">
                <div className="wu-klabel"><HelpTitle k="rewards">Reward unlocks</HelpTitle></div>
                {data!.rewards.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No rewards unlocked.</div> : (
                  <div style={{ marginTop: 10 }}>
                    {data!.rewards.map((rw) => (
                      <div key={rw.name} className="wu-row">
                        <span>{REWARD_LABEL[rw.name] ?? rw.name}</span>
                        <b className="tnum">{int(rw.unlocks)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {int(rw.sessions)} sess</span></b>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* Basket impact */}
              <div className="wu-card">
                <div className="wu-klabel"><HelpTitle k="impact">Basket impact</HelpTitle></div>
                {!data!.orderImpact || data!.orderImpact.upgradeOrders === 0 ? (
                  <div className="wu-muted" style={{ marginTop: 10 }}>
                    No upgrade orders yet in this window. Baseline for comparison: {data!.orderImpact ? `${int(data!.orderImpact.otherOrders)} orders, AOV ${money(data!.orderImpact.otherAov)}, ${data!.orderImpact.otherItems} items` : '—'}.
                  </div>
                ) : (
                  <div style={{ marginTop: 10 }}>
                    <div className="wu-row"><span>Used an upgrade module</span><b className="tnum">{money(data!.orderImpact.upgradeAov)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {data!.orderImpact.upgradeItems} items · {int(data!.orderImpact.upgradeOrders)} ord</span></b></div>
                    <div className="wu-row"><span>Every other order</span><b className="tnum">{money(data!.orderImpact.otherAov)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {data!.orderImpact.otherItems} items · {int(data!.orderImpact.otherOrders)} ord</span></b></div>
                    <div className="wu-row"><span>Difference</span>
                      <b className="tnum" style={{ color: (data!.orderImpact.aovLiftPct ?? 0) >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>
                        {data!.orderImpact.aovLiftPct == null ? '—' : `${data!.orderImpact.aovLiftPct > 0 ? '+' : ''}${data!.orderImpact.aovLiftPct}% AOV`}
                        {data!.orderImpact.itemsLiftPct != null && <span className="wu-faint" style={{ fontWeight: 400 }}> · {data!.orderImpact.itemsLiftPct > 0 ? '+' : ''}{data!.orderImpact.itemsLiftPct}% items</span>}
                      </b>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Compatibility guide — full funnel + brand split */}
            <SectionH eyebrow="Compatibility guide" title="Guide funnel" help="compat" note="landed → picked machine → clicked → added" />
            <div className="wu-two">
              <div className="wu-card">
                {!data!.compatFunnel || data!.compatFunnel.pageViews === 0 ? (
                  <div className="wu-muted">No compatibility-guide activity in this window.</div>
                ) : (
                  <div>
                    {(() => {
                      const f = data!.compatFunnel!;
                      const steps: Array<[string, number]> = [
                        ['Landed on the guide', f.pageViews],
                        ['Picked their machine', f.modelSelect],
                        ['Clicked add', f.addClicks],
                        ['Add confirmed', f.addSuccess],
                      ];
                      const top = Math.max(f.pageViews, 1);
                      return steps.map(([label, n], i) => {
                        const prev = i === 0 ? null : steps[i - 1][1];
                        return (
                          <div key={label} className="wu-step">
                            <div className="wu-step-h">
                              <span>{label}</span>
                              <b className="tnum">{int(n)}{prev != null && prev > 0 && (
                                <span className="wu-faint" style={{ fontWeight: 400 }}> · {Math.round((100 * n) / prev)}%</span>
                              )}</b>
                            </div>
                            <div className="wu-bar"><span style={{ width: `${(100 * n) / top}%` }} /></div>
                          </div>
                        );
                      });
                    })()}
                    <div className="wu-muted" style={{ marginTop: 10 }}>
                      {int(data!.compatFunnel!.sessions)} sessions · {int(data!.compatFunnel!.completeKit)} complete-kit adds
                    </div>
                  </div>
                )}
              </div>
              <div className="wu-card">
                <div className="wu-klabel"><HelpTitle k="brand">Machine brand picked</HelpTitle></div>
                {data!.byBrand.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No brand selections yet.</div> : (
                  <table className="wu-table" style={{ marginTop: 10 }}>
                    <thead><tr>
                      <Th tip="The machine brand the shopper selected in the compatibility guide.">Brand</Th>
                      <Th right tip="Times a shopper picked a machine of this brand in the guide.">Picked</Th>
                      <Th right tip="Times they clicked 'add' after picking this brand.">Clicked</Th>
                      <Th right tip="Confirmed adds after picking this brand.">Added</Th>
                    </tr></thead>
                    <tbody>
                      {data!.byBrand.map((b) => (
                        <tr key={b.brand}>
                          <td className="wu-mod">{b.brand}</td>
                          <td className="r tnum">{int(b.selects)}</td>
                          <td className="r tnum wu-dim">{int(b.addClicks)}</td>
                          <td className="r tnum" style={{ color: b.selects > 0 && b.adds === 0 ? 'var(--wu-neg)' : 'var(--wu-crema)', fontWeight: 600 }}>{int(b.adds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Per product: module engagement + sales vs the pre-launch baseline */}
            <SectionH eyebrow="Products" title="By screen &amp; product" help="screen" note="engagement + sales vs pre-launch run rate" />
            <div className="wu-card">
              {data!.byScreen.length === 0 ? <div className="wu-muted">No product-level events yet.</div> : (
                <table className="wu-table">
                  <thead><tr>
                    <Th tip="The product a shopper engaged with through an upgrade module.">Product</Th>
                    <Th tip="Which machine the screen fits, read from the SKU (e.g. Gaggia, Breville 54mm). For fitments shared by many brands, the SKU can't say the machine brand — that only comes from the machine the customer picked.">Fitment</Th>
                    <Th right tip="Module 'add' clicks for this product.">Clicks</Th>
                    <Th right tip="Confirmed adds of this product through a module.">Adds</Th>
                    <Th right tip="AUD revenue from real completed orders where this product's line was module-added. Test events have no order behind them, so this stays 0 in Preview.">Attributed</Th>
                    <Th right tip="Units of this product sold per week in the selected window — from real completed orders, NOT test events. 0 in Preview.">Units/wk now</Th>
                    <Th right tip="The frozen pre-launch weekly run-rate (old-theme baseline) for this product, for before/after comparison.">Pre-launch</Th>
                    <Th right tip="Change of units/week vs the pre-launch run-rate. Observational — ad spend and seasonality move it too. In Preview it reads -100% because test events have no real sales behind them.">Delta</Th>
                  </tr></thead>
                  <tbody>
                    {data!.byScreen.map((s) => (
                      <tr key={s.sku}>
                        <td className="wu-mod">{s.title}<div className="wu-mono wu-faint">{s.sku}</div></td>
                        <td className="wu-dim" style={{ fontSize: 12 }}>{s.fitment ?? '—'}</td>
                        <td className="r tnum">{int(s.clicks)}</td>
                        <td className="r tnum">{int(s.adds)}</td>
                        <td className="r tnum">{s.attributedRevenue > 0 ? money(s.attributedRevenue) : '—'}</td>
                        <td className="r tnum">{s.unitsPerWeek}</td>
                        <td className="r tnum wu-dim">{s.baselineUnitsPerWeek || '—'}</td>
                        <td className="r tnum" style={{ fontWeight: 600, color: s.deltaPct == null ? 'var(--wu-faint)' : s.deltaPct >= 0 ? 'var(--wu-pos)' : 'var(--wu-neg)' }}>
                          {s.deltaPct == null ? '—' : `${s.deltaPct > 0 ? '+' : ''}${s.deltaPct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Direct sales — machine + family split */}
            <div className="wu-two">
              <div className="wu-card">
                <div className="wu-klabel"><HelpTitle k="machine">Sales by machine</HelpTitle></div>
                {data!.byMachine.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No attributed sales yet — populates as real orders come in.</div> : (
                  <div style={{ marginTop: 10 }}>
                    {data!.byMachine.map((m) => (
                      <div key={m.machine} className="wu-row">
                        <span>{m.machine}</span>
                        <b className="tnum">{money(m.revenue)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {int(m.orders)} ord</span></b>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="wu-card">
                <div className="wu-klabel"><HelpTitle k="family">Sales by product family</HelpTitle></div>
                {data!.byFamily.length === 0 ? <div className="wu-muted" style={{ marginTop: 10 }}>No attributed sales yet — populates as real orders come in.</div> : (
                  <div style={{ marginTop: 10 }}>
                    {data!.byFamily.map((f) => (
                      <div key={f.family} className="wu-row">
                        <span>{f.family}</span>
                        <b className="tnum">{money(f.revenue)} <span className="wu-faint" style={{ fontWeight: 400 }}>· {int(f.lines)}</span></b>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Sales per module source, with the whole basket of those orders */}
            <SectionH eyebrow="Sales" title="By module source" help="source" note="attributed value + full basket of those orders" />
            <div className="wu-card">
              {data!.bySource.length === 0 ? <div className="wu-muted">No attributed sales yet — populates as real orders come in.</div> : (
                <table className="wu-table">
                  <thead><tr>
                    <Th tip="The _pesado_source tag the theme wrote on the added line — which module put the item in the cart.">Source</Th>
                    <Th right tip="Distinct orders that used this source.">Orders</Th>
                    <Th right tip="Order lines this source added.">Lines</Th>
                    <Th right tip="AUD revenue of just the lines this source added.">Attributed</Th>
                    <Th right tip="Average items this source added per order.">Added/order</Th>
                    <Th right tip="Average value of the WHOLE order (not just the added line) for orders that used this source.">AOV</Th>
                    <Th right tip="Average total items in those whole orders.">Items/order</Th>
                  </tr></thead>
                  <tbody>
                    {data!.bySource.map((s) => (
                      <tr key={s.source}>
                        <td className="wu-mono">{s.source}</td>
                        <td className="r tnum">{int(s.orders)}</td>
                        <td className="r tnum wu-dim">{int(s.lines)}</td>
                        <td className="r tnum" style={{ color: 'var(--wu-crema)', fontWeight: 600 }}>{money(s.revenue)}</td>
                        <td className="r tnum">{s.addedPerOrder ?? '—'}</td>
                        <td className="r tnum">{s.aov != null ? money(s.aov) : '—'}</td>
                        <td className="r tnum">{s.itemsPerOrder ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="wu-foot">
              <b>Data cadence:</b> the funnel (sessions, views, clicks, adds, rewards) updates in <b>real time</b> — the pixel sends each event instantly, so a refresh shows it. <b>Sales</b> (direct &amp; assisted) come from Shopify orders via the sync, refreshed <b>3×/day</b> (06:00 / 13:00 / 20:00 Brisbane) or on the main <b>Update</b> button — reaching checkout is not an order, only a completed purchase counts.<br />
              <b>Preview</b> = test traffic · <b>Production</b> = live customers. Assisted attribution lands once the theme's <b>__pesado_*</b> cart attributes reach the orders.
            </div>
          </>
        )}

        {loading && !t && (
          <div className="flex items-center justify-center min-h-[220px] gap-2"><Loader2 className="h-5 w-5 animate-spin wu-faint" /><span className="wu-faint">Loading…</span></div>
        )}
      </div>
    </TooltipProvider>
  );
}

function Kpi({ label, help, val, sub, accent }: { label: string; help: string; val: string; sub: ReactNode; accent?: boolean }) {
  return (
    <div className={cn('wu-card wu-kpi', accent && 'accent')}>
      <div className="wu-klabel"><HelpTitle k={help}>{label}</HelpTitle></div>
      <div className="wu-val">{val}</div>
      <div className="wu-sub">{sub}</div>
    </div>
  );
}
function SectionH({ eyebrow, title, help, note }: { eyebrow: string; title: string; help: string; note: string }) {
  return (
    <div className="wu-section-h">
      <div className="wu-eyebrow">{eyebrow}</div>
      <h2><HelpTitle k={help}>{title}</HelpTitle></h2>
      <span className="wu-faint" style={{ fontSize: 12.5 }}>{note}</span>
    </div>
  );
}

const WU_CSS = `
.wu{--wu-ground:#F4EEE3;--wu-card:#FFFFFF;--wu-card2:#FBF6EC;--wu-line:#E8DFCC;--wu-text:#241B12;--wu-dim:#786A53;--wu-faint:#A2937C;--wu-crema:#B9812A;--wu-crema2:#D19B34;--wu-crema-soft:rgba(201,138,41,.10);--wu-pos:#2E9E6E;--wu-neg:#C6513A;--wu-shadow:0 1px 2px rgba(60,40,10,.06),0 10px 34px rgba(60,40,10,.07);
  font-family:'Inter',system-ui,sans-serif;color:var(--wu-text);background:radial-gradient(1200px 500px at 12% -10%,var(--wu-crema-soft),transparent 60%),var(--wu-ground);padding:clamp(14px,2vw,22px);border-radius:16px}
.dark .wu{--wu-ground:#17120E;--wu-card:#221B15;--wu-card2:#2A2119;--wu-line:#33291E;--wu-text:#F2EADF;--wu-dim:#B7A991;--wu-faint:#87795F;--wu-crema:#E9B252;--wu-crema2:#F0C877;--wu-crema-soft:rgba(233,178,82,.13);--wu-pos:#5BC08E;--wu-neg:#E0725A;--wu-shadow:0 1px 2px rgba(0,0,0,.4),0 8px 30px rgba(0,0,0,.28)}
.wu h1,.wu h2{font-family:'Fraunces',Georgia,serif}
.wu .tnum{font-variant-numeric:tabular-nums}.wu-faint{color:var(--wu-faint)}.wu-dim{color:var(--wu-dim)}.wu-mono{font-family:ui-monospace,monospace;font-size:12px}
.wu-info{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;border:1px solid var(--wu-faint);color:var(--wu-faint);font-size:9px;font-weight:700;cursor:help;line-height:1;vertical-align:middle}
.wu-info:hover,.wu-info:focus{border-color:var(--wu-crema);color:var(--wu-crema);outline:none}
.wu-help{border-bottom:1px dashed var(--wu-faint);cursor:help;transition:border-color .15s,color .15s}
.wu-help:hover,.wu-help:focus{border-bottom-color:var(--wu-crema);color:var(--wu-crema);outline:none}
.wu-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:18px}
.wu-eyebrow{font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--wu-crema)}
.wu-title{font-size:clamp(24px,3vw,36px);font-weight:600;letter-spacing:-.01em;line-height:1.05;margin-top:6px}.wu-title em{font-style:italic;color:var(--wu-crema)}
.wu-pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--wu-dim);background:var(--wu-card);border:1px solid var(--wu-line);border-radius:999px;padding:7px 14px}
.wu-live{width:7px;height:7px;border-radius:50%;background:var(--wu-pos)}
.wu-ctx{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
.wu-seg{display:inline-flex;background:var(--wu-card);border:1px solid var(--wu-line);border-radius:999px;padding:3px}
.wu-seg button{font-size:12px;font-weight:500;color:var(--wu-dim);background:none;border:none;padding:6px 13px;border-radius:999px;cursor:pointer;transition:.18s;white-space:nowrap}
.wu-seg button[aria-pressed="true"]{background:var(--wu-crema);color:#20160a;font-weight:600}
.wu-range{font-size:12px;color:var(--wu-dim)}
.wu-err{display:flex;gap:8px;align-items:center;color:var(--wu-neg);border:1px solid var(--wu-neg);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px}
.wu-empty{background:var(--wu-crema-soft);border:1px solid var(--wu-line);border-radius:12px;padding:12px 16px;font-size:13px;color:var(--wu-dim);margin-bottom:14px}
.wu-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.wu-card{background:linear-gradient(158deg,var(--wu-card),var(--wu-card2));border:1px solid var(--wu-line);border-radius:16px;padding:18px;position:relative;box-shadow:var(--wu-shadow);overflow:hidden}
.wu-card.accent::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--wu-crema),transparent 70%)}
.wu-klabel{font-size:12px;font-weight:500;color:var(--wu-dim);display:flex;align-items:center;gap:6px}
.wu-val{font-size:clamp(22px,2.4vw,30px);font-weight:600;letter-spacing:-.02em;margin-top:10px;line-height:1;font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.wu-sub{font-size:11.5px;color:var(--wu-faint);margin-top:7px}
.wu-section-h{display:flex;align-items:baseline;gap:12px;margin:28px 2px 14px;flex-wrap:wrap}
.wu-section-h h2{font-size:18px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:7px}
.wu-two{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
.wu-table{width:100%;border-collapse:collapse;font-size:13px}
.wu-table th{text-align:left;font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--wu-faint);padding:0 0 10px;border-bottom:1px solid var(--wu-line)}
.wu-table th.r,.wu-table td.r{text-align:right}
.wu-table td{padding:11px 0;border-bottom:1px solid var(--wu-line)}
.wu-table tr:last-child td{border-bottom:none}
.wu-mod{font-weight:600;font-family:'Fraunces',Georgia,serif}
.wu-row{display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid var(--wu-line)}
.wu-row:last-child{border-bottom:none}.wu-row b{font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.wu-muted{font-size:12.5px;color:var(--wu-faint)}
.wu-step{margin-bottom:12px}.wu-step:last-of-type{margin-bottom:0}
.wu-step-h{display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px}
.wu-step-h b{font-family:'Fraunces',Georgia,serif;font-variant-numeric:tabular-nums}
.wu-bar{height:7px;border-radius:999px;background:var(--wu-crema-soft);overflow:hidden}
.wu-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--wu-crema),var(--wu-crema2))}
.wu-foot{margin-top:24px;padding-top:16px;border-top:1px solid var(--wu-line);font-size:12px;color:var(--wu-faint);line-height:1.7}.wu-foot b{color:var(--wu-dim);font-weight:600}
@media (max-width:900px){.wu-kpis{grid-template-columns:repeat(2,1fr)}.wu-two{grid-template-columns:1fr}}
`;
