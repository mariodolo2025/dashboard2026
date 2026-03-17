#!/usr/bin/env node
/**
 * Inspect ecommerce Meta tables - run: node scripts/inspect-ecommerce-tables.mjs
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

let supabaseUrl = process.env.VITE_SUPABASE_URL;
let key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !key) {
  try {
    const env = readFileSync(envPath, "utf8");
    for (const line of env.split("\n")) {
      const m1 = line.match(/^VITE_SUPABASE_URL=(.+)$/);
      const m2 = line.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/);
      const m3 = line.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/);
      if (m1) supabaseUrl = m1[1].trim().replace(/^["']|["']$/g, "");
      if (m2) key = m2[1].trim().replace(/^["']|["']$/g, "");
      if (m3 && !key) key = m3[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch (e) {}
}

if (!supabaseUrl || !key) {
  console.error("Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, key);

async function main() {
  console.log("=== ecommerce_meta_top_ads ===\n");

  const { data: topAds, error: e1 } = await supabase
    .from("ecommerce_meta_top_ads")
    .select("account_id, ad_id, ad_name, spend, impressions, clicks, purchases, purchase_value, rank")
    .order("account_id")
    .order("rank");

  if (e1) {
    console.error("Error:", e1.message);
  } else {
    console.log(`Rows: ${topAds?.length ?? 0}`);
    (topAds || []).slice(0, 10).forEach((r, i) => {
      console.log(`  ${i + 1}. ${r.ad_name} | spend=${r.spend} | purchases=${r.purchases} | impressions=${r.impressions}`);
    });
  }

  console.log("\n=== ecommerce_meta_daily_ads (date range) ===\n");

  const { data: dailyAds, error: e2 } = await supabase
    .from("ecommerce_meta_daily_ads")
    .select("date, account_id, ad_id, ad_name, spend, impressions, clicks, purchases, purchase_value")
    .order("date", { ascending: true });

  if (e2) {
    console.error("Error:", e2.message);
  } else {
    const dates = [...new Set((dailyAds || []).map((r) => r.date))].sort();
    console.log(`Rows: ${dailyAds?.length ?? 0}`);
    console.log(`Date range: ${dates[0] ?? "none"} to ${dates[dates.length - 1] ?? "none"}`);
    console.log(`Unique dates: ${dates.join(", ")}`);
    console.log("\nSample (first 15 rows):");
    (dailyAds || []).slice(0, 15).forEach((r, i) => {
      console.log(`  ${r.date} | ${r.ad_name} | spend=${r.spend} | purchases=${r.purchases}`);
    });
  }

  console.log("\n=== ecommerce_meta_daily (date range) ===\n");

  const { data: metaDaily, error: e3 } = await supabase
    .from("ecommerce_meta_daily")
    .select("date, account_id, spend, impressions, clicks")
    .order("date", { ascending: true });

  if (e3) {
    console.error("Error:", e3.message);
  } else {
    const dates = [...new Set((metaDaily || []).map((r) => r.date))].sort();
    console.log(`Rows: ${metaDaily?.length ?? 0}`);
    console.log(`Date range: ${dates[0] ?? "none"} to ${dates[dates.length - 1] ?? "none"}`);
  }

  console.log("\n=== daily_ads: ad names vs top_ads ===\n");
  const dailyAdNames = [...new Set((dailyAds || []).map((r) => r.ad_name))].sort();
  const topAdNames = (topAds || []).map((r) => r.ad_name);
  console.log("Ad names in top_ads:", topAdNames.join(" | "));
  console.log("Ad names in daily_ads (sample):", dailyAdNames.slice(0, 10).join(" | "));
  const overlap = dailyAdNames.filter((n) => topAdNames.some((t) => t.includes(n) || n.includes(t)));
  console.log("Overlap (matching):", overlap.length, overlap.slice(0, 5));
}

main();
