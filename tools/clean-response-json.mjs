#!/usr/bin/env node
/**
 * Clean a response JSON file that has conversational text around the JSON array.
 * Extracts the JSON between ```json ... ``` fences, or between first [ and last ].
 */
import { readFileSync, writeFileSync } from 'node:fs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node tools/clean-response-json.mjs <file>');
  process.exit(1);
}

let content = readFileSync(filePath, 'utf-8');

// Strategy 1: Extract from ```json ... ``` fences
const fenceStart = content.indexOf('```json');
const fenceEnd = content.lastIndexOf('```');
if (fenceStart >= 0 && fenceEnd > fenceStart) {
  const inner = content.slice(fenceStart + 7, fenceEnd).trim();
  try {
    const parsed = JSON.parse(inner);
    writeFileSync(filePath, JSON.stringify(parsed, null, 2));
    console.log(`Cleaned ${filePath}: ${parsed.length} blocks (extracted from json fence)`);
    process.exit(0);
  } catch (e) {
    console.log('Fence extraction failed, trying array extraction...');
  }
}

// Strategy 2: Find the JSON array by matching balanced brackets
const firstBracket = content.indexOf('[\n');
if (firstBracket >= 0) {
  // Walk forward to find the matching ]
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = firstBracket; i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end > 0) {
    const jsonStr = content.slice(firstBracket, end + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      writeFileSync(filePath, JSON.stringify(parsed, null, 2));
      console.log(`Cleaned ${filePath}: ${parsed.length} blocks (balanced bracket extraction)`);
      process.exit(0);
    } catch (e) {
      console.error('Balanced bracket extraction failed:', e.message);
    }
  }
}

console.error('Could not extract JSON array from file');
process.exit(1);
