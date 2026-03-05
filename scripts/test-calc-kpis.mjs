#!/usr/bin/env node
/**
 * Test script for aim2026-calc-kpis-v2 edge function
 * Verifies that projectedDemand includes placed+parked for PSD-TampingStation
 * Run: node scripts/test-calc-kpis.mjs
 * Requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

let SUPABASE_URL = process.env.VITE_SUPABASE_URL;
let SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  try {
    const env = readFileSync(envPath, 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^VITE_SUPABASE_URL=(.+)$/);
      if (m) SUPABASE_URL = m[1].trim().replace(/^["']|["']$/g, '');
      const m2 = line.match(/^VITE_SUPABASE_ANON_KEY=(.+)$/);
      if (m2) SUPABASE_KEY = m2[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch (e) {
    console.error('Could not read .env. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
    process.exit(1);
  }
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
  process.exit(1);
}

const TARGET_SKU = 'PSD-TampingStation';
const startDate = '2026-02-01';
const endDate = '2026-02-28';
const rangeFrom = '2026-02-01';
const rangeTo = '2026-02-28';

async function callCalcKpis(demandMode) {
  const params = new URLSearchParams({
    startDate,
    endDate,
    rangeFrom,
    rangeTo,
    demandMode,
  });
  const url = `${SUPABASE_URL}/functions/v1/aim2026-calc-kpis-v2?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
    },
    body: JSON.stringify({
      startDate,
      endDate,
      rangeFrom,
      rangeTo,
      demandMode,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log('Testing aim2026-calc-kpis-v2 (Feb 1-28, 2026)\n');

  // Test 1: realDemand — expected: Sales(2) + Placed(49) = 51
  console.log('1. realDemand (Sales + Backordered + Placed):');
  const real = await callCalcKpis('realDemand');
  const realRow = real.data?.find((r) => r.sku === TARGET_SKU);
  const realDemand = realRow?.kpi_data?.projectedDemand ?? 'N/A';
  console.log(`   PSD-TampingStation projectedDemand: ${realDemand} (expected ~51)\n`);

  // Test 2: estimatedDemandParked — expected: 51 + Parked(5) = 56
  console.log('2. estimatedDemandParked (+ Parked):');
  const est = await callCalcKpis('estimatedDemandParked');
  const estRow = est.data?.find((r) => r.sku === TARGET_SKU);
  const estDemand = estRow?.kpi_data?.projectedDemand ?? 'N/A';
  console.log(`   PSD-TampingStation projectedDemand: ${estDemand} (expected ~56)\n`);

  // Summary
  const realOk = realDemand >= 45 && realDemand <= 60;
  const estOk = estDemand >= 50 && estDemand <= 65;
  const estHigher = estDemand > realDemand;

  console.log('--- Result ---');
  if (realOk && estOk && estHigher) {
    console.log('PASS: Demand values look correct (real < estimated, both include placed/parked)');
  } else if (realDemand === 2 && estDemand === 2) {
    console.log('FAIL: Both show 2 — edge function may not be using demand_detail (placed/parked). Redeploy?');
    process.exit(1);
  } else {
    console.log(`realDemand=${realDemand} (expected ~51), estimatedDemandParked=${estDemand} (expected ~56)`);
    if (!realOk || !estOk) process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
