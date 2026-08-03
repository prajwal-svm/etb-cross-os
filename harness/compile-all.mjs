#!/usr/bin/env node
/**
 * ETB cross-OS compilation orchestrator.
 *
 * Usage:
 *   node harness/compile-all.mjs --catalog-path catalog.json --host ubuntu-x64
 *   node harness/compile-all.mjs --limit 5 --skip-markdown --skip-typst
 *   node harness/compile-all.mjs --out results/per-engine-results-ubuntu-x64.jsonl
 *
 * License: MIT
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  createReadStream,
} from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { platform, arch } from 'node:os';

import {
  compileLatex,
  compileTypst,
  LATEX_ENGINE_KEYS,
  probeVersions,
  publicRow,
} from './lib/engines.mjs';
import {
  ensureDir,
  writeJson,
  appendJsonl,
  nowIso,
  COMPILE_TIMEOUT_MS,
} from './lib/measure.mjs';
import { buildSimilarityMatrix } from './lib/similarity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    limit: null,
    resume: false,
    skipMarkdown: true, // default skip for cross-OS
    skipTypst: false,
    only: null,
    catalogPath: join(ROOT, 'catalog.json'),
    datasetRoot: ROOT, // file_path relative to repo root (seeds/...)
    host: null,
    out: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') {
      const n = parseInt(argv[++i], 10);
      args.limit = n === 0 ? null : n;
    } else if (a === '--resume') args.resume = true;
    else if (a === '--skip-markdown') args.skipMarkdown = true;
    else if (a === '--skip-typst') args.skipTypst = true;
    else if (a === '--only') args.only = argv[++i];
    else if (a === '--catalog-path') args.catalogPath = resolve(argv[++i]);
    else if (a === '--dataset-root') args.datasetRoot = resolve(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function hostMeta(hostFlag) {
  const os = platform(); // linux, win32, darwin
  const cpu = arch();
  const host =
    hostFlag ||
    (os === 'linux'
      ? `ubuntu-${cpu}`
      : os === 'win32'
        ? `windows-${cpu}`
        : os === 'darwin'
          ? `macos-${cpu}`
          : `${os}-${cpu}`);
  return { host, os, arch: cpu };
}

function log(msg, logsDir) {
  const line = `[${nowIso()}] ${msg}`;
  console.log(line);
  ensureDir(logsDir);
  writeFileSync(join(logsDir, 'compile-run.log'), line + '\n', { flag: 'a' });
}

async function loadDoneKeys(jsonlPath) {
  const set = new Set();
  if (!existsSync(jsonlPath)) return set;
  const rl = createInterface({
    input: createReadStream(jsonlPath, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.doc_id && o.engine) set.add(`${o.doc_id}||${o.engine}`);
    } catch {
      /* skip */
    }
  }
  return set;
}

