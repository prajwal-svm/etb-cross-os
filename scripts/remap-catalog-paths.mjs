#!/usr/bin/env node
/**
 * Remap catalog.json file_path from dataset/processed/... to seeds/...
 * Usage: node scripts/remap-catalog-paths.mjs [catalog.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.argv[2] || 'catalog.json');
const cat = JSON.parse(readFileSync(path, 'utf8'));
let n = 0;
for (const d of cat.documents || []) {
  if (!d.file_path) continue;
  let p = d.file_path.replace(/\\/g, '/');
  // strip leading processed/ or dataset/processed/
  p = p.replace(/^(?:\.\/)?(?:dataset\/)?processed\//, 'seeds/');
  if (!p.startsWith('seeds/')) {
    // already absolute-ish relative under latex|typst|markdown
    if (/^(latex|typst|markdown)\//.test(p)) p = 'seeds/' + p;
  }
  if (p !== d.file_path) n++;
  d.file_path = p;
}
writeFileSync(path, JSON.stringify(cat));
console.log(`Remapped ${n} paths in ${path}; total docs=${(cat.documents||[]).length}`);
