/**
 * Live portability gate: compile under required engines + optional Spdf matrix.
 * License: MIT
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  COMPILE_TIMEOUT_MS,
  ENV_PATH,
  runCmdTimed,
  findPdf,
  extractPdfInfo,
  resolveBin,
  ensureDir,
} from './measure.mjs';
import { pdfTextSimilarity } from './similarity.mjs';
import { portabilityGate } from './etb-companion.mjs';

const ENGINE_BINS = {
  tectonic: () =>
    resolveBin([
      process.env.TECTONIC_PATH,
      `${process.env.HOME}/.local/bin/tectonic`,
      '/opt/homebrew/bin/tectonic',
      'tectonic',
    ]),
  pdflatex: () => resolveBin(['/Library/TeX/texbin/pdflatex', 'pdflatex']),
  xelatex: () => resolveBin(['/Library/TeX/texbin/xelatex', 'xelatex']),
  lualatex: () => resolveBin(['/Library/TeX/texbin/lualatex', 'lualatex']),
};

function engineArgs(engine, mainBase) {
  if (engine === 'tectonic') {
    return ['-X', 'compile', mainBase, '--keep-logs', '--keep-intermediates'];
  }
  return [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-no-shell-escape',
    mainBase,
  ];
}

function copyProjectToTemp(srcDir) {
  const work = mkdtempSync(join(tmpdir(), 'etb-gate-'));
  // Copy all files (skip huge .git if any)
  for (const name of readdirSync(srcDir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const s = join(srcDir, name);
    const d = join(work, name);
    const st = statSync(s);
    if (st.isDirectory()) cpSync(s, d, { recursive: true });
    else if (st.isFile()) cpSync(s, d);
  }
  return work;
}

/**
 * Compile one engine in an isolated copy of the project.
 */
export async function compileOnce(engine, projectDir, mainFile, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? COMPILE_TIMEOUT_MS;
  const work = copyProjectToTemp(projectDir);
  const mainBase = basename(mainFile);
  const bin = ENGINE_BINS[engine]?.();
  if (!bin) {
    rmSync(work, { recursive: true, force: true });
    return {
      engine,
      success: false,
      error: `unknown or missing engine binary: ${engine}`,
      wall_time_ms: null,
      text: null,
      pdf_path: null,
    };
  }

  const passes = engine === 'tectonic' ? 1 : 2;
  let total = 0;
  let lastCode = 1;
  let log = '';
  let timedOut = false;
  const deadline = Date.now() + timeoutMs;

  try {
    for (let p = 1; p <= passes; p++) {
      const remaining = Math.max(1000, deadline - Date.now());
      const r = await runCmdTimed(bin, engineArgs(engine, mainBase), {
        cwd: work,
        timeoutMs: remaining,
        env: { PATH: ENV_PATH },
      });
      total += r.wall_time_ms || 0;
      log += (r.stdout || '') + '\n' + (r.stderr || '') + '\n';
      lastCode = r.code;
      if (r.timedOut) {
        timedOut = true;
        break;
      }
      if (r.code !== 0) break;
    }

    const pdf = findPdf(work, mainBase);
    if (pdf && lastCode === 0 && !timedOut) {
      const info = await extractPdfInfo(pdf);
      // Persist PDF text; optionally keep PDF under outDir
      let keptPdf = null;
      if (opts.keepDir) {
        ensureDir(opts.keepDir);
        keptPdf = join(opts.keepDir, `${engine}.pdf`);
        writeFileSync(keptPdf, readFileSync(pdf));
        if (info.text != null) {
          writeFileSync(join(opts.keepDir, `${engine}.txt`), info.text, 'utf8');
        }
      }
      return {
        engine,
        success: true,
        wall_time_ms: total,
        text: info.text,
        page_count: info.page_count,
        pdf_size_bytes: info.pdf_size_bytes,
        pdf_path: keptPdf,
        timedOut: false,
      };
    }
    return {
      engine,
      success: false,
      wall_time_ms: total,
      text: null,
      error: timedOut ? 'timeout' : `exit ${lastCode}`,
      log_tail: log.slice(-2000),
      timedOut,
    };
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Live multi-engine gate with Spdf matrix among successful engines.
 *
 * @param {{
 *   mainFile: string,
 *   engines: string[],
 *   spdf_threshold?: number,
 *   require_spdf?: boolean,
 *   timeoutMs?: number,
 *   keepDir?: string|null,
 * }} opts
 */
export async function runLiveGate(opts) {
  const mainFile = resolve(opts.mainFile);
  const projectDir = dirname(mainFile);
  const engines = opts.engines || ['tectonic', 'pdflatex'];
  const spdf_threshold = opts.spdf_threshold ?? 0.95;
  const require_spdf = opts.require_spdf !== false && engines.length >= 2;
  const keepDir = opts.keepDir || null;
  if (keepDir) mkdirSync(keepDir, { recursive: true });

  const results = {};
  const texts = {};
  for (const eng of engines) {
    const r = await compileOnce(eng, projectDir, mainFile, {
      timeoutMs: opts.timeoutMs,
      keepDir,
    });
    results[eng] = r;
    if (r.success && r.text != null) texts[eng] = r.text;
  }

  const outcomes = {};
  for (const eng of engines) outcomes[eng] = Boolean(results[eng]?.success);

  // Pairwise Spdf among successful engines
  const successEngines = engines.filter((e) => outcomes[e] && texts[e] != null);
  /** @type {Record<string, number>} */
  const pairwise = {};
  let min_spdf = null;
  for (let i = 0; i < successEngines.length; i++) {
    for (let j = i + 1; j < successEngines.length; j++) {
      const a = successEngines[i];
      const b = successEngines[j];
      const sim = pdfTextSimilarity(texts[a], texts[b]);
      pairwise[`${a}__${b}`] = sim.score;
      if (min_spdf == null || sim.score < min_spdf) min_spdf = sim.score;
    }
  }

  const gate = portabilityGate({
    required_engines: engines,
    outcomes,
    min_spdf: require_spdf && successEngines.length >= 2 ? min_spdf : null,
    spdf_threshold,
  });

  // If require_spdf but fewer than 2 successes, compile already failed
  if (require_spdf && successEngines.length < 2 && gate.compile_ok === false) {
    // already failed compile
  } else if (require_spdf && successEngines.length < 2 && Object.values(outcomes).every(Boolean) === false) {
    // no-op
  }

  return {
    mainFile,
    engines,
    results,
    outcomes,
    pairwise_spdf: pairwise,
    min_spdf,
    spdf_threshold,
    require_spdf,
    gate,
    platform: `${process.platform}-${process.arch}`,
    timestamp: new Date().toISOString(),
  };
}
