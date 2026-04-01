'use strict';
import { logger } from '../../logger.js';
import { appState } from '../../state.js';
import {
  showLoadingIndicator,
  updateLoadingProgress,
  hideLoadingIndicator,
  showImportNotification,
} from './fileConnect.js';
import { ChartEngine } from '@mindfiredigital/pivothead-analytics';
import { Chart } from 'chart.js';
import { initializeFilters, resetFilters } from '../ui/filters.js';
import { initializeAnalyticsTab } from '../chart/chartModule.js';
import CsvParseWorker from '../services/csvParseWorker.js?worker';
import { splitCSVLine, coerceValue, getWasmLoaderInstance } from '../services/csvParsingUtils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

function autoDetectLayout(data, columns) {
  const sample = data.slice(0, 20);
  const measures = columns.filter(col => {
    const vals = sample.map(r => r[col]).filter(v => v != null);
    return vals.length > 0 && vals.every(v => typeof v === 'number');
  });
  const measureSet = new Set(measures);
  const dims = columns.filter(c => !measureSet.has(c));

  return {
    rows: dims.slice(0, 1).map(f => ({ uniqueName: f, caption: f })),
    columns:
      dims.length >= 2
        ? dims.slice(1, 2).map(f => ({ uniqueName: f, caption: f }))
        : [{ uniqueName: '__all__', caption: 'All' }],
    measures: measures.slice(0, 3).map(f => ({
      uniqueName: f,
      caption: f,
      aggregation: 'sum',
    })),
  };
}

/** Yield to the browser so the UI stays responsive and the tab isn't killed. */
function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}



/**
 * Parse a block of CSV text into row objects using WASM-assisted coercion.
 * `headers` is null for the first block (will be extracted from line 1).
 * Pushes rows directly into `target` array to avoid allocating a second array.
 */
function parseTextBlock(text, delimiter, headersIn, wasm, target) {
  const lines = text.split(/\r?\n/);
  let headers = headersIn;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    const fields = splitCSVLine(line, delimiter);

    if (!headers) {
      headers = fields;
      continue;
    }

    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = coerceValue(
        fields[j] !== undefined ? fields[j] : '',
        wasm
      );
    }
    target.push(obj);
  }

  return headers || [];
}

// ═════════════════════════════════════════════════════════════════════════════
// TIER 1 — Web Worker  (files < 5 MB)
// ═════════════════════════════════════════════════════════════════════════════

async function parseWithWorker(file, delimiter, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new CsvParseWorker();
    let allRows = []; // Accumulate rows here
    let finalHeaders = null;

    reader.onload = () => {
      worker.postMessage({ type: 'RESET' });
      worker.postMessage({
        type: 'PARSE_CHUNK',
        chunkId: 0,
        text: reader.result,
        delimiter,
        isFirstChunk: true,
        isLastChunk: true,
      });

      worker.onmessage = e => {
        const msg = e.data;
        if (msg.type === 'CHUNK_BATCH') {
          allRows.push(...msg.rows);
          finalHeaders = msg.headers; // Update headers with each batch
          onProgress(Math.min(99, (allRows.length / (file.size / 100)) * 100)); // Rough progress
          if (msg.isLastBatch) {
            // This is the last batch for the single chunk in this tier
            onProgress(100);
            worker.terminate();
            resolve({ rows: allRows, headers: finalHeaders });
          }
        } else if (msg.type === 'CHUNK_DONE') {
            // This message is sent when the last batch was empty, but it's the end of the file
            onProgress(100);
            worker.terminate();
            resolve({ rows: allRows, headers: finalHeaders });
        }
        else if (msg.type === 'CHUNK_ERROR') {
          worker.terminate();
          reject(new Error(msg.error));
        }
      };
    };

    reader.onerror = () => reject(reader.error);
    onProgress(10);
    reader.readAsText(file);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// TIER 2 — Pure WASM  (5 MB – 15 MB)
//
// Reads the whole file into memory, then uses WASM-assisted type coercion
// to build row objects faster than pure JS.
// Only used for moderately-sized files where full-read is safe.
// ═════════════════════════════════════════════════════════════════════════════

async function parseWithWasm(file, delimiter, onProgress) {
  const wasm = await getWasmLoaderInstance();

  onProgress(5);
  const text = await file.text();
  onProgress(30);

  if (wasm) {
    const meta = wasm.parseCSVChunk(text, {
      delimiter,
      hasHeader: true,
      trimValues: true,
    });
    logger.info(
      `WASM scan: ${meta.rowCount} rows, ${meta.colCount} cols, error=${meta.errorCode}`
    );
  }

  onProgress(40);

  const rows = [];
  const headers = parseTextBlock(text, delimiter, null, wasm, rows);

  onProgress(95);
  return { rows, headers };
}

// ═════════════════════════════════════════════════════════════════════════════
// TIER 3 — Streaming + WASM  (> 15 MB)
//
// Reads file in 4 MB chunks using blob.slice().text(), parses each chunk
// with WASM-assisted coercion, and accumulates row objects incrementally.
// Yields to the browser between chunks to prevent "page unresponsive" kills.
// ═════════════════════════════════════════════════════════════════════════════

async function parseWithStreamingWasm(file, delimiter, onProgress) {
  const wasm = await getWasmLoaderInstance();

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB per chunk (smaller = less peak memory)
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const allRows = [];
  let headers = null;
  let leftover = '';

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkText = await file.slice(start, end).text();

    const combined = leftover + chunkText;

    // For non-last chunks, buffer the incomplete trailing line
    let toParse;
    if (i < totalChunks - 1) {
      const lastNL = combined.lastIndexOf('\n');
      if (lastNL === -1) {
        leftover = combined;
        continue;
      }
      toParse = combined.substring(0, lastNL + 1);
      leftover = combined.substring(lastNL + 1);
    } else {
      toParse = combined;
      leftover = '';
    }

    // WASM validation on first chunk only
    if (wasm && i === 0) {
      const meta = wasm.parseCSVChunk(toParse, {
        delimiter,
        hasHeader: true,
        trimValues: true,
      });
      logger.info(
        `WASM scan (chunk 0): ${meta.rowCount} rows, ${meta.colCount} cols`
      );
    }

    // Push rows directly into allRows — no intermediate array or spread
    headers = parseTextBlock(toParse, delimiter, headers, wasm, allRows);

    onProgress(Math.round(((i + 1) / totalChunks) * 95));

    // Yield to the browser every chunk so the tab stays alive
    await yieldToMain();
  }

  onProgress(100);
  return { rows: allRows, headers: headers || [] };
}

