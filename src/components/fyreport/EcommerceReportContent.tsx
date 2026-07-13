// E-commerce EOFY — the marketing dashboard as a frozen fiscal-year report.
// Reuses EcommerceTab in report mode (FY-locked, presets only, paper palette,
// print-friendly). Lives in the Reports overlay next to the FY Report.
import EcommerceTab from '@/components/EcommerceTab';

export function EcommerceReportContent() {
  return (
    <div className="h-full overflow-y-auto bg-[#f7f2e9] px-5 py-5">
      <EcommerceTab mode="report" />
    </div>
  );
}
