/**
 * Engine-specific compilation functions for Engine-Transfer-Bench.
 * Engines: tectonic, pdflatex, xelatex, lualatex, typst,
 *          pandoc-tectonic, pandoc-typst, pandoc-html
 *
 * License: MIT
 */

import { existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, extname } from 'node:path';
import {
  COMPILE_TIMEOUT_MS,
  ENV_PATH,
  runCmdTimed,
  prepWorkDir,
  cleanupWorkDir,
  findPdf,
  extractPdfInfo,
  parseCompileLog,
  categorizeError,
  emptyResult,
  ensureDir,
  resolveBin,
  sha256,
} from './measure.mjs';

const HOME = process.env.HOME || process.env.USERPROFILE || '';

const LATEX_ENGINES = {
  tectonic: {
    key: 'tectonic',
    bin: () =>
      resolveBin([
        process.env.TECTONIC_PATH,
        `${HOME}/.local/bin/tectonic`,
        `${HOME}/.cargo/bin/tectonic`,
        '/opt/homebrew/bin/tectonic',
        '/usr/local/bin/tectonic',
        'tectonic',
        'tectonic.exe',
      ]),
    passes: 1,
    args: (file) => [
      '-X',
      'compile',
      file,
      '--keep-logs',
      '--keep-intermediates',
    ],
  },
  pdflatex: {
    key: 'pdflatex',
    bin: () =>
      resolveBin([
        '/Library/TeX/texbin/pdflatex',
        '/usr/bin/pdflatex',
        'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\pdflatex.exe',
        'pdflatex',
        'pdflatex.exe',
      ]),
    passes: 2,
    args: (file) => [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-no-shell-escape',
      file,
    ],
  },
  xelatex: {
    key: 'xelatex',
    bin: () =>
      resolveBin([
        '/Library/TeX/texbin/xelatex',
        '/usr/bin/xelatex',
        'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\xelatex.exe',
        'xelatex',
        'xelatex.exe',
      ]),
    passes: 2,
    args: (file) => [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-no-shell-escape',
      file,
    ],
  },
  lualatex: {
    key: 'lualatex',
    bin: () =>
      resolveBin([
        '/Library/TeX/texbin/lualatex',
        '/usr/bin/lualatex',
        'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64\\lualatex.exe',
        'lualatex',
        'lualatex.exe',
      ]),
    passes: 2,
    args: (file) => [
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-no-shell-escape',
      file,
    ],
  },
};

const TYPST = {
  key: 'typst',
  bin: () =>
    resolveBin([
      process.env.TYPST_PATH,
      `${HOME}/.local/bin/typst`,
      `${HOME}/.cargo/bin/typst`,
      '/opt/homebrew/bin/typst',
      '/usr/local/bin/typst',
      'typst',
      'typst.exe',
    ]),
  args: (file) => {
    const out = file.replace(/\.typ$/i, '.pdf');
    return ['compile', file, out];
  },
};

const PANDOC_BIN = () =>
  resolveBin([
    process.env.PANDOC_PATH,
    '/opt/homebrew/bin/pandoc',
    'pandoc',
  ]);

const CHROME_BIN = () =>
  resolveBin([
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ]);

/**
 * Run multi-pass compile in work dir. Returns timing aggregates.
 */
async function runLatexPasses(eng, bin, mainBase, work, timeoutMs) {
  let totalWall = 0;
  let totalCpu = 0;
  let peakRss = null;
  let hasCpu = false;
  let combinedLog = '';
  let timedOut = false;
  let lastCode = 1;
  const deadline = Date.now() + timeoutMs;
  for (let pass = 1; pass <= eng.passes; pass++) {
    const remaining = Math.max(1000, deadline - Date.now());
    const r = await runCmdTimed(bin, eng.args(mainBase), {
      cwd: work,
      timeoutMs: remaining,
      env: { PATH: ENV_PATH },
    });
    totalWall += r.wall_time_ms || 0;
    if (r.cpu_time_ms != null) {
      totalCpu += r.cpu_time_ms;
      hasCpu = true;
    }
    if (r.peak_rss_kb != null) {
      peakRss =
        peakRss == null ? r.peak_rss_kb : Math.max(peakRss, r.peak_rss_kb);
    }
    combinedLog += `\n--- pass ${pass} (code=${r.code}, timedOut=${r.timedOut}) ---\n`;
    combinedLog += (r.stdout || '') + '\n' + (r.stderr || '') + '\n';
    try {
      const logName = mainBase.replace(/\.tex$/i, '.log');
      const logPath = join(work, logName);
      if (existsSync(logPath)) {
        combinedLog += `\n--- ${logName} ---\n` + readFileSync(logPath, 'utf8');
      }
    } catch {
      /* ignore */
    }
    lastCode = r.code;
    if (r.timedOut) {
      timedOut = true;
      break;
    }
    if (r.code !== 0) break;
  }
  return {
    totalWall,
    totalCpu,
    hasCpu,
    peakRss,
    combinedLog,
    timedOut,
    lastCode,
  };
}

