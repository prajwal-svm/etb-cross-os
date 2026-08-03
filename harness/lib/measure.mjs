/**
 * Timing, PDF info extraction, text extraction, error parsing.
 * License: MIT
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  rmSync,
  statSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { basename, dirname, extname, join, resolve, delimiter } from 'node:path';
import { createHash } from 'node:crypto';

export const COMPILE_TIMEOUT_MS = 60_000;

const HOME = process.env.HOME || process.env.USERPROFILE || homedir() || '';

export const ENV_PATH = [
  join(HOME, '.local', 'bin'),
  join(HOME, '.cargo', 'bin'),
  '/Library/TeX/texbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  // Windows MiKTeX / TeX Live common locations
  'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
  'C:\\Program Files\\MiKTeX\\miktex\\bin',
  'C:\\texlive\\2025\\bin\\windows',
  'C:\\texlive\\2024\\bin\\windows',
  process.env.PATH || '',
].join(delimiter);

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string,string> }} [opts]
 */
/**
 * Kill a spawned process and its descendants.
 *
 * Root cause of the GHA macOS hang: a plain child.kill('SIGKILL') does NOT kill
 * grandchildren (xetex/fontspec/tectonic workers). Missing CJK fonts (STHeiti,
 * STFangsong, ctex mac fontset) left engines alive for ~80–100 minutes per
 * compile even after the 60s "timeout" flag was set — until someone cancelled
 * the job. Ubuntu/Windows were fine because those font paths fail fast or
 * MiKTeX aborts quickly.
 *
 * Fix: new process group on Unix + process-group SIGKILL; taskkill /T on
 * Windows; hard deadline that resolves the Promise even if close never fires.
 */
