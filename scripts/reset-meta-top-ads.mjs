#!/usr/bin/env node
/**
 * Reset ecommerce_meta_top_ads - clears corrupted/double-counted data.
 * Run Load from CSV after this to reload correct data.
 *
 * Run: node scripts/reset-meta-top-ads.mjs
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
  const { error } = await supabase.from("ecommerce_meta_top_ads").delete().gte("id", 1);
  if (error) {
    console.error("Delete failed (RLS? Use SUPABASE_SERVICE_ROLE_KEY):", error.message);
    process.exit(1);
  }
  console.log("ecommerce_meta_top_ads cleared. Run Load from CSV to reload correct data.");
}

main();