/**
 * Compile a native LaTeX document under one engine.
 *
 * @param {{
 *   doc_id: string, srcDir: string, mainFile: string, engine: string,
 *   artifactDir?: string, timeoutMs?: number,
 *   measureWarm?: boolean,
 *   measureDeterminism?: boolean,
 * }} opts
 */
export async function compileLatex(opts) {
  const {
    doc_id,
    srcDir,
    mainFile,
    engine,
    artifactDir = null,
    timeoutMs = COMPILE_TIMEOUT_MS,
    measureWarm = process.env.ETB_MEASURE_WARM === '1',
    measureDeterminism = process.env.ETB_MEASURE_DETERMINISM === '1',
  } = opts;
  const eng = LATEX_ENGINES[engine];
  const row = emptyResult(doc_id, engine);
  if (!eng) {
    row.first_error_message = `unknown engine: ${engine}`;
    row.error_type = 'other';
    return row;
  }

  const bin = eng.bin();
  if (!bin || (!existsSync(bin) && bin.includes('/'))) {
    row.first_error_message = `engine binary not found: ${engine}`;
    row.error_type = 'other';
    return row;
  }

  const work = prepWorkDir(srcDir, `etb-${engine}-`);
  const mainBase = basename(mainFile);

  try {
    // Cold compile (fresh workdir)
    const cold = await runLatexPasses(eng, bin, mainBase, work, timeoutMs);
    row.cold_wall_time_ms = Math.round(cold.totalWall * 100) / 100;
    row.wall_time_ms = row.cold_wall_time_ms;
    row.cpu_time_ms = cold.hasCpu ? Math.round(cold.totalCpu * 100) / 100 : null;
    row.peak_rss_kb = cold.peakRss;
    row.timeout = cold.timedOut;
    let combinedLog = cold.combinedLog;
    let lastCode = cold.lastCode;
    let timedOut = cold.timedOut;

    // Warm compile (reuse workdir intermediates) — optional
    if (measureWarm && !timedOut && lastCode === 0) {
      const warm = await runLatexPasses(eng, bin, mainBase, work, timeoutMs);
      row.warm_wall_time_ms = Math.round(warm.totalWall * 100) / 100;
      if (warm.peakRss != null) {
        row.peak_rss_kb =
          row.peak_rss_kb == null
            ? warm.peakRss
            : Math.max(row.peak_rss_kb, warm.peakRss);
      }
      combinedLog += '\n--- WARM RECOMPILE ---\n' + warm.combinedLog;
      // wall_time_ms remains cold (primary); warm is separate field
    }

    const pdfPath = findPdf(work, mainBase);
    const parsed = parseCompileLog(combinedLog);
    row.error_count = parsed.error_count;
    row.warning_count = parsed.warning_count;
    row.first_error_message = parsed.first_error_message;
    row.first_error_line = parsed.first_error_line;

    if (pdfPath && !timedOut && lastCode === 0) {
      row.success = true;
      const info = await extractPdfInfo(pdfPath);
      row.pdf_size_bytes = info.pdf_size_bytes;
      row.page_count = info.page_count;
      try {
        row.pdf_sha256 = sha256(readFileSync(pdfPath));
      } catch {
        row.pdf_sha256 = null;
      }

      // Determinism: second cold workdir compile, compare PDF hash
      if (measureDeterminism) {
        const work2 = prepWorkDir(srcDir, `etb-${engine}-det-`);
        try {
          const det = await runLatexPasses(eng, bin, mainBase, work2, timeoutMs);
          const pdf2 = findPdf(work2, mainBase);
          if (det.lastCode === 0 && pdf2 && row.pdf_sha256) {
            const h2 = sha256(readFileSync(pdf2));
            row.deterministic = h2 === row.pdf_sha256;
          } else {
            row.deterministic = false;
          }
        } finally {
          cleanupWorkDir(work2);
        }
      }

      if (artifactDir) {
        const out = saveArtifacts({
          artifactDir,
          doc_id,
          engine,
          pdfPath,
          log: combinedLog,
          text: info.text,
        });
        row.log_path = out.log_path;
        row.text_path = out.text_path;
        row.pdf_path = out.pdf_path;
        row._text = info.text; // in-memory for similarity (not written to jsonl)
      } else {
        row._text = info.text;
      }
    } else {
      row.success = false;
      row.error_type = categorizeError({
        timedOut,
        log: combinedLog,
        first_error_message: parsed.first_error_message,
        code: lastCode,
      });
      if (timedOut) {
        row.first_error_message =
          row.first_error_message || `timeout after ${timeoutMs}ms`;
      }
      if (artifactDir) {
        const out = saveArtifacts({
          artifactDir,
          doc_id,
          engine,
          pdfPath: null,
          log: combinedLog,
          text: null,
        });
        row.log_path = out.log_path;
      }
    }
  } catch (err) {
    row.success = false;
    row.error_type = 'other';
    row.first_error_message = String(err.message || err);
  } finally {
    cleanupWorkDir(work);
  }
  return row;
}

