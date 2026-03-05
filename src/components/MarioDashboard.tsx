import React from 'react';
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { X, ArrowLeft, Upload, Download, ExternalLink, Search, CircleCheck as CheckCircle, Loader as Loader2 } from 'lucide-react';
import {
  excelColToIndex,
  parseCsvText,
  generateCsvString,
  normalizeCode,
  getSecondaryKey,
  parseMichelleCsvWithPapa,
  levenshteinDistance,
  type MichelleCodeMap
} from '@/lib/utils';

interface MarioDashboardProps {
  onClose: () => void;
}

interface MatchedPoRow {
  orderNumber: string;
  productCode: string;
  orderQuantity: string;
  supplierReference: string;
}

// Alternative product codes mapping
// Alternative product codes mapping: [Código a buscar en Michelle (Col L)]: [Código de Unleashed (Col B)]
const alternativeProductCodes: Record<string, string> = {
  'CA3070 shaker': 'CA3070-Shaker',
'Sunrise Ceramic set': 'PSD-CeramicSet',
'PFHMV (5MM)': 'PFHMV',
'PFHAS': 'PFH00AS-HY',
'MOD-Iris': 'PFMOD2-Iris',
'MOD-Riga': 'PFMOD2-Riga',
'MOD-IrisTamper': 'PSDTMOD2-Iris',
'MOD-RigaTamper': 'PSDTMOD2-Riga',
'AD Tamper': 'PSD-AD-SpringTamper',
'PSD-distributor v2.0': 'V2-PSD-distributor',
'PSD-Distributor-54mm V2.0': 'V2-PSD-54mm-distributor',
'PSDdosingCup-BK -Laser V2': 'PSDdosingCup-BK',
'PSDdosingCup-WH Decal v2.0': 'V2-PSDdosingCup-WH',
'PSDjug-BK V2.0 laser cutting handle': 'PSDjug-BK',
'PSDjugWH V2.0 laser cutting handle +  decal': 'V2-PSDjugWH',
'COFFEE MACHINE LEGS': 'PSDLBK',
'WK-HC7123BK': 'HC7123BK',
'WK-HC7123ST': 'HC7123ST',
'WK-HC7123TB': 'HC7123TB',
'WK-HC7123VL': 'HC7123VL',
'WK-HC7123W': 'HC7123WH',
'WK-HC7124BK': 'HC7124BK',
'WK-HC7124ST': 'HC7124ST',
'WK-HC7124TB': 'HC7124TB',
'WK-HC7124PK': 'HC7124PK',
'WK-HC7124W': 'HC7124WH',
'WK-HC7124VL': 'HC7124VL',
'WK-HC7125PK': 'HC7125PK',
'WK-HC7125TB': 'HC7125TB',
'WK-HC7125W': 'HC7125W',
'WK-HC7125BK': 'HC7125BK',
'CA3070 cloth': 'CA3070-Cloth',
'Grinder &Table Brush': 'CA3070-grinderbrush',
'Thermometer with click': 'CA3070-Thermometer',
'Group Brush': 'CA3070-groupbrush',
'WH-V2-PSD Distributor': 'WH-V2-PSD-distributor',
'PSD-HD-BR54': 'PSD-HD-54',
'AB3070GR-BK': 'ABGR01-BK',
'PFHLM v 2.0 82.5': 'PFHLM',
'AB3070GR-WH': 'ABGR01-WH',
'PSD-HD54-PLATE54': 'PSD-HD-Plate54',
'CA3070TM1': 'CA3070TM1'
};

