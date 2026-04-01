'use strict';
import { splitCSVLine, coerceValue, getWasmLoaderInstance } from './csvParsingUtils.js';

let headers = null;
let leftover = '';
let wasmInstance = null; // To store the WASM instance
let isWasmLoaded = false; // To track WASM loading status

const BATCH_SIZE = 10000; // Send rows in batches of 10,000

async function initializeWasm() {
  if (!isWasmLoaded) {
    wasmInstance = await getWasmLoaderInstance();
    isWasmLoaded = !!wasmInstance;
  }
}

self.onmessage = async function (e) { // Make the function async
  const msg = e.data;

  switch (msg.type) {
    case 'RESET':
      headers = null;
      leftover = '';
      // No need to reset WASM instance, it's a singleton
      break;

    case 'PARSE_CHUNK':
      await initializeWasm(); // Ensure WASM is loaded

      try {
        const combined = leftover + msg.text;
        const lines = combined.split(/\r?\n/);

        // Buffer the last line unless it's the final chunk
        if (!msg.isLastChunk) {
          leftover = lines.pop() || '';
        } else {
          leftover = '';
        }

        const currentChunkRows = [];
        let currentHeaders = headers;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === '') continue;

          const fields = splitCSVLine(line, msg.delimiter || ',');

          if (!currentHeaders) {
            currentHeaders = fields;
            headers = fields; // Store headers for subsequent chunks
            continue;
          }

          const obj = {};
          for (let j = 0; j < currentHeaders.length; j++) {
            obj[currentHeaders[j]] = coerceValue(
              fields[j] !== undefined ? fields[j] : '',
              wasmInstance
            );
          }
          currentChunkRows.push(obj);

          // Send batch if size reached
          if (currentChunkRows.length >= BATCH_SIZE) {
            self.postMessage({
              type: 'CHUNK_BATCH',
              chunkId: msg.chunkId,
              rows: currentChunkRows.splice(0, BATCH_SIZE), // Send and clear batch
              headers: headers ? [...headers] : [],
              isLastBatch: false,
            });
          }
        }

        // Send any remaining rows in the last batch for this chunk
        if (currentChunkRows.length > 0 || msg.isLastChunk) {
          self.postMessage({
            type: 'CHUNK_BATCH',
            chunkId: msg.chunkId,
            rows: currentChunkRows,
            headers: headers ? [...headers] : [],
            isLastBatch: msg.isLastChunk, // Mark as last batch if it's the last chunk
          });
        }

        // If it's the very last chunk and all batches are sent, signal completion
        if (msg.isLastChunk && currentChunkRows.length === 0) {
             self.postMessage({
                type: 'CHUNK_DONE', // Signal final completion
                chunkId: msg.chunkId,
                headers: headers ? [...headers] : [],
                rowCount: 0, // Actual row count will be accumulated on main thread
            });
        }

      } catch (err) {
        self.postMessage({
          type: 'CHUNK_ERROR',
          chunkId: msg.chunkId,
          error: err.message,
        });
      }
      break;
  }
};
