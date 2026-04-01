
import { logger } from '../../logger.js';

let _wasmLoader = null;
let _wasmReady = false;

/**
 * Initializes and returns the WASM loader singleton.
 * Falls back to pure-JS coercion if WASM is unavailable.
 */
export async function getWasmLoaderInstance() {
  if (_wasmReady) return _wasmLoader;
  try {
    // Dynamically import the WASM loader from the pivothead package
    // This assumes @mindfiredigital/pivothead is correctly configured to expose getWasmLoader
    const { getWasmLoader } = await import('@mindfiredigital/pivothead');
    _wasmLoader = getWasmLoader();
    await _wasmLoader.load();
    _wasmReady = _wasmLoader.isModuleLoaded();
    if (_wasmReady) {
      logger.info('WASM loaded in utility — version: ' + _wasmLoader.getVersion());
    }
  } catch (err) {
    logger.warn('WASM load failed in utility, will use JS fallback:', err.message);
    _wasmReady = false;
  }
  return _wasmReady ? _wasmLoader : null;
}

/**
 * Splits a CSV line into fields.
 * This function is pure JavaScript as the current WASM API does not provide a direct line-to-fields parser.
 *
 * @param {string} line The CSV line to split.
 * @param {string} delimiter The field delimiter.
 * @returns {string[]} An array of trimmed field strings.
 */
export function splitCSVLine(line, delimiter) {
  const fields = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          field += '"'; // Escaped quote
          i++;
        } else {
          inQuotes = false; // Closing quote
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true; // Opening quote
    } else if (ch === delimiter) {
      fields.push(field.trim());
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field.trim()); // Add the last field
  return fields;
}

/**
 * Coerces a string value to its appropriate type (number, boolean, null, or string).
 * Uses WASM for faster number/type detection if available.
 *
 * @param {string} val The string value to coerce.
 * @param {object | null} wasm The WASM loader instance, if available.
 * @returns {string | number | boolean | null} The coerced value.
 */
export function coerceValue(val, wasm) {
  if (val === '') return val; // Keep empty strings as empty strings

  if (wasm) {
    // Use WASM for faster type detection and number parsing
    const t = wasm.detectFieldType(val);
    if (t === 1) return wasm.parseNumber(val); // number
    if (t === 2) return val === 'true' || val === 'TRUE'; // boolean
    if (t === 3) return null; // null / empty (as per WASM's definition)
    return val; // string
  }

  // Pure JS fallback if WASM is not available or failed to load
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === 'NULL') return null;
  const n = Number(val);
  if (val !== '' && !isNaN(n) && isFinite(n)) return n;
  return val;
}