export default function MarioDashboard({ onClose }: MarioDashboardProps) {
  // State for PO to TX functionality
  const [poCsvContent, setPoCsvContent] = useState<string | null>(null);
  const [transferTemplateCsvContent, setTransferTemplateCsvContent] = useState<string | null>(null);
  const [poNumberInput, setPoNumberInput] = useState<string>('');
  const [matchedPoRows, setMatchedPoRows] = useState<MatchedPoRow[]>([]);
  const [generatedTransferCsv, setGeneratedTransferCsv] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // State for Update SOH China functionality
  const [unleashedStockCountCsvContent, setUnleashedStockCountCsvContent] = useState<string | null>(null);
  const [michelleSheetCsvContent, setMichelleSheetCsvContent] = useState<string | null>(null);
  const [processedStockCountCsv, setProcessedStockCountCsv] = useState<string | null>(null);
  const [isLoadingSohChina, setIsLoadingSohChina] = useState<boolean>(false);
  const [errorSohChina, setErrorSohChina] = useState<string>('');

  // File upload handlers
  const handlePoCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setPoCsvContent(content);
        setError('');
      };
      reader.onerror = () => {
        setError('Error al leer el archivo CSV de órdenes de compra');
      };
      reader.readAsText(file);
    }
  };

  const handleTransferTemplateCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setTransferTemplateCsvContent(content);
        setError('');
      };
      reader.onerror = () => {
        setError('Error al leer el archivo CSV de plantilla de transferencia');
      };
      reader.readAsText(file);
    }
  };

  // File upload handlers for SOH China
  const handleUnleashedStockCountCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setUnleashedStockCountCsvContent(content);
        setErrorSohChina('');
      };
      reader.onerror = () => {
        setErrorSohChina('Error al leer el archivo CSV de Stock Count de Unleashed');
      };
      reader.readAsText(file);
    }
  };

  const handleMichelleSheetCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        setMichelleSheetCsvContent(content);
        setErrorSohChina('');
      };
      reader.onerror = () => {
        setErrorSohChina('Error al leer el archivo CSV de la planilla de Michelle');
      };
      reader.readAsText(file);
    }
  };

  // Search for PO matches
  const handleSearchPo = () => {
    if (!poCsvContent) {
      setError('Primero debe cargar el archivo CSV de órdenes de compra');
      return;
    }

    if (!poNumberInput.trim()) {
      setError('Debe ingresar un número de orden de compra');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const parsedData = parseCsvText(poCsvContent);
      
      if (parsedData.length === 0) {
        setError('El archivo CSV está vacío o no se pudo parsear');
        setIsLoading(false);
        return;
      }

      // Find header row and column indices
      // const headers = parsedData[0]; // Not used but kept for reference
      const orderNumberColIndex = excelColToIndex('A'); // Column A
      const productCodeColIndex = excelColToIndex('AB'); // Column AB
      const orderQuantityColIndex = excelColToIndex('AO'); // Column AO
      const supplierReferenceColIndex = excelColToIndex('E'); // Column E

      // Search for matching rows (skip header row)
      const searchTerm = `PO-0000${poNumberInput}`;
      const matches: MatchedPoRow[] = [];

      for (let i = 1; i < parsedData.length; i++) {
        const row = parsedData[i];
        const orderNumber = row[orderNumberColIndex] || '';
        
        if (orderNumber.includes(searchTerm)) {
          matches.push({
            orderNumber: orderNumber,
            productCode: row[productCodeColIndex] || '',
            orderQuantity: row[orderQuantityColIndex] || '',
            supplierReference: row[supplierReferenceColIndex] || ''
          });
        }
      }

      setMatchedPoRows(matches);
      
      if (matches.length === 0) {
        setError(`No se encontraron órdenes de compra que contengan "${searchTerm}"`);
      }
    } catch (err) {
      setError('Error al procesar el archivo CSV: ' + (err instanceof Error ? err.message : 'Error desconocido'));
    } finally {
      setIsLoading(false);
    }
  };

  // Generate transfer CSV
  const handleGenerateTransferCsv = () => {
    if (!transferTemplateCsvContent) {
      setError('Primero debe cargar la plantilla de transferencia');
      return;
    }

    if (matchedPoRows.length === 0) {
      setError('No hay datos de órdenes de compra para procesar');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const templateData = parseCsvText(transferTemplateCsvContent);
      
      if (templateData.length === 0) {
        setError('La plantilla de transferencia está vacía o no se pudo parsear');
        setIsLoading(false);
        return;
      }

      // Create new data based on template
      const newData: string[][] = [];
      
      // Keep the header row
      newData.push([...templateData[0]]);

      // Add rows for each matched PO
      matchedPoRows.forEach(poRow => {
        // Create a new row based on the template structure
        const newRow = [...templateData[0]]; // Start with header structure, will be filled
        
        // Fill the row with empty strings first
        for (let i = 0; i < newRow.length; i++) {
          newRow[i] = '';
        }

        // Map the data according to specifications
        newRow[excelColToIndex('A')] = `TX-0000${poNumberInput}`; // *Transfer Number
        newRow[excelColToIndex('B')] = 'China'; // *Source Warehouse Code
        newRow[excelColToIndex('C')] = 'Main'; // *Destination Warehouse Code
        newRow[excelColToIndex('D')] = poRow.supplierReference; // Comments
        newRow[excelColToIndex('E')] = poRow.productCode; // *Product Code
        newRow[excelColToIndex('F')] = poRow.orderQuantity; // *Transfer Quantity

        newData.push(newRow);
      });

      const csvString = generateCsvString(newData);
      setGeneratedTransferCsv(csvString);
    } catch (err) {
      setError('Error al generar el CSV de transferencia: ' + (err instanceof Error ? err.message : 'Error desconocido'));
    } finally {
      setIsLoading(false);
    }
  };

  // Download generated CSV
  const handleDownloadTransferCsv = () => {
    if (!generatedTransferCsv) {
      setError('No hay CSV de transferencia generado para descargar');
      return;
    }

    try {
      const blob = new Blob([generatedTransferCsv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `transfer_template_TX-0000${poNumberInput}.csv`;
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Error al descargar el archivo: ' + (err instanceof Error ? err.message : 'Error desconocido'));
    }
  };

  // Process and download stock count CSV
  const handleProcessAndDownloadStockCountCsv = () => {
    const DEBUG_VERBOSE = true;

    if (!unleashedStockCountCsvContent) {
      setErrorSohChina('Primero debe cargar el archivo CSV de Stock Count de Unleashed');
      return;
    }

    if (!michelleSheetCsvContent) {
      setErrorSohChina('Primero debe cargar el archivo CSV de la planilla de Michelle');
      return;
    }

    setIsLoadingSohChina(true);
    setErrorSohChina('');

    try {
      console.log('=== INICIO DEL PROCESAMIENTO ===');
      console.log(`DEBUG_VERBOSE: ${DEBUG_VERBOSE}`);

      // Parse Unleashed CSV with old parser
      const unleashedData = parseCsvText(unleashedStockCountCsvContent);

      if (unleashedData.length === 0) {
        setErrorSohChina('El archivo CSV de Stock Count está vacío o no se pudo parsear');
        setIsLoadingSohChina(false);
        return;
      }

      // Parse Michelle CSV with PapaParse
      const michelleCodeMap: MichelleCodeMap = parseMichelleCsvWithPapa(michelleSheetCsvContent, DEBUG_VERBOSE);

      if (michelleCodeMap.codeMap.size === 0) {
        setErrorSohChina('El archivo CSV de la planilla de Michelle está vacío o no se pudo parsear');
        setIsLoadingSohChina(false);
        return;
      }

      console.log(`\\nUnleashed data rows: ${unleashedData.length}`);
      console.log(`Michelle codes available: ${michelleCodeMap.codeMap.size}`);

      // Collect all SKUs to search
      const unleashedSkus: string[] = [];
      for (let i = 1; i < unleashedData.length; i++) {
        const productCode = unleashedData[i][1];
        if (productCode && productCode.trim()) {
          let codeToSearch = productCode.trim();

          // Check alternative codes
          for (const [michelleCode, unleashedCode] of Object.entries(alternativeProductCodes)) {
            if (unleashedCode.toLowerCase() === productCode.trim().toLowerCase()) {
              codeToSearch = michelleCode;
              break;
            }
          }

          unleashedSkus.push(codeToSearch);
        }
      }

      // Process the data
      const processedData = [...unleashedData];
      let matchedCount = 0;
      let alternativeMatchedCount = 0;
      let secondaryMatchedCount = 0;
      const missingSkus: Array<{
        unleashedRow: number;
        rawCode: string;
        canonicalKey: string;
        secondaryKey: string;
        suggestions: Array<{type: string; code: string; distance?: number}>;
      }> = [];

      // Start from row 1 (skip header) for Unleashed data
      for (let i = 1; i < processedData.length; i++) {
        const unleashedRow = processedData[i];
        const productCode = unleashedRow[1]; // Column B (*Product Code)

        if (!productCode || productCode.trim() === '') {
          continue;
        }

        let quantityValue = '';
        let codeToSearch = productCode.trim();
        let usedAlternative = false;

        // Check alternative codes
        for (const [michelleCode, unleashedCode] of Object.entries(alternativeProductCodes)) {
          if (unleashedCode.toLowerCase() === productCode.trim().toLowerCase()) {
            codeToSearch = michelleCode;
            usedAlternative = true;
            if (DEBUG_VERBOSE) {
              console.log(`\\nRow ${i}: Alternative mapping: "${productCode.trim()}" -> "${michelleCode}"`);
            }
            break;
          }
        }

        const canonicalKey = normalizeCode(codeToSearch);
        const secondaryKey = getSecondaryKey(canonicalKey);

        if (DEBUG_VERBOSE) {
          console.log(`\\n--- Row ${i}: "${codeToSearch}" ---`);
          console.log(`  Canonical: "${canonicalKey}"`);
          console.log(`  Secondary: "${secondaryKey}"`);
        }

        let found = false;

        // Primary lookup
        if (michelleCodeMap.codeMap.has(canonicalKey)) {
          const entry = michelleCodeMap.codeMap.get(canonicalKey)!;
          quantityValue = entry.quantity;
          found = true;

          if (DEBUG_VERBOSE) {
            console.log(`  PRIMARY MATCH: "${entry.rawCode}" (row ${entry.csvRow}) -> qty: ${quantityValue}`);
          }

          if (usedAlternative) {
            alternativeMatchedCount++;
          } else {
            matchedCount++;
          }
        } else {
          // Secondary key fallback
          const secondaryCandidates = michelleCodeMap.secondaryIndex.get(secondaryKey) || [];

          if (DEBUG_VERBOSE) {
            console.log(`  Secondary candidates: ${secondaryCandidates.length}`);
          }

          if (secondaryCandidates.length === 1) {
            const candidateKey = secondaryCandidates[0];
            const entry = michelleCodeMap.codeMap.get(candidateKey)!;
            quantityValue = entry.quantity;
            found = true;

            if (DEBUG_VERBOSE) {
              console.log(`  SECONDARY MATCH: "${entry.rawCode}" (row ${entry.csvRow}) -> qty: ${quantityValue}`);
            }

            secondaryMatchedCount++;
          } else if (secondaryCandidates.length > 1) {
            if (DEBUG_VERBOSE) {
              console.log(`  COLLISION: Multiple candidates for secondary key`);
              secondaryCandidates.forEach(c => console.log(`    - ${c}`));
            }
          }
        }

        if (!found) {
          if (DEBUG_VERBOSE) {
            console.log(`  NO MATCH FOUND`);
          }

          // Find suggestions
          const suggestions: Array<{type: string; code: string; distance?: number}> = [];

          // Secondary key matches (even with collisions)
          const secondaryCandidates = michelleCodeMap.secondaryIndex.get(secondaryKey) || [];
          secondaryCandidates.forEach(c => {
            suggestions.push({ type: 'secondary_key', code: c });
          });

          // Levenshtein distance <= 2
          michelleCodeMap.codeMap.forEach((_entry, key) => {
            const dist = levenshteinDistance(canonicalKey, key);
            if (dist <= 2 && dist > 0) {
              suggestions.push({ type: 'levenshtein', code: key, distance: dist });
            }
          });

          missingSkus.push({
            unleashedRow: i,
            rawCode: codeToSearch,
            canonicalKey,
            secondaryKey,
            suggestions
          });
        }

        // Assign quantity
        const finalQuantity = quantityValue || '0';
        processedData[i][2] = finalQuantity;
      }

      // Print Missing SKUs Report
      console.log('\\n\\n╔════════════════════════════════════════════════════════╗');
      console.log('║           MISSING SKUs REPORT                          ║');
      console.log('╚════════════════════════════════════════════════════════╝');
      console.log(`\\nTotal missing: ${missingSkus.length}`);

      missingSkus.forEach(miss => {
        console.log(`\\n─────────────────────────────────────────────────────────`);
        console.log(`Row ${miss.unleashedRow}: "${miss.rawCode}"`);
        console.log(`  Canonical key: "${miss.canonicalKey}"`);
        console.log(`  Secondary key: "${miss.secondaryKey}"`);
        console.log(`  Suggestions (${miss.suggestions.length}):`);

        if (miss.suggestions.length === 0) {
          console.log(`    (no close matches found)`);
        } else {
          miss.suggestions.forEach(s => {
            if (s.type === 'secondary_key') {
              console.log(`    - [Secondary Key] "${s.code}"`);
            } else if (s.type === 'levenshtein') {
              console.log(`    - [Distance ${s.distance}] "${s.code}"`);
            }
          });
        }
      });

      console.log(`\\n─────────────────────────────────────────────────────────`);
      console.log('\\n╔════════════════════════════════════════════════════════╗');
      console.log('║           PROCESSING SUMMARY                           ║');
      console.log('╚════════════════════════════════════════════════════════╝');
      console.log(`Total Unleashed rows processed: ${processedData.length - 1}`);
      console.log(`Primary matches: ${matchedCount}`);
      console.log(`Alternative code matches: ${alternativeMatchedCount}`);
      console.log(`Secondary key matches: ${secondaryMatchedCount}`);
      console.log(`Not found: ${missingSkus.length}`);
      console.log(`Michelle codes available: ${michelleCodeMap.codeMap.size}`);

      // FINAL VALIDATION: Check CA3070TM1 before writing
      if (DEBUG_VERBOSE) {
        console.log('\\n╔════════════════════════════════════════════════════════╗');
        console.log('║        FINAL VALIDATION BEFORE WRITING                 ║');
        console.log('╚════════════════════════════════════════════════════════╝');

        // Find CA3070TM1 in processedData
        const testSku = 'CA3070TM1';
        let testSkuRow = -1;
        for (let i = 1; i < processedData.length; i++) {
          if (processedData[i][1] === testSku) {
            testSkuRow = i;
            break;
          }
        }

        if (testSkuRow !== -1) {
          const finalQty = processedData[testSkuRow][2];
          console.log(`Found "${testSku}" at row ${testSkuRow}:`);
          console.log(`  Column B (Product Code): "${processedData[testSkuRow][1]}"`);
          console.log(`  Column C (Quantity - will be written): "${finalQty}"`);

          if (finalQty === '324') {
            console.log(`  ✓ CORRECT: Quantity is 324`);
          } else if (finalQty === '0' || finalQty === '') {
            console.error(`  ❌ ERROR: Quantity is "${finalQty}" instead of 324`);
            console.error('  This means codeMap lookup failed during processing');
          } else {
            console.warn(`  ⚠️  WARNING: Quantity is "${finalQty}", expected 324`);
          }
        } else {
          console.log(`"${testSku}" not found in Unleashed data (not being searched)`);
        }

        console.log('═══════════════════════════════════════════════════════\n');
      }

      // Generate CSV string
      const csvString = generateCsvString(processedData);
      setProcessedStockCountCsv(csvString);

      // Trigger download
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `stock_count_processed_${new Date().toISOString().split('T')[0]}.csv`;
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      console.log('\\n=== PROCESAMIENTO COMPLETADO ===');
    } catch (err) {
      setErrorSohChina('Error al procesar los archivos CSV: ' + (err instanceof Error ? err.message : 'Error desconocido'));
      console.error('Error durante el procesamiento:', err);
    } finally {
      setIsLoadingSohChina(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="max-w-7xl mx-auto p-4">
        {/* Header with close button */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900">Internal Functions (Mario)</h1>
            <p className="text-sm text-neutral-600">Dashboard de funciones internas</p>
          </div>
          <div className="flex items-center gap-2">
            <Button 
              variant="outline" 
              onClick={onClose}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Volver al Dashboard Principal
            </Button>
            <Button 
              variant="ghost" 
              size="sm"
              onClick={onClose}
              className="p-2"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Error display */}
        {(error || errorSohChina) && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            {error && <p className="text-red-700 text-sm">{error}</p>}
            {errorSohChina && <p className="text-red-700 text-sm">{errorSohChina}</p>}
          </div>
        )}

        {/* Main content grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Update SOH China Section */}
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Update SOH China
              </CardTitle>
              <CardDescription>
                Gestión y actualización del stock disponible en China
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Step 1: Go to Unleashed Stock Takes */}
              <div className="space-y-2">
                <Button 
                  variant="default" 
                  className="w-full flex items-center gap-2"
                  onClick={() => window.open('https://au.unleashedsoftware.com/v2/StockTakes/List', '_blank')}
                >
                  <ExternalLink className="w-4 h-4" />
                  1) Ir a Unleashed Stock Takes List
                </Button>
              </div>

              {/* Steps 2-4: Informative steps */}
              <div className="space-y-2 p-3 bg-blue-50 rounded-lg">
                <p className="text-sm text-blue-800 font-medium">Pasos a seguir en Unleashed:</p>
                <p className="text-sm text-blue-700">2) Click en "Add Count"</p>
                <p className="text-sm text-blue-700">3) Seleccionar "China-W", tildar "Include products with no stock" y "Create Stock Count"</p>
                <p className="text-sm text-blue-700">4) Exportar CSV</p>
              </div>

              {/* Step 5: Upload Unleashed Stock Count CSV */}
              <div className="space-y-2">
                <Label htmlFor="unleashed-stock-count-upload" className="text-sm font-medium">
                  5) Subir CSV de Stock Count de Unleashed
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="unleashed-stock-count-upload"
                    type="file"
                    accept=".csv"
                    onChange={handleUnleashedStockCountCsvUpload}
                    className="flex-1"
                  />
                  {unleashedStockCountCsvContent && <CheckCircle className="w-5 h-5 text-green-600" />}
                </div>
              </div>

              {/* Step 6: Go to Michelle's Google Sheet */}
              <div className="space-y-2">
                <Button 
                  variant="default" 
                  className="w-full flex items-center gap-2"
                  onClick={() => window.open('https://docs.google.com/spreadsheets/d/1BDPR9JDiw8jz3Cp3mPBNRmyRxk7TJklK/edit?gid=1811777646#gid=1811777646', '_blank')}
                >
                  <ExternalLink className="w-4 h-4" />
                  6) Ir a Planilla de Michelle
                </Button>
                <p className="text-xs text-neutral-600">Descargar la planilla como CSV</p>
              </div>

              {/* Step 7: Upload Michelle's CSV */}
              <div className="space-y-2">
                <Label htmlFor="michelle-sheet-upload" className="text-sm font-medium">
                  7) Subir CSV de la Planilla de Michelle
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="michelle-sheet-upload"
                    type="file"
                    accept=".csv"
                    onChange={handleMichelleSheetCsvUpload}
                    className="flex-1"
                  />
                  {michelleSheetCsvContent && <CheckCircle className="w-5 h-5 text-green-600" />}
                </div>
              </div>

              {/* Step 8: Process and Download CSV */}
              {unleashedStockCountCsvContent && michelleSheetCsvContent && (
                <div className="space-y-2">
                  <Button 
                    onClick={handleProcessAndDownloadStockCountCsv}
                    disabled={isLoadingSohChina}
                    className="w-full flex items-center gap-2"
                    variant="default"
                  >
                    {isLoadingSohChina ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Procesando...
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        8) Procesar y Descargar CSV de Stock Count
                      </>
                    )}
                  </Button>
                </div>
              )}

              {/* Step 9: Go to Unleashed for Import */}
              {processedStockCountCsv && (
                <div className="space-y-2">
                  <Button 
                    onClick={() => window.open('https://au.unleashedsoftware.com/v2/StockTakes/List', '_blank')}
                    className="w-full flex items-center gap-2"
                    variant="default"
                  >
                    <ExternalLink className="w-4 h-4" />
                    9) Ir a Unleashed para Importar Stock Count
                  </Button>
                </div>
              )}

              {/* Alternative Codes Table Display */}
              <div className="mt-6 space-y-2">
                <h4 className="text-sm font-medium text-neutral-900">Tabla de Códigos Alternativos</h4>
                <div className="max-h-60 overflow-y-auto border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Código en Michelle (Col J)</TableHead>
                        <TableHead className="text-xs">Código en Unleashed (Col B)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {Object.entries(alternativeProductCodes).map(([michelleCode, unleashedCode]) => (
                        <TableRow key={michelleCode}>
                          <TableCell className="font-mono text-xs">{michelleCode}</TableCell>
                          <TableCell className="font-mono text-xs">{unleashedCode}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-xs text-neutral-600">
                  Total de mapeos alternativos: {Object.keys(alternativeProductCodes).length}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* PO to TX Section */}
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                PO to TX
              </CardTitle>
              <CardDescription>
                Gestión de órdenes de compra y transferencias
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Step 1: Download PO CSV */}
              <div className="space-y-2">
                <Button 
                  variant="default" 
                  className="w-full flex items-center gap-2"
                  onClick={() => window.open('https://au.unleashedsoftware.com/v2/PurchaseOrder/Import', '_blank')}
                >
                  <ExternalLink className="w-4 h-4" />
                  1) Export CSV de Órdenes de Compra
                </Button>
              </div>

              {/* Step 2: Upload PO CSV */}
              <div className="space-y-2">
                <Label htmlFor="po-csv-upload" className="text-sm font-medium">
                  2) Subir CSV de Órdenes de Compra
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="po-csv-upload"
                    type="file"
                    accept=".csv"
                    onChange={handlePoCsvUpload}
                    className="flex-1"
                  />
                  {poCsvContent && <CheckCircle className="w-5 h-5 text-green-600" />}
                </div>
              </div>

              {/* Step 3: Download Transfer Template */}
              <div className="space-y-2">
                <Button 
                  variant="default" 
                  className="w-full flex items-center gap-2"
                  onClick={() => window.open('https://au.unleashedsoftware.com/v2/WarehouseStockTransfer/Import', '_blank')}
                >
                  <ExternalLink className="w-4 h-4" />
                  3) Download Warehouse transfers template file
                </Button>
              </div>

              {/* Step 4: Upload Transfer Template */}
              <div className="space-y-2">
                <Label htmlFor="transfer-template-upload" className="text-sm font-medium">
                  4) Upload Warehouse transfers template file
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="transfer-template-upload"
                    type="file"
                    accept=".csv"
                    onChange={handleTransferTemplateCsvUpload}
                    className="flex-1"
                  />
                  {transferTemplateCsvContent && <CheckCircle className="w-5 h-5 text-green-600" />}
                </div>
              </div>

              {/* Step 5: Enter PO Number and Search */}
              <div className="space-y-2">
                <Label htmlFor="po-number-input" className="text-sm font-medium">
                  5) Po number to be transform in TX (last 4 digits only)
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex items-center flex-1">
                    <span className="text-sm text-neutral-600 mr-2">TX-0000</span>
                    <Input
                      id="po-number-input"
                      type="text"
                      value={poNumberInput}
                      onChange={(e) => setPoNumberInput(e.target.value)}
                      placeholder="1234"
                      maxLength={4}
                      className="flex-1"
                    />
                  </div>
                  <Button 
                    onClick={handleSearchPo}
                    disabled={!poCsvContent || !poNumberInput.trim() || isLoading}
                    className="flex items-center gap-2"
                  >
                    <Search className="w-4 h-4" />
                    Buscar PO
                  </Button>
                </div>
              </div>

              {/* Step 6: Generate Transfer CSV */}
              {matchedPoRows.length > 0 && (
                <div className="space-y-2">
                  <Button 
                    onClick={handleGenerateTransferCsv}
                    disabled={!transferTemplateCsvContent || isLoading}
                    className="w-full flex items-center gap-2"
                    variant="default"
                  >
                    <Upload className="w-4 h-4" />
                    6) Crear TX a partir de esta info
                  </Button>
                </div>
              )}

              {/* Step 7: Download Generated CSV */}
              {generatedTransferCsv && (
                <div className="space-y-2">
                  <Button 
                    onClick={handleDownloadTransferCsv}
                    className="w-full flex items-center gap-2"
                    variant="default"
                  >
                    <Download className="w-4 h-4" />
                    7) Descargar CSV de Transferencia
                  </Button>
                </div>
              )}

              {/* Step 8: Go to Unleashed to upload TX */}
              {generatedTransferCsv && (
                <div className="space-y-2">
                  <Button
                    onClick={() => window.open('https://au.unleashedsoftware.com/v2/WarehouseStockTransfer/List#status=Open', '_blank')}
                    className="w-full flex items-center gap-2"
                    variant="default"
                  >
                    <ExternalLink className="w-4 h-4" />
                    8) Ir a Unleashed para cargar TX
                  </Button>
                </div>
              )}

              {/* Step 9: Complete TX and delete original PO */}
              {generatedTransferCsv && (
                <div className="space-y-2">
                  <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <p className="text-sm text-amber-800 font-medium">9) Completar TX y eliminar PO original:</p>
                    <p className="text-sm text-amber-700 mt-1">• Una vez importada la TX, completarla para que el stock se refleje en ambos warehouses</p>
                    <p className="text-sm text-amber-700">• Luego eliminar la PO original</p>
                    <p className="text-xs text-amber-600 mt-2 italic">Nota: Para que esto funcione correctamente, China debe tener el stock correcto. Se recomienda hacer primero la actualización de stock en China (Update SOH China).</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Matched PO Data Table */}
        {matchedPoRows.length > 0 && (
          <div className="mt-6">
            <Card className="shadow-sm">
              <CardHeader>
                <CardTitle>Datos de Órdenes de Compra Encontradas</CardTitle>
                <CardDescription>
                  Se encontraron {matchedPoRows.length} coincidencia(s) para TX-0000{poNumberInput}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Order Number</TableHead>
                        <TableHead>Product Code</TableHead>
                        <TableHead>Order Quantity</TableHead>
                        <TableHead>Supplier Reference</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {matchedPoRows.map((row, index) => (
                        <TableRow key={index}>
                          <TableCell className="font-mono text-sm">{row.orderNumber}</TableCell>
                          <TableCell className="font-mono text-sm">{row.productCode}</TableCell>
                          <TableCell className="font-mono text-sm">{row.orderQuantity}</TableCell>
                          <TableCell className="font-mono text-sm">{row.supplierReference}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Additional sections can be added here */}
        <div className="mt-6">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Información del Sistema</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div className="p-3 bg-blue-50 rounded-lg">
                  <div className="font-medium text-blue-900">Estado del Sistema</div>
                  <div className="text-blue-700">Operativo</div>
                </div>
                <div className="p-3 bg-green-50 rounded-lg">
                  <div className="font-medium text-green-900">Última Actualización</div>
                  <div className="text-green-700">{new Date().toLocaleDateString()}</div>
                </div>
                <div className="p-3 bg-purple-50 rounded-lg">
                  <div className="font-medium text-purple-900">Usuario</div>
                  <div className="text-purple-700">Mario (Admin)</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}