// ═════════════════════════════════════════════════════════════════════════════
// Public API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fast CSV import with tiered parsing strategy:
 *
 *   < 5 MB    → Web Worker
 *   5 – 50 MB → WASM (full file read + WASM-assisted coercion)
 *   >= 50 MB  → Streaming + WASM (chunked read + WASM-assisted coercion)
 */
export async function fastCsvImport() {
  const file = await pickFile('.csv,.txt');
  if (!file) return;

  const delimiter = ',';
  const sizeMB = file.size / (1024 * 1024);
  let tier;

  if (sizeMB < 5) {
    tier = 'worker';
  } else if (sizeMB < 50) { // Changed from <= 15 to < 50
    tier = 'wasm';
  } else { // Changed from > 15 to >= 50
    tier = 'streaming-wasm';
  }

  logger.info(
    `Fast CSV import: ${file.name} (${sizeMB.toFixed(1)} MB) — strategy: ${tier}`
  );

  showLoadingIndicator(`Importing ${file.name} (${sizeMB.toFixed(1)} MB)...`);
  const t0 = performance.now();

  try {
    let parsed;

    switch (tier) {
      case 'worker':
        parsed = await parseWithWorker(file, delimiter, updateLoadingProgress);
        break;
      case 'wasm':
        parsed = await parseWithWasm(file, delimiter, updateLoadingProgress);
        break;
      case 'streaming-wasm':
        parsed = await parseWithStreamingWasm(
          file,
          delimiter,
          updateLoadingProgress
        );
        break;
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    logger.info(
      `Parsed ${parsed.rows.length.toLocaleString()} rows in ${elapsed}s (${tier})`
    );

    if (!parsed.rows.length) {
      hideLoadingIndicator();
      showImportNotification({ error: 'No data rows found in file.' }, false);
      return;
    }

    // ── Feed data into PivotEngine ───────────────────────────────────────────
    const layout = autoDetectLayout(parsed.rows, parsed.headers);

    appState.currentData = parsed.rows;
    appState.rawDataColumnOrder = null;
    appState.pagination.currentPage = 1;

    if (typeof appState.onFormatTable === 'function') {
      appState.pivotEngine.updateDataSource(parsed.rows);

      await yieldToMain();

      appState.onFormatTable({
        rows: layout.rows,
        columns: layout.columns,
        measures: layout.measures,
      });
    }

    // Yield before chart engine init
    await yieldToMain();

    // Re-initialise chart engine
    if (appState.chartEngine) {
      appState.chartEngine.dispose();
    }
    appState.chartEngine = new ChartEngine(appState.pivotEngine, {
      chartInstance: Chart,
      defaultStyle: { colorScheme: appState.currentPalette },
    });
    appState.chartService = appState.chartEngine.getChartService();
    appState.analyticsTabInitialized = false;

    const analyticsTab = document.getElementById('analytics-tab');
    if (analyticsTab && analyticsTab.classList.contains('active')) {
      initializeAnalyticsTab();
    }

    resetFilters();
    initializeFilters();

    hideLoadingIndicator();

    showImportNotification(
      {
        success: true,
        fileName: file.name,
        fileSize: file.size,
        recordCount: parsed.rows.length,
        columns: parsed.headers,
        parseTime: performance.now() - t0,
        performanceMode: tier,
      },
      true
    );
  } catch (error) {
    hideLoadingIndicator();
    logger.error('Fast CSV import failed:', error);
    showImportNotification(
      { success: false, error: error.message || 'Unknown error' },
      false
    );
  }
}