/**
 * Compile a Typst document.
 */
export async function compileTypst(opts) {
  const {
    doc_id,
    srcDir,
    mainFile,
    artifactDir = null,
    timeoutMs = COMPILE_TIMEOUT_MS,
  } = opts;
  const engine = 'typst';
  const row = emptyResult(doc_id, engine);
  const bin = TYPST.bin();
  if (!bin) {
    row.first_error_message = 'typst binary not found';
    row.error_type = 'other';
    return row;
  }

  const work = prepWorkDir(srcDir, 'etb-typst-');
  const mainBase = basename(mainFile);
  try {
    const r = await runCmdTimed(bin, TYPST.args(mainBase), {
      cwd: work,
      timeoutMs,
      env: { PATH: ENV_PATH },
    });
    row.wall_time_ms = Math.round((r.wall_time_ms || 0) * 100) / 100;
    row.cpu_time_ms =
      r.cpu_time_ms != null ? Math.round(r.cpu_time_ms * 100) / 100 : null;
    row.timeout = !!r.timedOut;
    const log = (r.stdout || '') + '\n' + (r.stderr || '');
    const parsed = parseCompileLog(log);
    row.error_count = parsed.error_count;
    row.warning_count = parsed.warning_count;
    row.first_error_message = parsed.first_error_message;
    row.first_error_line = parsed.first_error_line;

    const pdfPath = findPdf(work, mainBase);
    if (pdfPath && r.code === 0 && !r.timedOut) {
      row.success = true;
      const info = await extractPdfInfo(pdfPath);
      row.pdf_size_bytes = info.pdf_size_bytes;
      row.page_count = info.page_count;
      if (artifactDir) {
        const out = saveArtifacts({
          artifactDir,
          doc_id,
          engine,
          pdfPath,
          log,
          text: info.text,
        });
        row.log_path = out.log_path;
        row.text_path = out.text_path;
        row.pdf_path = out.pdf_path;
        row._text = info.text;
      } else {
        row._text = info.text;
      }
    } else {
      row.success = false;
      row.error_type = categorizeError({
        timedOut: r.timedOut,
        log,
        first_error_message: parsed.first_error_message,
        code: r.code,
      });
      if (r.timedOut) {
        row.first_error_message =
          row.first_error_message || `timeout after ${timeoutMs}ms`;
      }
      if (artifactDir) {
        const out = saveArtifacts({
          artifactDir,
          doc_id,
          engine,
          pdfPath: null,
          log,
          text: null,
        });
        row.log_path = out.log_path;
      }
    }
  } catch (err) {
    row.success = false;
    row.error_type = 'other';
    row.first_error_message = String(err.message || err);
  } finally {
    cleanupWorkDir(work);
  }
  return row;
}

/**
 * Compile Markdown via pandoc with a given PDF backend.
 * backend: 'tectonic' | 'typst' | 'html'
 * For 'html': pandoc → HTML, then Chrome headless --print-to-pdf
 * (weasyprint / wkhtmltopdf not available on this machine).
 */
