import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format } from 'date-fns';
import Papa from 'papaparse';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface CSVColumn {
  header: string;
  key: string;
  formatter?: (value: any) => string;
}

export function downloadCSV(
  data: any[],
  filename: string,
  columns: CSVColumn[]
): void {
  if (!data || data.length === 0) {
    console.warn('No data to download');
    return;
  }

  // Create CSV header
  const headers = columns.map(col => col.header);
  
  // Create CSV rows
  const rows = data.map(item => {
    return columns.map(col => {
      const value = item[col.key];
      const formattedValue = col.formatter ? col.formatter(value) : String(value || '');
      
      // Escape quotes and wrap in quotes if contains comma, quote, or newline
      if (formattedValue.includes(',') || formattedValue.includes('"') || formattedValue.includes('\n')) {
        return `"${formattedValue.replace(/"/g, '""')}"`;
      }
      return formattedValue;
    });
  });

  // Combine headers and rows
  const csvContent = [headers, ...rows]
    .map(row => row.join(','))
    .join('\n');

  // Create and trigger download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// Helper functions for PO to TX functionality
export function excelColToIndex(colLetter: string): number {
  let result = 0;
  for (let i = 0; i < colLetter.length; i++) {
    result = result * 26 + (colLetter.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
  }
  return result - 1; // Convert to 0-indexed
}

export function parseCsvText(csvText: string): string[][] {
  // Normalize line endings: handle \r\n, \r, and \n
  const normalized = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const result: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];

    if (char === '"') {
      if (inQuotes && normalized[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      row.push(current);
      current = '';
    } else if (char === '\n' && !inQuotes) {
      // End of row
      row.push(current);

      // Only add non-empty rows (skip completely blank lines)
      if (row.some(field => field.trim() !== '')) {
        result.push(row);
      }

      row = [];
      current = '';
    } else {
      current += char;
    }
  }

  // Add the last field and row if there's content
  if (current || row.length > 0) {
    row.push(current);
    if (row.some(field => field.trim() !== '')) {
      result.push(row);
    }
  }

  return result;
}

export function generateCsvString(data: string[][]): string {
  return data.map(row =>
    row.map(field => {
      // Escape quotes and wrap in quotes if contains comma, quote, or newline
      if (field.includes(',') || field.includes('"') || field.includes('\n')) {
        return `"${field.replace(/"/g, '""')}"`;
      }
      return field;
    }).join(',')
  ).join('\n');
}

export function normalizeCode(sku: string): string {
  if (!sku) return '';

  let normalized = sku
    .normalize('NFKC')
    .trim();

  // Replace all Unicode dash variants with ASCII hyphen-minus (U+002D)
  normalized = normalized
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');

  // Remove zero-width characters
  normalized = normalized
    .replace(/[\u200B\u200C\u200D\u2060]/g, '');

  // Remove \r characters
  normalized = normalized.replace(/\r/g, '');

  // Normalize spaces around dashes: \s*-\s* -> "-"
  normalized = normalized.replace(/\s*-\s*/g, '-');

  // Collapse multiple spaces to single space
  normalized = normalized.replace(/\s+/g, ' ');

  // Final trim and uppercase
  normalized = normalized.trim().toUpperCase();

  return normalized;
}

export function getSecondaryKey(canonicalKey: string): string {
  // Remove all spaces for secondary key
  return canonicalKey.replace(/\s/g, '');
}

export function normalizeQuantity(qty: string): string | null {
  if (!qty) return null;

  let normalized = qty
    .replace(/[\u00A0\u202F]/g, '') // Remove NBSP
    .replace(/\r/g, '')
    .trim();

  // Check if it's a valid number (including negative)
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return normalized;
  }

  return null;
}

export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

export interface CodeMapEntry {
  canonicalKey: string;
  quantity: string;
  rawCode: string;
  rawQuantity: string;
  csvRow: number;
}

export interface MichelleCodeMap {
  codeMap: Map<string, CodeMapEntry>;
  secondaryIndex: Map<string, string[]>;
}

export function parseMichelleCsvWithPapa(csvText: string, debugVerbose = true): MichelleCodeMap {
  const result = Papa.parse<string[]>(csvText, {
    header: false,
    skipEmptyLines: 'greedy',
    delimiter: ',',
    dynamicTyping: false,
  });

  const data = result.data;

  if (debugVerbose) {
    console.log('\n╔════════════════════════════════════════════════════════╗');
    console.log('║              PAPA PARSE RESULTS                        ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`Total rows parsed: ${data.length}`);
    console.log(`Parse errors:`, result.errors.length > 0 ? result.errors : 'None');

    // Show first 35 rows to detect gaps in parsing
    console.log('\nFirst 35 rows parsed (showing row index and content):');
    for (let i = 0; i < Math.min(35, data.length); i++) {
      const row = data[i];
      const colJ = row[9] || '';
      const colQ = row[16] || '';
      console.log(`  Index ${i} (Row ${i + 1}): ${row.length} cols, J="${colJ.substring(0, 30)}", Q="${colQ}"`);
    }
    console.log('═══════════════════════════════════════════════════════\n');
  }

  const codeMap = new Map<string, CodeMapEntry>();
  const secondaryIndex = new Map<string, string[]>();

  if (data.length === 0) {
    console.error('ERROR: No data parsed from Michelle CSV');
    return { codeMap, secondaryIndex };
  }

  // AUTO-DETECT HEADER ROW
  let headerRowIndex = -1;
  const headerVariants = {
    J: ['ITEM', 'SKU', 'CODE', 'PRODUCT'],
    Q: ['STOCK', 'QTY', 'QUANTITY', 'SOH']
  };

  if (debugVerbose) {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║          DETECTING REAL HEADER ROW                     ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('Looking for header row with J="Item/SKU/Code" and Q="Stock/Qty"...\n');
  }

  for (let i = 0; i < Math.min(20, data.length); i++) {
    const row = data[i];
    const colJ = (row[9] || '').trim().normalize('NFKC').toUpperCase();
    const colQ = (row[16] || '').trim().normalize('NFKC').toUpperCase();

    if (debugVerbose) {
      console.log(`Row ${i + 1}: J="${colJ}", Q="${colQ}"`);
    }

    const matchJ = headerVariants.J.some(variant => colJ.includes(variant));
    const matchQ = headerVariants.Q.some(variant => colQ.includes(variant));

    if (matchJ && matchQ) {
      headerRowIndex = i;
      if (debugVerbose) {
        console.log(`\n✓ HEADER ROW DETECTED at Row ${i + 1} (index ${i})`);
        console.log(`  J="${row[9]}", Q="${row[16]}"`);
      }
      break;
    }
  }

  if (headerRowIndex === -1) {
    console.error('\n❌ ERROR: HeaderNotDetected');
    console.error('Could not find valid header row with Item/SKU in column J and Stock/Qty in column Q');
    console.error('Checked first 20 rows. CSV might be malformed or using different structure.');
    return { codeMap, secondaryIndex };
  }

  const headerRow = data[headerRowIndex];
  const headerLength = headerRow.length;
  const dataStart = headerRowIndex + 1;

  if (debugVerbose) {
    console.log(`\nHeader row index: ${headerRowIndex} (Row ${headerRowIndex + 1})`);
    console.log(`Data starts at index: ${dataStart} (Row ${dataStart + 1})`);
    console.log(`Header length: ${headerLength} columns`);
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║     USING INDEX-BASED MAPPING (J=9, Q=16)             ║');
    console.log(`║     FROM dataStart=${dataStart} (Row ${dataStart + 1})                          ║`);
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('This avoids using empty/decorative headers from Row 1\n');

    console.log('First 5 data rows with normalization preview:');
    for (let i = dataStart; i < Math.min(dataStart + 5, data.length); i++) {
      const row = data[i];
      const Jraw = row[9] || '';
      const Qraw = row[16] || '';
      const Jnorm = normalizeCode(Jraw);
      const Qnorm = normalizeQuantity(Qraw);
      console.log(`  Row ${i + 1}: [${Jraw}] → "${Jnorm}" | [${Qraw}] → ${Qnorm}`);
    }
    console.log('═══════════════════════════════════════════════════════\n');
  }

  // Process rows starting from dataStart
  const startRow = dataStart;

  // Track all codes found for the complete listing
  const allCodesFound: Array<{csvRow: number; rawCode: string; reason: string}> = [];

  for (let i = startRow; i < data.length; i++) {
    const csvRowNumber = i + 1;
    const row = data[i];
    const Jraw = row[9] || '';
    const Qraw = row[16] || '';

    let discardReason = '';
    let accepted = false;

    // Check column count
    if (row.length !== headerLength) {
      discardReason = `Column count mismatch: ${row.length} vs ${headerLength}`;
    } else {
      const canonicalKey = normalizeCode(Jraw);
      const quantity = normalizeQuantity(Qraw);

      if (!canonicalKey) {
        discardReason = `J empty after normalization (raw: "${Jraw}")`;
      } else if (quantity === null) {
        discardReason = `Q not numeric (raw: "${Qraw}")`;
      } else {
        // ACCEPTED
        accepted = true;

        // Store in codeMap
        codeMap.set(canonicalKey, {
          canonicalKey,
          quantity,
          rawCode: Jraw.trim(),
          rawQuantity: Qraw.trim(),
          csvRow: csvRowNumber
        });

        // Build secondary index
        const secondaryKey = getSecondaryKey(canonicalKey);
        if (!secondaryIndex.has(secondaryKey)) {
          secondaryIndex.set(secondaryKey, []);
        }
        const existing = secondaryIndex.get(secondaryKey)!;
        if (!existing.includes(canonicalKey)) {
          existing.push(canonicalKey);
        }

        allCodesFound.push({
          csvRow: csvRowNumber,
          rawCode: Jraw.trim(),
          reason: 'ACCEPTED'
        });
      }
    }

    if (!accepted && discardReason) {
      allCodesFound.push({
        csvRow: csvRowNumber,
        rawCode: Jraw.trim() || '(empty)',
        reason: `DISCARDED: ${discardReason}`
      });
    }
  }

  // Print complete listing
  if (debugVerbose) {
    console.log('\n\n╔════════════════════════════════════════════════════════╗');
    console.log('║     CÓDIGOS EN MICHELLE (Columna J)                   ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log(`\nTotal filas procesadas: ${allCodesFound.length}`);
    console.log(`Total códigos aceptados: ${codeMap.size}`);
    console.log('\nTODAS LAS FILAS:\n');

    allCodesFound.forEach((entry, idx) => {
      if (entry.reason === 'ACCEPTED') {
        console.log(`Row ${entry.csvRow}: "${entry.rawCode}"`);
      } else {
        console.log(`Row ${entry.csvRow}: "${entry.rawCode}" → ${entry.reason}`);
      }

      // Check for gaps
      if (idx > 0) {
        const prevRow = allCodesFound[idx - 1].csvRow;
        const currentRow = entry.csvRow;
        const gap = currentRow - prevRow;
        if (gap > 1) {
          console.log(`  ⚠️  GAP DETECTED: ${gap - 1} row(s) skipped between ${prevRow} and ${currentRow}`);
        }
      }
    });

    console.log('\n═══════════════════════════════════════════════════════\n');
  }

  // VALIDATION: Check if codeMap is empty
  if (codeMap.size === 0) {
    console.error('\n❌ ERROR: EmptyCodeMap');
    console.error('No valid codes were added to the map. This means all rows were discarded.');
    console.error(`\nFirst 10 rows from dataStart=${dataStart}:`);
    for (let i = dataStart; i < Math.min(dataStart + 10, data.length); i++) {
      const row = data[i];
      console.error(`  Row ${i + 1}: J="${row[9]}", Q="${row[16]}"`);
    }
    return { codeMap, secondaryIndex };
  }

  if (debugVerbose) {
    console.log(`\n=== MICHELLE CODE MAP SUMMARY ===`);
    console.log(`Total canonical keys: ${codeMap.size}`);
    console.log(`Total secondary keys: ${secondaryIndex.size}`);

    let collisionCount = 0;
    secondaryIndex.forEach((canonicals) => {
      if (canonicals.length > 1) {
        collisionCount++;
      }
    });
    console.log(`Secondary keys with collisions: ${collisionCount}`);

    // Show first 10 entries
    console.log('\nFirst 10 codeMap entries:');
    let count = 0;
    codeMap.forEach((entry, key) => {
      if (count < 10) {
        console.log(`  "${key}" => qty: ${entry.quantity} (from Row ${entry.csvRow})`);
        count++;
      }
    });

    // Special check for CA3070TM1
    const testSku = 'CA3070TM1';
    const testSkuNorm = normalizeCode(testSku);
    if (codeMap.has(testSkuNorm)) {
      const entry = codeMap.get(testSkuNorm)!;
      console.log(`\n✓ VALIDATION: "${testSku}" found in codeMap`);
      console.log(`  Canonical key: "${testSkuNorm}"`);
      console.log(`  Quantity: ${entry.quantity}`);
      console.log(`  Raw code: "${entry.rawCode}"`);
      console.log(`  CSV Row: ${entry.csvRow}`);

      if (entry.quantity !== '324') {
        console.warn(`  ⚠️  WARNING: Expected quantity 324, got ${entry.quantity}`);
      }
    } else {
      console.error(`\n❌ VALIDATION FAILED: "${testSku}" NOT found in codeMap`);
      console.error(`  Normalized search key: "${testSkuNorm}"`);
      console.error('  Reasons this could happen:');
      console.error('    1. SKU not in CSV data rows');
      console.error('    2. O column not numeric');
      console.error('    3. L column empty after normalization');
    }

    console.log('=== END CODE MAP SUMMARY ===\n');
  }

  return { codeMap, secondaryIndex };
}

// Keep old function for backward compatibility
export function normalizeSkuForComparison(sku: string): string {
  return normalizeCode(sku);
}

// Costs Canvas snapshot types and utilities
export interface CostsSnapshotItem {
  name: string;
  board: 'fixed' | 'variable' | 'andrea';
  b2cAmount: number;
  b2bAmount: number;
}

export interface CostsSnapshot {
  dateRange: {
    from: string;
    to: string;
  };
  totals: {
    fixed: { b2c: number; b2b: number };
    variable: { b2c: number; b2b: number };
    andrea: { b2c: number; b2b: number };
  };
  items: CostsSnapshotItem[];
}

export function readCostsSnapshot(): CostsSnapshot | null {
  try {
    const snapshotStr = localStorage.getItem('costs-canvas-snapshot');
    if (!snapshotStr) return null;

    const snapshot = JSON.parse(snapshotStr) as CostsSnapshot;

    if (!snapshot.dateRange || !snapshot.totals || !snapshot.items) {
      return null;
    }

    return snapshot;
  } catch (error) {
    console.error('Error reading costs snapshot:', error);
    return null;
  }
}