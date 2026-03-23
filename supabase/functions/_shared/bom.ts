/**
 * Shared BOM CSV download + parse for aim2026-csv-load and aim2026-get-dashboard.
 * Unleashed exports: BOM_YYYY.MM.DD_*.csv, BillOfMaterialsList.csv, etc.
 */
import { parse } from "https://deno.land/std@0.224.0/csv/parse.ts";

export interface BomComponentRow {
  assembly_sku: string;
  component_sku: string;
  quantity_per_assembly: number;
}

const BOM_KEYWORDS: Record<string, string[]> = {
  "Assembly Product Code": [
    "assembly product code",
    "assembly product",
    "assembly",
    "product code",
    "productcode",
    "sku",
  ],
  "Component Product Code": [
    "component product code",
    "component product",
    "component",
    "component code",
  ],
  Quantity: ["quantity", "qty", "*quantity"],
};

function normalizeHeaderCell(v: string): string {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/^\*+/, "");
}

function findBomHeaderRow(rows: string[][]): {
  headerIndex: number;
  headerMap: Record<string, number>;
} {
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const values = rows[i].map((v) => normalizeHeaderCell(String(v || "")));

    if (
      values.some(
        (v) =>
          v.includes("enquiry as of") ||
          v.includes("report") ||
          v.includes("generated")
      )
    ) {
      continue;
    }

    const meaningful = values.filter((v) => v && v.trim() !== "");
    if (meaningful.length < 3) continue;

    const headerMap: Record<string, number> = {};
    let matched = 0;

    for (const [stdName, kwList] of Object.entries(BOM_KEYWORDS)) {
      for (let col = 0; col < values.length; col++) {
        if (kwList.some((kw) => values[col].includes(kw))) {
          headerMap[stdName] = col;
          matched++;
          break;
        }
      }
    }

    const required = Object.keys(BOM_KEYWORDS).length;
    if (matched >= Math.ceil(required * 0.4)) {
      console.log(
        `BOM header row ${i}: ${matched}/${required} columns: ${JSON.stringify(headerMap)}`
      );
      return { headerIndex: i, headerMap };
    }
  }

  console.warn("BOM: no header row found, using row 0");
  return { headerIndex: 0, headerMap: {} };
}

function toNumber(v: unknown): number {
  if (v === undefined || v === null) return 0;
  let s = String(v).replace(/,/g, "").trim();
  if (/^\s*\(.*\)\s*$/.test(s)) s = "-" + s.replace(/[()]/g, "");
  s = s.replace(/[^0-9.-]/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

type StorageLike = {
  storage: {
    from: (b: string) => {
      list: () => Promise<{ data: unknown; error: Error | null }>;
      download: (n: string) => Promise<{ data: Blob | null; error: Error | null }>;
    };
  };
};

/** Latest BOM CSV from aim-csv-files or csv-files (same rules as csv-load). */
export async function downloadBOMFromBucket(supabase: StorageLike): Promise<Blob | null> {
  const buckets = ["aim-csv-files", "csv-files"];
  const FIXED_NAMES = ["BillOfMaterialsList.csv", "bom_cleaned_min.csv", "BOM.csv"];

  for (const bucket of buckets) {
    const { data: files, error } = await supabase.storage.from(bucket).list();
    if (error || !files || !Array.isArray(files) || files.length === 0) continue;

    const bomFiles = (files as { name: string; updated_at?: string }[]).filter(
      (f) =>
        (f.name.toLowerCase().startsWith("bom") ||
          f.name.toLowerCase().startsWith("billofmaterials")) &&
        f.name.toLowerCase().endsWith(".csv")
    );

    if (bomFiles.length > 0) {
      bomFiles.sort((a, b) =>
        (b.updated_at || "").localeCompare(a.updated_at || "")
      );
      const name = bomFiles[0].name;
      const { data, error: dlErr } = await supabase.storage.from(bucket).download(name);
      if (!dlErr && data) {
        console.log(`BOM: downloaded "${name}" from ${bucket} (${data.size} bytes)`);
        return data;
      }
    }
  }

  for (const name of FIXED_NAMES) {
    for (const bucket of buckets) {
      const { data, error } = await supabase.storage.from(bucket).download(name);
      if (!error && data) {
        console.log(`BOM: downloaded "${name}" from ${bucket}`);
        return data;
      }
    }
  }

  return null;
}

/**
 * Parse Unleashed BOM CSV → assembled SKUs + component rows (deduped by assembly+component).
 */
export function parseBomCsv(bomText: string): {
  assembledSKUs: Set<string>;
  components: BomComponentRow[];
} {
  const assembledSKUs = new Set<string>();
  const dedupe = new Map<string, BomComponentRow>();

  try {
    const rawData: string[][] = parse(bomText, { skipFirstRow: false, lazyQuotes: true });
    const { headerIndex, headerMap } = findBomHeaderRow(rawData);
    const dataRows = rawData.slice(headerIndex + 1);

    const assemblyCol = headerMap["Assembly Product Code"];
    const componentCol = headerMap["Component Product Code"];
    const qtyCol = headerMap["Quantity"];

    if (assemblyCol === undefined) {
      console.warn("BOM: no Assembly Product Code column found");
      return { assembledSKUs, components: [] };
    }

    let currentAssembly = "";
    for (const row of dataRows) {
      const assemblyVal = String(row[assemblyCol] ?? "").trim();
      if (assemblyVal) currentAssembly = assemblyVal;
      if (!currentAssembly) continue;

      assembledSKUs.add(currentAssembly);

      if (componentCol !== undefined) {
        const componentVal = String(row[componentCol] ?? "").trim();
        if (componentVal) {
          const qty = qtyCol !== undefined ? toNumber(row[qtyCol]) : 1;
          const qtyNum = qty > 0 ? qty : 1;
          const key = `${currentAssembly}\0${componentVal}`;
          dedupe.set(key, {
            assembly_sku: currentAssembly,
            component_sku: componentVal,
            quantity_per_assembly: qtyNum,
          });
        }
      }
    }

    console.log(
      `BOM parse: ${assembledSKUs.size} assemblies, ${dedupe.size} unique component lines`
    );
  } catch (e) {
    console.warn("BOM parse failed:", e);
  }

  return { assembledSKUs, components: Array.from(dedupe.values()) };
}

export async function insertBomComponentsBatched(
  supabase: {
    from: (t: string) => {
      insert: (r: unknown) => Promise<{ error: { message?: string } | null }>;
    };
  },
  rows: BomComponentRow[]
): Promise<void> {
  const BATCH = 400;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from("aim2026_bom_components").insert(batch);
    if (error) console.error(`aim2026_bom_components insert batch @${i}:`, error);
  }
}