export async function compileMarkdown(opts) {
  const {
    doc_id,
    mdPath,
    backend, // tectonic | typst | html
    artifactDir = null,
    timeoutMs = COMPILE_TIMEOUT_MS,
  } = opts;
  const engine = `pandoc-${backend}`;
  const row = emptyResult(doc_id, engine);
  const pandoc = PANDOC_BIN();
  if (!pandoc) {
    row.first_error_message = 'pandoc binary not found';
    row.error_type = 'other';
    return row;
  }

  // Work in a temp copy of the markdown directory
  const srcDir = dirname(mdPath);
  const work = prepWorkDir(srcDir, `etb-md-${backend}-`);
  // Ensure the md file itself is present (prepWorkDir copies dir contents)
  const mdBase = basename(mdPath);
  const workMd = join(work, mdBase);
  if (!existsSync(workMd) && existsSync(mdPath)) {
    writeFileSync(workMd, readFileSync(mdPath));
  }
  const outPdf = join(work, 'output.pdf');

  try {
    let r;
    let log = '';

    if (backend === 'tectonic' || backend === 'typst') {
      r = await runCmdTimed(
        pandoc,
        [mdBase, '-o', 'output.pdf', `--pdf-engine=${backend}`],
        { cwd: work, timeoutMs, env: { PATH: ENV_PATH } },
      );
      log = (r.stdout || '') + '\n' + (r.stderr || '');
    } else if (backend === 'html') {
      // pandoc → standalone HTML, then Chrome print-to-pdf
      const htmlFile = 'output.html';
      const r1 = await runCmdTimed(
        pandoc,
        [mdBase, '-o', htmlFile, '-s', '--metadata', 'title=Document'],
        { cwd: work, timeoutMs: Math.min(timeoutMs, 30_000), env: { PATH: ENV_PATH } },
      );
      log += (r1.stdout || '') + '\n' + (r1.stderr || '') + '\n';
      if (r1.code !== 0 || r1.timedOut) {
        r = r1;
      } else {
        const chrome = CHROME_BIN();
        const htmlAbs = join(work, htmlFile);
        const pdfAbs = outPdf;
        const remaining = Math.max(
          5000,
          timeoutMs - (r1.wall_time_ms || 0),
        );
        const r2 = await runCmdTimed(
          chrome,
          [
            '--headless',
            '--disable-gpu',
            '--no-pdf-header-footer',
            `--print-to-pdf=${pdfAbs}`,
            `file://${htmlAbs}`,
          ],
          { cwd: work, timeoutMs: remaining, env: { PATH: ENV_PATH } },
        );
        r = {
          code: r2.code,
          timedOut: r2.timedOut || r1.timedOut,
          wall_time_ms: (r1.wall_time_ms || 0) + (r2.wall_time_ms || 0),
          cpu_time_ms:
            r1.cpu_time_ms != null || r2.cpu_time_ms != null
              ? (r1.cpu_time_ms || 0) + (r2.cpu_time_ms || 0)
              : null,
          stdout: (r1.stdout || '') + (r2.stdout || ''),
          stderr: (r1.stderr || '') + (r2.stderr || ''),
        };
        log += (r2.stdout || '') + '\n' + (r2.stderr || '');
      }
    } else {
      row.first_error_message = `unknown pandoc backend: ${backend}`;
      row.error_type = 'other';
      return row;
    }

    row.wall_time_ms = Math.round((r.wall_time_ms || 0) * 100) / 100;
    row.cpu_time_ms =
      r.cpu_time_ms != null ? Math.round(r.cpu_time_ms * 100) / 100 : null;
    row.timeout = !!r.timedOut;
    const parsed = parseCompileLog(log);
    row.error_count = parsed.error_count;
    row.warning_count = parsed.warning_count;
    row.first_error_message = parsed.first_error_message;
    row.first_error_line = parsed.first_error_line;

    const pdfPath = existsSync(outPdf) ? outPdf : findPdf(work, mdBase);
    if (pdfPath && r.code === 0 && !r.timedOut) {
      row.success = true;
      const info = await extractPdfInfo(pdfPath);
      row.pdf_size_bytes = info.pdf_size_bytes;
      row.page_count = info.page_count;
      if (artifactDir) {
        const out = saveArtifacts({
          artifactDir,
          doc_id,
          engine,
          pdfPath,
          log,
          text: info.text,
        });
        row.log_path = out.log_path;
        row.text_path = out.text_path;
        row.pdf_path = out.pdf_path;
        row._text = info.text;
      } else {
        row._text = info.text;
      }
    } else {
      row.success = false;
      row.error_type = categorizeError({
        timedOut: r.timedOut,
        log,
        first_error_message: parsed.first_error_message,
        code: r.code,
      });
      if (r.timedOut) {
        row.first_error_message =
          row.first_error_message || `timeout after ${timeoutMs}ms`;
      }
      if (!row.first_error_message && r.code !== 0) {
        row.first_error_message = (log || '').trim().split('\n').slice(-5).join(' | ') || `exit ${r.code}`;
      }
      if (artifactDir) {
        const out = saveArtifacts({
          artifactDir,
          doc_id,
          engine,
          pdfPath: null,
          log,
          text: null,
        });
        row.log_path = out.log_path;
      }
    }
  } catch (err) {
    row.success = false;
    row.error_type = 'other';
    row.first_error_message = String(err.message || err);
  } finally {
    cleanupWorkDir(work);
  }
  return row;
}