function killProcessTree(child) {
  if (!child || child.killed) {
    /* still try group kill below */
  }
  const pid = child?.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // Unix: kill the whole process group (requires detached: true at spawn)
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* not a group leader or already dead */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  // Last resort: pkill children by parent pid (macOS / Linux)
  try {
    spawn('pkill', ['-9', '-P', String(pid)], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

export function runCmd(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? COMPILE_TIMEOUT_MS;
  const hardGraceMs = opts.hardGraceMs ?? 3_000;
  const cwd = opts.cwd || process.cwd();
  // Non-interactive TeX / fontconfig: never block on a TTY prompt in CI
  const env = {
    ...process.env,
    PATH: ENV_PATH,
    CI: process.env.CI || '1',
    NONINTERACTIVE: '1',
    // kpathsea / tlmgr style
    TEXLIVE_INSTALL_ENV_NOCHECK: '1',
    // Avoid fontconfig cache rebuild storms where possible
    FC_DEBUG: '0',
    ...(opts.env || {}),
  };

  return new Promise((resolvePromise) => {
    const start = process.hrtime.bigint();
    const cpuStart = process.cpuUsage();
    // detached → new process group on Unix so we can SIGKILL the whole tree
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    let timer = null;
    let hardTimer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      const end = process.hrtime.bigint();
      const wall_time_ms = Number(end - start) / 1e6;
      const cpuDelta = process.cpuUsage(cpuStart);
      resolvePromise({
        ...payload,
        wall_time_ms,
        cpu_time_ms: null,
        parent_cpu_user_us: cpuDelta.user,
        parent_cpu_system_us: cpuDelta.system,
      });
    };

    timer = setTimeout(() => {
      killed = true;
      killProcessTree(child);
      // Never block the harness waiting for a stuck close event.
      hardTimer = setTimeout(() => {
        finish({
          code: 124,
          stdout,
          stderr:
            (stderr || '') +
            `\n[etb-harness] hard timeout after ${timeoutMs + hardGraceMs}ms (process tree kill)`,
          timedOut: true,
          error: `hard timeout after ${timeoutMs + hardGraceMs}ms`,
        });
      }, hardGraceMs);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    child.on('error', (err) => {
      finish({
        code: -1,
        stdout,
        stderr: String(err.message || err),
        timedOut: false,
        error: String(err.message || err),
      });
    });
    child.on('close', (code) => {
      finish({
        code: killed ? 124 : code ?? 1,
        stdout,
        stderr,
        timedOut: killed,
        error: null,
      });
    });
  });
}

/**
 * Detect best /usr/bin/time flags for CPU + peak RSS.
 * macOS: time -l  (max RSS in bytes)
 * Linux: time -v  (max RSS in kbytes) — GNU time; prefer gtime if present
 * Fallback: time -p (CPU only)
 */
export function timeWrapperArgs() {
  for (const p of [
    '/opt/homebrew/bin/gtime',
    '/usr/local/bin/gtime',
  ]) {
    if (existsSync(p)) return { bin: p, args: ['-v'], flavor: 'gnu' };
  }
  const timeBin = existsSync('/usr/bin/time') ? '/usr/bin/time' : null;
  if (!timeBin) return null;
  if (process.platform === 'darwin') {
    return { bin: timeBin, args: ['-l'], flavor: 'bsd' };
  }
  // Linux: GNU time is often /usr/bin/time
  return { bin: timeBin, args: ['-v'], flavor: 'gnu' };
}

/**
 * Parse peak RSS (KB) and CPU from time(1) output.
 */
export function parseTimeResourceOutput(text, flavor) {
  const combined = String(text || '');
  let peak_rss_kb = null;
  let cpu_time_ms = null;

  // POSIX -p style (may appear alongside)
  const userM = combined.match(/(?:^|\n)\s*user\s+([\d.]+)/);
  const sysM = combined.match(/(?:^|\n)\s*sys\s+([\d.]+)/);
  if (userM || sysM) {
    const user = userM ? parseFloat(userM[1]) : 0;
    const sys = sysM ? parseFloat(sysM[1]) : 0;
    cpu_time_ms = (user + sys) * 1000;
  }
  // GNU -v
  const gnuCpu = combined.match(/User time \(seconds\):\s*([\d.]+)/);
  const gnuSys = combined.match(/System time \(seconds\):\s*([\d.]+)/);
  if (gnuCpu || gnuSys) {
    const user = gnuCpu ? parseFloat(gnuCpu[1]) : 0;
    const sys = gnuSys ? parseFloat(gnuSys[1]) : 0;
    cpu_time_ms = (user + sys) * 1000;
  }
  const gnuRss = combined.match(
    /Maximum resident set size \(kbytes\):\s*(\d+)/i,
  );
  if (gnuRss) peak_rss_kb = parseInt(gnuRss[1], 10);

  // BSD -l (macOS): "X  maximum resident set size" in bytes
  const bsdRss = combined.match(/(\d+)\s+maximum resident set size/i);
  if (bsdRss && peak_rss_kb == null) {
    peak_rss_kb = Math.round(parseInt(bsdRss[1], 10) / 1024);
  }

  return { peak_rss_kb, cpu_time_ms, flavor };
}

/**
 * Run with /usr/bin/time capturing CPU + peak RSS when available.
 * Falls back to plain runCmd.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string,string> }} [opts]
 */
export async function runCmdTimed(cmd, args, opts = {}) {
  const wrap = timeWrapperArgs();
  if (!wrap) {
    return runCmd(cmd, args, opts);
  }
  // Prefer -p as well for portable CPU when using bsd -l (macOS -l includes CPU in different form)
  const timeArgs =
    wrap.flavor === 'bsd'
      ? [...wrap.args, cmd, ...args]
      : [...wrap.args, cmd, ...args];
  const result = await runCmd(wrap.bin, timeArgs, opts);
  const combined = `${result.stderr}\n${result.stdout}`;
  const res = parseTimeResourceOutput(combined, wrap.flavor);
  if (res.cpu_time_ms != null) result.cpu_time_ms = res.cpu_time_ms;
  if (res.peak_rss_kb != null) result.peak_rss_kb = res.peak_rss_kb;

  // Also try -p parse if missing cpu
  if (result.cpu_time_ms == null) {
    const userM = combined.match(/(?:^|\n)user\s+([\d.]+)/);
    const sysM = combined.match(/(?:^|\n)sys\s+([\d.]+)/);
    if (userM || sysM) {
      const user = userM ? parseFloat(userM[1]) : 0;
      const sys = sysM ? parseFloat(sysM[1]) : 0;
      result.cpu_time_ms = (user + sys) * 1000;
    }
  }

  // Strip noisy time(1) footer for cleaner logs (best-effort)
  result.stderr = (result.stderr || '')
    .replace(/(?:^|\n)real\s+[\d.]+\s*/g, '\n')
    .replace(/(?:^|\n)user\s+[\d.]+\s*/g, '\n')
    .replace(/(?:^|\n)sys\s+[\d.]+\s*/g, '\n')
    .replace(/\d+\s+maximum resident set size[^\n]*/gi, '')
    .replace(/Maximum resident set size[^\n]*/gi, '')
    .replace(/User time \(seconds\):[^\n]*/g, '')
    .replace(/System time \(seconds\):[^\n]*/g, '')
    .trim();
  return result;
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function writeJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function appendJsonl(path, obj) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(obj) + '\n', { flag: 'a' });
}

/**
 * Copy a document directory into a fresh temp workdir.
 * Skips SOURCE.json / manifest.json / record.json meta files.
 * @param {string} srcDir absolute path of document directory
 * @param {string} [prefix]
 */
export function prepWorkDir(srcDir, prefix = 'etb-') {
  const work = mkdtempSync(join(tmpdir(), prefix));
  if (!existsSync(srcDir)) {
    throw new Error(`source dir missing: ${srcDir}`);
  }
  // Recursive copy so nested assets (images, subdirs) are preserved
  for (const name of readdirSync(srcDir)) {
    if (
      name === 'SOURCE.json' ||
      name === 'manifest.json' ||
      name === 'record.json'
    ) {
      continue;
    }
    const src = join(srcDir, name);
    const dest = join(work, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      cpSync(src, dest, { recursive: true });
    } else if (st.isFile()) {
      copyFileSync(src, dest);
    }
  }
  return work;
}

export function cleanupWorkDir(work) {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Find PDF produced in workdir for a main file stem.
 * @param {string} workDir
 * @param {string} mainFile basename e.g. main.tex
 */
export function findPdf(workDir, mainFile) {
  const stem = basename(mainFile).replace(/\.(tex|typ|md|markdown)$/i, '');
  const candidates = [
    join(workDir, `${stem}.pdf`),
    join(workDir, 'output.pdf'),
    join(workDir, 'main.pdf'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).size > 0) return c;
  }
  try {
    const pdfs = readdirSync(workDir)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .map((f) => join(workDir, f))
      .filter((p) => {
        try {
          return statSync(p).size > 0;
        } catch {
          return false;
        }
      });
    if (pdfs.length === 1) return pdfs[0];
    if (pdfs.length > 1) {
      // Prefer stem match
      const prefer = pdfs.find((p) => basename(p).startsWith(stem));
      return prefer || pdfs[0];
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * @param {string} pdfPath
 * @returns {Promise<{ page_count: number|null, pdf_size_bytes: number|null, text: string|null, pdfinfo_raw: string }>}
 */
export async function extractPdfInfo(pdfPath) {
  let pdf_size_bytes = null;
  let page_count = null;
  let text = null;
  let pdfinfo_raw = '';

  try {
    pdf_size_bytes = statSync(pdfPath).size;
  } catch {
    return { page_count: null, pdf_size_bytes: null, text: null, pdfinfo_raw: '' };
  }

  const info = await runCmd('pdfinfo', [pdfPath], { timeoutMs: 15_000 });
  pdfinfo_raw = (info.stdout || '') + (info.stderr || '');
  const m = pdfinfo_raw.match(/^Pages:\s+(\d+)/m);
  if (m) page_count = parseInt(m[1], 10);

  const txt = await runCmd('pdftotext', ['-q', pdfPath, '-'], {
    timeoutMs: 30_000,
  });
  if (txt.code === 0) {
    text = (txt.stdout || '').trim();
  }

  return { page_count, pdf_size_bytes, text, pdfinfo_raw };
}

/**
 * Parse LaTeX / Typst / pandoc compile logs for errors and warnings.
 * @param {string} log
 */
export function parseCompileLog(log) {
  const text = String(log || '');
  const lines = text.split(/\r?\n/);
  const errors = [];
  const warnings = [];
  let first_error_message = null;
  let first_error_line = null;

  const latexErrorRe =
    /^(!\s*.+)|^l\.(\d+)\s|^! LaTeX Error:|^! Package .+ Error|^! Undefined control sequence|^! Emergency stop|^! File .+ not found|^! I can't find file|^! Font .+ not loadable|^! pdfTeX error|^! Package fontspec Error|^! Critical Package|^error:|^Error:|fatal error|Fatal error|ERROR:/i;
  const latexWarningRe =
    /^(LaTeX Warning:|Package .+ Warning:|Class .+ Warning:|Warning--|warning:|Underfull \\|Overfull \\)/i;
  const typstErrorRe = /^(error:|\/\/ Error:)/i;
  const missingPkgRe =
    /File [`']?([^`'\s]+\.(sty|cls|tex|fd|def))[`']? not found|package ['"]?([^'"\s]+)['"]? (was )?not found|not found in path|cannot find package|unknown package|Failed to download|could not be found|I can't find file [`']?([^`'\s]+)/i;
  const fontRe =
    /font|Font|fontspec|Cannot find.*font|font family|not loadable|otf|ttf/i;
  const syntaxRe =
    /Undefined control sequence|Missing \$|Extra \}|Misplaced|Runaway argument|Illegal|Syntax|unexpected|expected|parse error|unclosed/i;
  const memoryRe =
    /out of memory|memory capacity exceeded|TeX capacity exceeded|Fatal workspace overflow|Cannot allocate/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // LaTeX classic: "! message" then "l.N "
    if (/^! /.test(line) || /^!/.test(line) && line.length > 2) {
      errors.push(line);
      if (!first_error_message) {
        first_error_message = line.replace(/^!\s*/, '').trim();
        // look ahead for l.N
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const lm = lines[j].match(/^l\.(\d+)/);
          if (lm) {
            first_error_line = parseInt(lm[1], 10);
            break;
          }
        }
      }
      continue;
    }

    if (typstErrorRe.test(line) || /^error\[/i.test(line)) {
      errors.push(line);
      if (!first_error_message) {
        first_error_message = line.trim();
        const lm = line.match(/:(\d+):(\d+)/) || text.match(/--> [^\n]+:(\d+):(\d+)/);
        if (lm) first_error_line = parseInt(lm[1], 10);
      }
      continue;
    }

    if (/^Error:|^ERROR:|fatal:|FATAL/i.test(line) && !/Warning/i.test(line)) {
      errors.push(line);
      if (!first_error_message) first_error_message = line.trim();
      continue;
    }

    if (latexWarningRe.test(line) || /\bwarning\b/i.test(line)) {
      warnings.push(line);
    }
  }

  // Fallback line scan if no classic errors found but exit failed
  if (!first_error_message) {
    for (const line of lines) {
      if (latexErrorRe.test(line)) {
        first_error_message = line.trim();
        const lm = line.match(/l\.(\d+)/) || line.match(/:(\d+):\d+/);
        if (lm) first_error_line = parseInt(lm[1], 10);
        if (!errors.includes(line)) errors.push(line);
        break;
      }
    }
  }

  return {
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.slice(0, 50),
    warnings: warnings.slice(0, 50),
    first_error_message,
    first_error_line,
  };
}

/**
 * Categorize a failed compilation.
 * @param {{ timedOut?: boolean, log?: string, first_error_message?: string|null, code?: number }} info
 * @returns {'timeout'|'missing_package'|'font_error'|'syntax_error'|'memory'|'other'|null}
 */
export function categorizeError(info) {
  if (!info) return null;
  if (info.timedOut) return 'timeout';
  const msg = `${info.first_error_message || ''}\n${info.log || ''}`;
  if (/out of memory|memory capacity exceeded|TeX capacity exceeded|Cannot allocate|Fatal workspace overflow/i.test(msg)) {
    return 'memory';
  }
  if (
    /File [`']?[^`'\s]+\.(sty|cls)[`']? not found|not found in path|cannot find package|unknown package|Failed to download|I can't find file|package .+ not found|Unable to find package|no such package/i.test(
      msg,
    )
  ) {
    return 'missing_package';
  }
  if (
    /fontspec|Font .+ not loadable|Cannot find.*[Ff]ont|font family ['"]|Unknown font|font not found|otfinfo|setmainfont|setsansfont/i.test(
      msg,
    )
  ) {
    return 'font_error';
  }
  if (
    /Undefined control sequence|Missing \$|Extra \}|Misplaced|Runaway argument|Illegal parameter|Syntax error|unexpected|parse error|unclosed|Emergency stop|Too many }'s|Paragraph ended before/i.test(
      msg,
    )
  ) {
    return 'syntax_error';
  }
  return 'other';
}

/**
 * Build a standard result row.
 */
export function emptyResult(doc_id, engine) {
  return {
    doc_id,
    engine,
    success: false,
    wall_time_ms: null,
    cpu_time_ms: null,
    peak_rss_kb: null,
    cold_wall_time_ms: null,
    warm_wall_time_ms: null,
    pdf_sha256: null,
    deterministic: null,
    pdf_size_bytes: null,
    page_count: null,
    error_count: 0,
    warning_count: 0,
    error_type: null,
    first_error_message: null,
    first_error_line: null,
    timeout: false,
    text_path: null,
    log_path: null,
    pdf_path: null,
  };
}

/**
 * Resolve a binary from candidate list.
 * @param {string[]} candidates
 */
export function resolveBin(candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const looksPath =
      c.includes('/') ||
      c.includes('\\') ||
      c.startsWith('~') ||
      /^[A-Za-z]:[\\/]/.test(c);
    if (looksPath) {
      const expanded = c.startsWith('~')
        ? c.replace('~', process.env.HOME || process.env.USERPROFILE || '')
        : c;
      if (existsSync(expanded)) return expanded;
    } else {
      for (const dir of ENV_PATH.split(delimiter)) {
        if (!dir) continue;
        const p = join(dir, c);
        if (existsSync(p)) return p;
      }
    }
  }
  return candidates[candidates.length - 1] || null;
}

export function nowIso() {
  return new Date().toISOString();
}