function tagRow(row, meta) {
  return {
    ...publicRow(row),
    host: meta.host,
    os: meta.os,
    arch: meta.arch,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node harness/compile-all.mjs [options]
  --catalog-path PATH   catalog.json location (default: ./catalog.json)
  --dataset-root PATH   root for file_path resolution (default: repo root)
  --host NAME           host label (e.g. ubuntu-x64, windows-x64)
  --out PATH            output JSONL path
  --limit N             max docs per format (0 = all)
  --skip-typst
  --skip-markdown       (default true for cross-OS)
  --only latex|typst
  --resume`);
    process.exit(0);
  }

  const meta = hostMeta(args.host);
  const resultsDir = join(ROOT, 'results');
  const artifactsDir = join(ROOT, 'artifacts');
  const logsDir = join(ROOT, 'logs');
  ensureDir(resultsDir);
  ensureDir(artifactsDir);
  ensureDir(logsDir);

  const perEngineJsonl =
    args.out ||
    join(resultsDir, `per-engine-results-${meta.host}.jsonl`);
  const progressJson = join(resultsDir, `progress-${meta.host}.json`);
  const runMetaJson = join(resultsDir, `run-meta-${meta.host}.json`);
  const similarityJson = join(resultsDir, `pdf-text-similarity-${meta.host}.json`);

  const catalogPath = args.catalogPath;
  if (!existsSync(catalogPath)) {
    console.error(`Catalog not found: ${catalogPath}`);
    process.exit(1);
  }

  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const documents = catalog.documents || [];
  log(
    `Loaded catalog: ${documents.length} docs | host=${meta.host} os=${meta.os} arch=${meta.arch}`,
    logsDir,
  );

  const versions = await probeVersions();
  writeJson(runMetaJson, {
    started_at: nowIso(),
    catalog_path: catalogPath,
    dataset_root: args.datasetRoot,
    catalog_total: documents.length,
    host: meta,
    args,
    versions,
    timeout_ms: COMPILE_TIMEOUT_MS,
  });
  log(`Engine versions: ${JSON.stringify(versions).slice(0, 600)}`, logsDir);

  if (!args.resume) {
    writeFileSync(perEngineJsonl, '');
  }
  const doneKeys = args.resume ? await loadDoneKeys(perEngineJsonl) : new Set();
  if (args.resume) log(`Resume: ${doneKeys.size} rows done`, logsDir);

  let latexDocs = documents.filter((d) => d.format === 'latex');
  let typstDocs = documents.filter((d) => d.format === 'typst');
  if (args.limit != null) {
    latexDocs = latexDocs.slice(0, args.limit);
    typstDocs = typstDocs.slice(0, args.limit);
    log(`LIMIT: latex=${latexDocs.length} typst=${typstDocs.length}`, logsDir);
  }

  const similarityRecords = [];
  let compiled = 0;
  let failures = 0;
  const t0 = Date.now();

  // ---------- LaTeX ----------
  if (!args.only || args.only === 'latex') {
    log(`=== LaTeX: ${latexDocs.length} docs × up to 4 engines ===`, logsDir);
    for (let i = 0; i < latexDocs.length; i++) {
      const doc = latexDocs[i];
      // Windows-safe: join handles separators; file_path uses /
      const rel = doc.file_path.replace(/\\/g, '/');
      const absMain = resolve(args.datasetRoot, ...rel.split('/'));
      const srcDir = dirname(absMain);
      const mainFile = basename(absMain);
      if (!existsSync(absMain)) {
        log(`SKIP missing ${doc.id}: ${absMain}`, logsDir);
        continue;
      }

      const engineTexts = {};
      for (const engine of LATEX_ENGINE_KEYS) {
        const key = `${doc.id}||${engine}`;
        if (doneKeys.has(key)) continue;

        const row = await compileLatex({
          doc_id: doc.id,
          srcDir,
          mainFile,
          engine,
          artifactDir: artifactsDir,
          timeoutMs: COMPILE_TIMEOUT_MS,
        });
        appendJsonl(perEngineJsonl, tagRow(row, meta));
        compiled++;
        if (!row.success) failures++;
        if (row.success && row._text != null) engineTexts[engine] = row._text;

        // Heartbeat every compile that is slow/timeout so CI never looks "stuck"
        // for minutes with no log (this is what made the macOS hang look dead).
        const wall = row.wall_time_ms || 0;
        if (row.timeout || wall >= 45_000) {
          log(
            `slow ${engine} ${doc.id} wall=${(wall / 1000).toFixed(1)}s success=${row.success} timeout=${!!row.timeout} err=${row.error_type || ''}`,
            logsDir,
          );
        }

        if (compiled % 10 === 0 || row.timeout) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          log(
            `progress latex ${i + 1}/${latexDocs.length} | ${compiled} compiles | ${failures} fails | ${elapsed}s`,
            logsDir,
          );
          writeJson(progressJson, {
            phase: 'latex',
            host: meta.host,
            doc_index: i,
            compiled,
            failures,
            elapsed_s: Number(elapsed),
            last_doc: doc.id,
            last_engine: engine,
          });
        }
      }

      if (doc.engine_class === 'cross-engine') {
        const present = LATEX_ENGINE_KEYS.filter((e) => engineTexts[e] != null);
        if (present.length >= 2) {
          const matrix = buildSimilarityMatrix(engineTexts, LATEX_ENGINE_KEYS, {
            threshold: 0.95,
          });
          similarityRecords.push({
            doc_id: doc.id,
            host: meta.host,
            engines: {
              tectonic: engineTexts.tectonic != null,
              pdflatex: engineTexts.pdflatex != null,
              xelatex: engineTexts.xelatex != null,
              lualatex: engineTexts.lualatex != null,
            },
            similarity_matrix: matrix.similarity_matrix,
            pairwise: matrix.pairwise,
            min_pairwise: matrix.min_pairwise,
            flagged_inconsistent: matrix.flagged_inconsistent,
          });
        }
      }
    }
    writeJson(similarityJson, {
      generated_at: nowIso(),
      host: meta.host,
      threshold: 0.95,
      count: similarityRecords.length,
      documents: similarityRecords,
    });
    log(`LaTeX done. similarity records=${similarityRecords.length}`, logsDir);
  }

  // ---------- Typst ----------
  if ((!args.only || args.only === 'typst') && !args.skipTypst) {
    log(`=== Typst: ${typstDocs.length} docs ===`, logsDir);
    for (let i = 0; i < typstDocs.length; i++) {
      const doc = typstDocs[i];
      const key = `${doc.id}||typst`;
      if (doneKeys.has(key)) continue;
      const rel = doc.file_path.replace(/\\/g, '/');
      const absMain = resolve(args.datasetRoot, ...rel.split('/'));
      const srcDir = dirname(absMain);
      const mainFile = basename(absMain);
      if (!existsSync(absMain)) {
        log(`SKIP missing ${doc.id}`, logsDir);
        continue;
      }
      const row = await compileTypst({
        doc_id: doc.id,
        srcDir,
        mainFile,
        artifactDir: artifactsDir,
        timeoutMs: COMPILE_TIMEOUT_MS,
      });
      appendJsonl(perEngineJsonl, tagRow(row, meta));
      compiled++;
      if (!row.success) failures++;
      if (compiled % 50 === 0) {
        log(
          `progress typst ${i + 1}/${typstDocs.length} | ${compiled} compiles | ${failures} fails`,
          logsDir,
        );
      }
    }
    log('Typst done.', logsDir);
  } else if (args.skipTypst) {
    log('Skipping Typst (--skip-typst).', logsDir);
  }

  if (!args.skipMarkdown && args.only === 'markdown') {
    log('Markdown phase not enabled in cross-OS harness (use main ETB repo).', logsDir);
  }

  const elapsed_s = (Date.now() - t0) / 1000;
  writeJson(progressJson, {
    phase: 'done',
    host: meta.host,
    compiled,
    failures,
    elapsed_s,
    finished_at: nowIso(),
  });
  writeJson(runMetaJson, {
    ...JSON.parse(readFileSync(runMetaJson, 'utf8')),
    finished_at: nowIso(),
    compiled,
    failures,
    elapsed_s,
    output: perEngineJsonl,
  });
  log(
    `DONE host=${meta.host} compiles=${compiled} failures=${failures} elapsed=${elapsed_s.toFixed(1)}s out=${perEngineJsonl}`,
    logsDir,
  );

  // Print quick success rates
  try {
    const lines = readFileSync(perEngineJsonl, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const by = {};
    for (const r of lines) {
      by[r.engine] = by[r.engine] || { n: 0, ok: 0 };
      by[r.engine].n++;
      if (r.success) by[r.engine].ok++;
    }
    console.log('=== SUCCESS RATES ===');
    for (const [e, v] of Object.entries(by).sort()) {
      console.log(
        `  ${e}: ${((100 * v.ok) / v.n).toFixed(1)}% (${v.ok}/${v.n})`,
      );
    }
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
