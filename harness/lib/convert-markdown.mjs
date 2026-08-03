/**
 * Select simple LaTeX documents and convert them to Markdown via pandoc.
 * License: MIT
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runCmdTimed, ENV_PATH, ensureDir, resolveBin, writeJson } from './measure.mjs';

const COMPLEX_PACKAGES = new Set([
  'tikz',
  'pgfplots',
  'pgf',
  'beamer',
  'circuitikz',
  'pstricks',
  'minted',
  'pythontex',
  'sagetex',
  'asymptote',
  'fontspec', // often engine-specific fonts
  'xeCJK',
  'ctex',
  'luatexja',
  'polyglossia',
]);

const SIMPLE_CLASSES = new Set([
  'article',
  'report',
  'letter',
  'book',
  'scrartcl',
  'scrreprt',
  'scrlttr2',
  'extarticle',
  'extreport',
]);

/**
 * Score a LaTeX catalog entry for "simple" suitability (lower = better).
 * Prefer short articles/letters/reports without complex packages.
 */
export function simplicityScore(doc) {
  let score = 0;
  score += (doc.size_bytes || 0) / 1000;
  score += (doc.compile_time_ms || 0) / 100;
  const cls = (doc.document_class || '').toLowerCase();
  if (!SIMPLE_CLASSES.has(cls)) score += 50;
  if (cls === 'beamer') score += 200;
  const pkgs = doc.uses_packages || [];
  for (const p of pkgs) {
    const base = String(p).split('/')[0].toLowerCase();
    if (COMPLEX_PACKAGES.has(base)) score += 80;
  }
  score += pkgs.length * 2;
  // Prefer article / letter / report categories
  const cat = (doc.category || '').toLowerCase();
  if (['letter', 'report', 'venue', 'coursework', 'business'].includes(cat)) {
    score -= 10;
  }
  if (['beamer', 'thesis', 'book'].includes(cat)) score += 40;
  return score;
}

/**
 * Pick N simple cross-engine LaTeX docs.
 * @param {object[]} documents catalog documents
 * @param {number} n
 */
export function selectSimpleLatex(documents, n = 100) {
  const candidates = documents.filter(
    (d) =>
      d.format === 'latex' &&
      d.engine_class === 'cross-engine' &&
      d.file_path &&
      d.compiled_engines?.tectonic &&
      d.compiled_engines?.pdflatex,
  );
  candidates.sort((a, b) => simplicityScore(a) - simplicityScore(b));
  return candidates.slice(0, n);
}

/**
 * Convert one .tex file to Markdown with pandoc.
 * @returns {{ ok: boolean, mdPath: string|null, log: string, wall_time_ms: number }}
 */
export async function convertTexToMarkdown(texPath, outMdPath) {
  const pandoc = resolveBin([
    process.env.PANDOC_PATH,
    '/opt/homebrew/bin/pandoc',
    'pandoc',
  ]);
  ensureDir(dirname(outMdPath));
  const r = await runCmdTimed(
    pandoc,
    [texPath, '-f', 'latex', '-t', 'markdown', '-o', outMdPath, '--wrap=none'],
    { timeoutMs: 60_000, env: { PATH: ENV_PATH } },
  );
  const log = (r.stdout || '') + '\n' + (r.stderr || '');
  const ok = r.code === 0 && existsSync(outMdPath) && statSync(outMdPath).size > 0;
  return {
    ok,
    mdPath: ok ? outMdPath : null,
    log,
    wall_time_ms: r.wall_time_ms,
    timedOut: r.timedOut,
    code: r.code,
  };
}

/**
 * Convert a list of catalog docs to Markdown under outRoot.
 * Structure: outRoot/<safe_id>/main.md + conversion.json
 *
 * @param {object[]} docs
 * @param {string} datasetRoot absolute path to texfix-bench/dataset
 * @param {string} outRoot absolute path for markdown outputs
 */
export async function convertBatch(docs, datasetRoot, outRoot) {
  ensureDir(outRoot);
  const results = [];
  for (const doc of docs) {
    const texAbs = resolve(datasetRoot, doc.file_path);
    const safeId = String(doc.id).replace(/[^\w.-]+/g, '__');
    const dir = join(outRoot, safeId);
    ensureDir(dir);
    const outMd = join(dir, 'main.md');
    let entry;
    if (!existsSync(texAbs)) {
      entry = {
        doc_id: doc.id,
        ok: false,
        error: 'tex missing',
        md_path: null,
      };
    } else {
      const r = await convertTexToMarkdown(texAbs, outMd);
      entry = {
        doc_id: doc.id,
        ok: r.ok,
        md_path: r.ok ? outMd : null,
        relative_md: r.ok ? join(safeId, 'main.md') : null,
        wall_time_ms: r.wall_time_ms,
        log_tail: (r.log || '').slice(-2000),
        size_bytes: doc.size_bytes,
        document_class: doc.document_class,
        category: doc.category,
        simplicity_score: simplicityScore(doc),
      };
      writeJson(join(dir, 'conversion.json'), entry);
    }
    results.push(entry);
    process.stdout.write(
      `  convert ${doc.id}: ${entry.ok ? 'ok' : 'FAIL'}\n`,
    );
  }
  writeJson(join(outRoot, 'index.json'), {
    generated_at: new Date().toISOString(),
    count: results.length,
    success: results.filter((r) => r.ok).length,
    documents: results,
  });
  return results;
}
