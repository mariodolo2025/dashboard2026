#!/usr/bin/env node
/**
 * Backfill ecommerce_shopify_daily with per-market data from "Orders by day" CSV.
 * Maps: USD→usa, AUD→australia, else→other. Converts revenue to USD.
 *
 * Run: node scripts/backfill-shopify-by-market.mjs [path-to-csv]
 * Default CSV: %USERPROFILE%\Downloads\Orders by day MARIO DASH 2026 - 2025-07-01 - 2026-03-16.csv
 *
 * Requires: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import Papa from "papaparse";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");

const AUD_TO_USD = 0.65;
const CURRENCY_TO_USD = {
  USD: 1,
  AUD: AUD_TO_USD,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.74,
  CHF: 1.13,
  SGD: 0.74,
  HKD: 0.13,
  JPY: 0.0067,
  CNY: 0.14,
  KRW: 0.00075,
  INR: 0.012,
  MYR: 0.22,
  THB: 0.029,
  PLN: 0.25,
  CZK: 0.044,
  SEK: 0.096,
  DKK: 0.14,
  SAR: 0.27,
  AED: 0.27,
  QAR: 0.27,
  ILS: 0.27,
  EGP: 0.02,
  PHP: 0.017,
  IDR: 0.000063,
  BND: 0.74,
  PEN: 0.26,
  MXN: 0.06,
  BRL: 0.2,
  RON: 0.22,
  BGN: 0.55,
  HUF: 0.0027,
  RSD: 0.009,
  UAH: 0.025,
  KZT: 0.0021,
  TWD: 0.031,
  VND: 0.00004,
  KHR: 0.00024,
  XOF: 0.0016,
  XPF: 0.009,
  MOP: 0.124,
  ISK: 0.0072,
  BAM: 0.55,
};

function currencyToMarket(currency) {
  const c = (currency || "").toUpperCase().trim();
  if (c === "USD") return "usa";
  if (c === "AUD") return "australia";
  return "other";
}

function toUsd(amount, currency) {
  const c = (currency || "").toUpperCase().trim();
  const rate = CURRENCY_TO_USD[c] ?? 0.5;
  return amount * rate;
}

function parseCSV(text) {
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
  return data || [];
}

async function main() {
  const csvPath =
    process.argv[2] ||
    resolve(
      process.env.USERPROFILE || process.env.HOME || ".",
      "Downloads",
      "Orders by day MARIO DASH 2026 - 2025-07-01 - 2026-03-16.csv"
    );

  let supabaseUrl = process.env.VITE_SUPABASE_URL;
  let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    try {
      const env = readFileSync(envPath, "utf8");
      for (const line of env.split("\n")) {
        const m1 = line.match(/^VITE_SUPABASE_URL=(.+)$/);
        const m2 = line.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/);
        if (m1) supabaseUrl = m1[1].trim().replace(/^["']|["']$/g, "");
        if (m2) serviceKey = m2[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch (e) {
      console.error("Could not read .env");
    }
  }

  if (!supabaseUrl || !serviceKey) {
    console.error("Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  let csvText;
  try {
    csvText = readFileSync(csvPath, "utf8");
  } catch (e) {
    console.error("Cannot read CSV:", csvPath, e.message);
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: creds } = await supabase
    .from("api_credentials")
    .select("store_url")
    .eq("provider", "shopify")
    .maybeSingle();

  let storeUrl = (creds?.store_url || "90ce69.myshopify.com").trim();
  if (storeUrl.startsWith("http")) storeUrl = storeUrl.replace(/^https?:\/\//, "").split("/")[0];
  if (!storeUrl.includes(".")) storeUrl += ".myshopify.com";

  const rows = parseCSV(csvText);
  if (rows.length === 0) {
    console.error("No rows parsed from CSV");
    process.exit(1);
  }

  const hasCurrency = "Order checkout currency" in rows[0];
  if (!hasCurrency) {
    console.error("CSV must have 'Order checkout currency' column");
    process.exit(1);
  }

  const dailyByMarket = {};
  for (const r of rows) {
    const dateStr = r.Month || r.Day || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr).slice(0, 10))) continue;
    const date = String(dateStr).slice(0, 10);
    const currency = String(r["Order checkout currency"] || "").trim();
    const market = currencyToMarket(currency);
    const orders = parseInt(String(r.Orders || 0), 10) || 0;
    const revenue = parseFloat(String(r["Total sales"] || 0).replace(/,/g, "")) || 0;
    const revenueUsd = toUsd(revenue, currency);

    if (!dailyByMarket[date]) dailyByMarket[date] = {};
    if (!dailyByMarket[date][market]) dailyByMarket[date][market] = { orders: 0, revenueUsd: 0 };
    dailyByMarket[date][market].orders += orders;
    dailyByMarket[date][market].revenueUsd += revenueUsd;
  }

  const upsert = [];
  for (const [date, markets] of Object.entries(dailyByMarket)) {
    for (const [market, d] of Object.entries(markets)) {
      upsert.push({
        date,
        store_url: storeUrl,
        market,
        order_count: d.orders,
        total_revenue: Math.round(d.revenueUsd * 100) / 100,
        currency: "USD",
      });
    }
  }

  console.log(`Upserting ${upsert.length} rows (store: ${storeUrl})...`);
  const { error } = await supabase.from("ecommerce_shopify_daily").upsert(upsert, {
    onConflict: "date,store_url,market",
  });

  if (error) {
    console.error("Upsert error:", error.message);
    process.exit(1);
  }
  console.log("Done.");
}

main();
