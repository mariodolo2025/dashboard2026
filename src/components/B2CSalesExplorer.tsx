// =============================================================================
// B2C Sales Explorer — type a SKU (or several), see what they did on Shopify
// =============================================================================
// The question this answers used to require reasoning about which table held
// what: AIM 2026 mixes wholesale with component usage, the E-commerce tab is
// store-wide. Here the unit of analysis is a SKU on one channel, over a window
// you choose. The body lives in B2CSalesPanel so the Web Upgrade tab can open
// the same thing as a dialog for the product row you clicked.

import { B2CSalesPanel, useB2CExplorerState } from '@/components/B2CSalesPanel';

export function B2CSalesExplorer() {
  const { state, patch } = useB2CExplorerState();

  return (
    <B2CSalesPanel
      skus={state.skus}
      onSkusChange={(skus) => patch({ skus })}
      from={state.from}
      to={state.to}
      onRangeChange={(from, to) => patch({ from, to })}
      granularity={state.granularity}
      onGranularityChange={(granularity) => patch({ granularity })}
      showTrend={state.showTrend}
      onShowTrendChange={(showTrend) => patch({ showTrend })}
    />
  );
}

export default B2CSalesExplorer;