/**
 * Persist log / text / optional PDF under artifacts/.
 */
function saveArtifacts({ artifactDir, doc_id, engine, pdfPath, log, text }) {
  const safeId = String(doc_id).replace(/[^\w.-]+/g, '__');
  const dir = join(artifactDir, safeId, engine);
  ensureDir(dir);
  const log_path = join(dir, 'compile.log');
  writeFileSync(log_path, log || '', 'utf8');
  let text_path = null;
  let pdf_out = null;
  if (text != null) {
    text_path = join(dir, 'pdftotext.txt');
    writeFileSync(text_path, text, 'utf8');
  }
  if (pdfPath && existsSync(pdfPath)) {
    // Keep PDFs only if KEEP_PDFS=1 to avoid huge disk use
    if (process.env.KEEP_PDFS === '1') {
      pdf_out = join(dir, 'output.pdf');
      writeFileSync(pdf_out, readFileSync(pdfPath));
    }
  }
  return { log_path, text_path, pdf_path: pdf_out };
}

export const LATEX_ENGINE_KEYS = Object.keys(LATEX_ENGINES);
export const MARKDOWN_BACKENDS = ['tectonic', 'typst', 'html'];

/**
 * Probe installed engine versions for the run metadata.
 */
export async function probeVersions() {
  const versions = {};
  const probes = [
    ['tectonic', LATEX_ENGINES.tectonic.bin(), ['--version']],
    ['pdflatex', LATEX_ENGINES.pdflatex.bin(), ['--version']],
    ['xelatex', LATEX_ENGINES.xelatex.bin(), ['--version']],
    ['lualatex', LATEX_ENGINES.lualatex.bin(), ['--version']],
    ['typst', TYPST.bin(), ['--version']],
    ['pandoc', PANDOC_BIN(), ['--version']],
    ['pdftotext', resolveBin(['/opt/homebrew/bin/pdftotext', 'pdftotext']), ['-v']],
    ['pdfinfo', resolveBin(['/opt/homebrew/bin/pdfinfo', 'pdfinfo']), ['-v']],
  ];
  for (const [name, bin, args] of probes) {
    try {
      const r = await runCmdTimed(bin, args, { timeoutMs: 5000 });
      const out = ((r.stdout || '') + '\n' + (r.stderr || '')).trim();
      versions[name] = out.split('\n')[0].slice(0, 200);
    } catch (e) {
      versions[name] = `error: ${e.message}`;
    }
  }
  versions.chrome = CHROME_BIN();
  versions.node = process.version;
  versions.platform = `${process.platform} ${process.arch}`;
  return versions;
}

/**
 * Strip internal fields before writing JSONL.
 */
export function publicRow(row) {
  const {
    doc_id,
    engine,
    success,
    wall_time_ms,
    cpu_time_ms,
    peak_rss_kb,
    cold_wall_time_ms,
    warm_wall_time_ms,
    pdf_sha256,
    deterministic,
    pdf_size_bytes,
    page_count,
    error_count,
    warning_count,
    error_type,
    first_error_message,
    first_error_line,
    timeout,
  } = row;
  return {
    doc_id,
    engine,
    success,
    wall_time_ms,
    cpu_time_ms,
    peak_rss_kb: peak_rss_kb ?? null,
    cold_wall_time_ms: cold_wall_time_ms ?? null,
    warm_wall_time_ms: warm_wall_time_ms ?? null,
    pdf_sha256: pdf_sha256 ?? null,
    deterministic: deterministic ?? null,
    pdf_size_bytes,
    page_count,
    error_count,
    warning_count,
    error_type,
    first_error_message,
    first_error_line,
    timeout,
  };
}
