#!/usr/bin/env node
/**
 * Aggregate Engine-Transfer-Bench results into:
 *   - error-catalog.json
 *   - analysis-summary.json
 *   - SCRAPER-LOG.md (measurement summary)
 *
 * License: MIT
 */

import {
  existsSync,
  readFileSync,
  createReadStream,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson, nowIso } from './lib/measure.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RESULTS = join(ROOT, 'results');

const PER_ENGINE = join(RESULTS, 'per-engine-results.jsonl');
const MARKDOWN = join(RESULTS, 'markdown-results.jsonl');
const SIMILARITY = join(RESULTS, 'pdf-text-similarity.json');
const RUN_META = join(RESULTS, 'run-meta.json');
const ERROR_CATALOG = join(RESULTS, 'error-catalog.json');
const ANALYSIS = join(RESULTS, 'analysis-summary.json');
const SCRAPER_LOG = join(ROOT, 'SCRAPER-LOG.md');

async function readJsonl(path) {
  const rows = [];
  if (!existsSync(path)) return rows;
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return rows;
}

function mean(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(nums, p) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

function summarizeEngine(rows) {
  const n = rows.length;
  const successes = rows.filter((r) => r.success);
  const fails = rows.filter((r) => !r.success);
  const times = successes
    .map((r) => r.wall_time_ms)
    .filter((t) => t != null && Number.isFinite(t));
  const sizes = successes
    .map((r) => r.pdf_size_bytes)
    .filter((s) => s != null && Number.isFinite(s));
  const pages = successes
    .map((r) => r.page_count)
    .filter((p) => p != null && Number.isFinite(p));
  const timeouts = rows.filter((r) => r.timeout).length;
  const errorTypes = {};
  for (const r of fails) {
    const t = r.error_type || 'other';
    errorTypes[t] = (errorTypes[t] || 0) + 1;
  }
  return {
    n,
    success_count: successes.length,
    failure_count: fails.length,
    success_rate: n ? successes.length / n : null,
    timeout_count: timeouts,
    wall_time_ms: {
      mean: mean(times),
      median: median(times),
      p90: percentile(times, 90),
      p99: percentile(times, 99),
      min: times.length ? Math.min(...times) : null,
      max: times.length ? Math.max(...times) : null,
      n: times.length,
    },
    pdf_size_bytes: {
      mean: mean(sizes),
      median: median(sizes),
      n: sizes.length,
    },
    page_count: {
      mean: mean(pages),
      median: median(pages),
      n: pages.length,
    },
    error_type_distribution: errorTypes,
  };
}

function buildErrorCatalog(allRows) {
  /** @type {Record<string, Record<string, { count: number, example_docs: string[], example_messages: string[] }>>} */
  const byEngine = {};
  for (const r of allRows) {
    if (r.success) continue;
    const eng = r.engine || 'unknown';
    const typ = r.error_type || 'other';
    if (!byEngine[eng]) byEngine[eng] = {};
    if (!byEngine[eng][typ]) {
      byEngine[eng][typ] = {
        count: 0,
        example_docs: [],
        example_messages: [],
      };
    }
    const bucket = byEngine[eng][typ];
    bucket.count++;
    if (bucket.example_docs.length < 5 && r.doc_id) {
      bucket.example_docs.push(r.doc_id);
    }
    if (
      bucket.example_messages.length < 3 &&
      r.first_error_message
    ) {
      bucket.example_messages.push(
        String(r.first_error_message).slice(0, 300),
      );
    }
  }

  // Flat list for the required shape: { engine, error_type, count, example_docs, example_messages }
  const flat = [];
  for (const [engine, types] of Object.entries(byEngine)) {
    for (const [error_type, info] of Object.entries(types)) {
      flat.push({
        engine,
        error_type,
        count: info.count,
        example_docs: info.example_docs,
        example_messages: info.example_messages,
      });
    }
  }
  flat.sort((a, b) => b.count - a.count);
  return { generated_at: nowIso(), by_engine: byEngine, catalog: flat };
}

function summarizeSimilarity(simDoc) {
  if (!simDoc || !simDoc.documents) {
    return {
      n_documents: 0,
      n_flagged_inconsistent: 0,
      mean_min_pairwise: null,
      median_min_pairwise: null,
      pairwise_means: {},
    };
  }
  const docs = simDoc.documents;
  const mins = docs
    .map((d) => d.min_pairwise)
    .filter((x) => x != null && Number.isFinite(x));
  const flagged = docs.filter((d) => d.flagged_inconsistent).length;
  const pairKeys = new Set();
  for (const d of docs) {
    if (d.pairwise) {
      for (const k of Object.keys(d.pairwise)) pairKeys.add(k);
    }
  }
  const pairwise_means = {};
  for (const k of pairKeys) {
    const vals = docs
      .map((d) => d.pairwise?.[k])
      .filter((x) => x != null && Number.isFinite(x));
    pairwise_means[k] = {
      mean: mean(vals),
      median: median(vals),
      n: vals.length,
      n_below_0_95: vals.filter((v) => v < 0.95).length,
    };
  }
  return {
    n_documents: docs.length,
    n_flagged_inconsistent: flagged,
    fraction_flagged: docs.length ? flagged / docs.length : null,
    mean_min_pairwise: mean(mins),
    median_min_pairwise: median(mins),
    pairwise_means,
    threshold: simDoc.threshold ?? 0.95,
  };
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

function fmtRate(x) {
  if (x == null || !Number.isFinite(x)) return 'n/a';
  return `${(x * 100).toFixed(1)}%`;
}

function fmtMs(x) {
  if (x == null || !Number.isFinite(x)) return 'n/a';
  return x < 1000 ? `${x.toFixed(0)} ms` : `${(x / 1000).toFixed(2)} s`;
}

function fmtBytes(x) {
  if (x == null || !Number.isFinite(x)) return 'n/a';
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KiB`;
  return `${(x / (1024 * 1024)).toFixed(2)} MiB`;
}

async function main() {
  console.log('Reading results…');
  const engineRows = await readJsonl(PER_ENGINE);
  const mdRows = await readJsonl(MARKDOWN);
  const sim = existsSync(SIMILARITY)
    ? JSON.parse(readFileSync(SIMILARITY, 'utf8'))
    : null;
  const meta = existsSync(RUN_META)
    ? JSON.parse(readFileSync(RUN_META, 'utf8'))
    : {};

  // Group by engine
  const byEngine = {};
  for (const r of engineRows) {
    const e = r.engine || 'unknown';
    if (!byEngine[e]) byEngine[e] = [];
    byEngine[e].push(r);
  }
  const byMdEngine = {};
  for (const r of mdRows) {
    const e = r.engine || 'unknown';
    if (!byMdEngine[e]) byMdEngine[e] = [];
    byMdEngine[e].push(r);
  }

  const per_engine = {};
  for (const [e, rows] of Object.entries(byEngine)) {
    per_engine[e] = summarizeEngine(rows);
  }
  const per_markdown_backend = {};
  for (const [e, rows] of Object.entries(byMdEngine)) {
    per_markdown_backend[e] = summarizeEngine(rows);
  }

  const errorCatalog = buildErrorCatalog([...engineRows, ...mdRows]);
  writeJson(ERROR_CATALOG, errorCatalog);

  const similarity_summary = summarizeSimilarity(sim);

  const analysis = {
    generated_at: nowIso(),
    run_meta: {
      started_at: meta.started_at || null,
      finished_at: meta.finished_at || null,
      elapsed_s: meta.elapsed_s || null,
      versions: meta.versions || null,
      catalog_total: meta.catalog_total || null,
      args: meta.args || null,
    },
    totals: {
      engine_rows: engineRows.length,
      markdown_rows: mdRows.length,
      unique_docs_engine: new Set(engineRows.map((r) => r.doc_id)).size,
      unique_docs_markdown: new Set(mdRows.map((r) => r.doc_id)).size,
    },
    per_engine,
    per_markdown_backend,
    cross_engine_similarity: similarity_summary,
    notes: [
      'S_pdf uses token-level LCS Dice coefficient (same as TeXFix-Bench).',
      'Inconsistency flag: min pairwise similarity < 0.95 among available engines.',
      'Markdown HTML backend uses Chrome headless print-to-pdf (weasyprint/wkhtmltopdf unavailable).',
      'Timeout: 60s per compilation (multi-pass LaTeX shares one budget).',
      'Source documents were never modified; workdirs are ephemeral copies.',
    ],
  };
  writeJson(ANALYSIS, analysis);

  // Human-readable SCRAPER-LOG.md
  const lines = [];
  lines.push('# Engine-Transfer-Bench Measurement Log');
  lines.push('');
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push(
    'Paper 2 measurement pipeline: compile working documents under multiple engines; no AI, no mutations, no source edits.',
  );
  lines.push('');
  lines.push(`- Catalog: \`${meta.catalog_path || '../texfix-bench/dataset/catalog.json'}\``);
  lines.push(`- Catalog total: ${meta.catalog_total ?? 'n/a'}`);
  lines.push(`- Started: ${meta.started_at || 'n/a'}`);
  lines.push(`- Finished: ${meta.finished_at || 'n/a'}`);
  lines.push(
    `- Elapsed: ${meta.elapsed_s != null ? `${meta.elapsed_s.toFixed(1)} s` : 'n/a'}`,
  );
  lines.push(`- Engine result rows: ${engineRows.length}`);
  lines.push(`- Markdown result rows: ${mdRows.length}`);
  lines.push(`- Similarity documents: ${similarity_summary.n_documents}`);
  lines.push('');
  lines.push('## Tool versions');
  lines.push('');
  if (meta.versions) {
    for (const [k, v] of Object.entries(meta.versions)) {
      lines.push(`- **${k}**: \`${String(v).replace(/`/g, "'")}\``);
    }
  } else {
    lines.push('_Not recorded (run compile-all.mjs first)._');
  }
  lines.push('');
  lines.push('## Per-engine results (native documents)');
  lines.push('');
  const engHeaders = [
    'Engine',
    'N',
    'Success rate',
    'Median time',
    'Mean time',
    'Timeouts',
    'Mean PDF size',
  ];
  const engRows = Object.entries(per_engine)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([e, s]) => [
      e,
      String(s.n),
      fmtRate(s.success_rate),
      fmtMs(s.wall_time_ms.median),
      fmtMs(s.wall_time_ms.mean),
      String(s.timeout_count),
      fmtBytes(s.pdf_size_bytes.mean),
    ]);
  if (engRows.length) lines.push(mdTable(engHeaders, engRows));
  else lines.push('_No engine rows yet._');
  lines.push('');
  lines.push('## Markdown backends (pandoc)');
  lines.push('');
  const mdHeaders = engHeaders;
  const mdBody = Object.entries(per_markdown_backend)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([e, s]) => [
      e,
      String(s.n),
      fmtRate(s.success_rate),
      fmtMs(s.wall_time_ms.median),
      fmtMs(s.wall_time_ms.mean),
      String(s.timeout_count),
      fmtBytes(s.pdf_size_bytes.mean),
    ]);
  if (mdBody.length) lines.push(mdTable(mdHeaders, mdBody));
  else lines.push('_No markdown rows yet._');
  lines.push('');
  lines.push('## Cross-engine PDF text similarity');
  lines.push('');
  lines.push(
    `Documents with matrices: **${similarity_summary.n_documents}**`,
  );
  lines.push(
    `Flagged inconsistent (min pairwise < 0.95): **${similarity_summary.n_flagged_inconsistent}** (${fmtRate(similarity_summary.fraction_flagged)})`,
  );
  lines.push(
    `Mean min-pairwise S_pdf: **${similarity_summary.mean_min_pairwise != null ? similarity_summary.mean_min_pairwise.toFixed(4) : 'n/a'}**`,
  );
  lines.push(
    `Median min-pairwise S_pdf: **${similarity_summary.median_min_pairwise != null ? similarity_summary.median_min_pairwise.toFixed(4) : 'n/a'}**`,
  );
  lines.push('');
  if (Object.keys(similarity_summary.pairwise_means || {}).length) {
    lines.push('| Pair | Mean S_pdf | Median | N | N < 0.95 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const [pair, st] of Object.entries(similarity_summary.pairwise_means)) {
      lines.push(
        `| ${pair.replace('__', ' vs ')} | ${st.mean?.toFixed(4) ?? 'n/a'} | ${st.median?.toFixed(4) ?? 'n/a'} | ${st.n} | ${st.n_below_0_95} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Error distribution (failures)');
  lines.push('');
  if (errorCatalog.catalog.length) {
    lines.push('| Engine | Error type | Count | Example |');
    lines.push('| --- | --- | --- | --- |');
    for (const e of errorCatalog.catalog.slice(0, 40)) {
      const ex = (e.example_messages[0] || '')
        .replace(/\|/g, '\\|')
        .slice(0, 80);
      lines.push(`| ${e.engine} | ${e.error_type} | ${e.count} | ${ex} |`);
    }
  } else {
    lines.push('_No failures recorded (or no results yet)._');
  }
  lines.push('');
  lines.push('## Issues / notes');
  lines.push('');
  lines.push(
    '- **HTML PDF backend**: `weasyprint` and `wkhtmltopdf` were not installed; used Google Chrome headless `--print-to-pdf` after `pandoc -t html`.',
  );
  lines.push(
    '- **Network**: Compiles run with pre-installed TeX Live packages and a pre-warmed Tectonic cache; no intentional package downloads. Tectonic may still touch cache paths.',
  );
  lines.push(
    '- **Isolation**: Each compile copies the document directory to a fresh temp dir and deletes it afterward. Source tree is read-only.',
  );
  lines.push(
    '- **Timeout**: 60 seconds wall-clock budget per document×engine (all passes for multi-pass engines share the budget).',
  );
  lines.push(
    '- **LCS cap**: PDF text similarity truncates token sequences at 15,000 tokens per side for performance; truncated pairs are flagged in similarity records.',
  );
  lines.push(
    '- **Sequential execution**: Compilations are sequential to avoid CPU contention biasing wall-clock times.',
  );
  lines.push('');
  lines.push('## Output files');
  lines.push('');
  lines.push('| File | Description |');
  lines.push('| --- | --- |');
  lines.push('| `results/per-engine-results.jsonl` | One row per doc × native engine |');
  lines.push('| `results/pdf-text-similarity.json` | Cross-engine S_pdf matrices |');
  lines.push('| `results/markdown-results.jsonl` | Pandoc backend measurements |');
  lines.push('| `results/error-catalog.json` | Categorized failure summary |');
  lines.push('| `results/analysis-summary.json` | Aggregate statistics |');
  lines.push('| `artifacts/<doc>/<engine>/` | Compile logs + extracted text |');
  lines.push('');

  writeFileSync(SCRAPER_LOG, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${ERROR_CATALOG}`);
  console.log(`Wrote ${ANALYSIS}`);
  console.log(`Wrote ${SCRAPER_LOG}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
