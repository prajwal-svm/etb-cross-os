/**
 * Multi-file LaTeX include-graph features for ETB-Porta.
 * Parses \input, \include, \subfile, \includegraphics, \bibliography, etc.
 *
 * License: MIT
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join, normalize, relative } from 'node:path';

const INCLUDE_RE =
  /\\(?:input|include|subfile|subfileinclude)\*?\{([^}]+)\}/g;
const GRAPHICS_RE =
  /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
const BIB_RE = /\\(?:bibliography|addbibresource)\*?\{([^}]+)\}/g;
const USEPKG_RE = /\\usepackage(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g;
const DOCUMENTCLASS_RE =
  /\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/;

/**
 * Resolve a LaTeX path relative to a base directory, trying common extensions.
 */
export function resolveTexPath(baseDir, raw, kind = 'tex') {
  let p = String(raw || '').trim().replace(/^"|"$/g, '');
  if (!p) return null;
  // strip extension for input-like; keep for graphics
  const candidates = [];
  if (kind === 'tex') {
    const noExt = p.replace(/\.(tex|ltx)$/i, '');
    candidates.push(
      join(baseDir, p),
      join(baseDir, `${noExt}.tex`),
      join(baseDir, noExt),
      join(baseDir, `${p}.tex`),
    );
  } else if (kind === 'bib') {
    candidates.push(
      join(baseDir, p),
      join(baseDir, p.endsWith('.bib') ? p : `${p}.bib`),
    );
  } else {
    candidates.push(join(baseDir, p));
    for (const ext of ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg']) {
      if (!p.toLowerCase().endsWith(ext)) candidates.push(join(baseDir, p + ext));
    }
  }
  for (const c of candidates) {
    const n = normalize(c);
    if (existsSync(n) && statSync(n).isFile()) return n;
  }
  return null; // missing edge target
}

/**
 * Build include graph starting from mainFile.
 * @returns {{
 *   nodes: string[],
 *   edges: {from:string,to:string,kind:string}[],
 *   missing: {from:string,raw:string,kind:string}[],
 *   depth: number,
 *   n_tex: number,
 *   n_graphics: number,
 *   n_bib: number,
 *   n_missing: number,
 *   max_depth: number,
 *   has_nested_aux_risk: number,
 *   features: Record<string, number>
 * }}
 */
export function buildIncludeGraph(mainFile, opts = {}) {
  const maxFiles = opts.maxFiles ?? 80;
  const mainAbs = normalize(mainFile);
  const rootDir = dirname(mainAbs);
  const visited = new Set();
  const edges = [];
  const missing = [];
  const queue = [{ file: mainAbs, depth: 0 }];
  let maxDepth = 0;
  let nGraphics = 0;
  let nBib = 0;
  let nTex = 0;

  while (queue.length && visited.size < maxFiles) {
    const { file, depth } = queue.shift();
    if (visited.has(file)) continue;
    if (!existsSync(file)) continue;
    visited.add(file);
    maxDepth = Math.max(maxDepth, depth);
    nTex++;

    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const base = dirname(file);

    // includes
    INCLUDE_RE.lastIndex = 0;
    let m;
    while ((m = INCLUDE_RE.exec(text))) {
      const raw = m[1].split(',').map((s) => s.trim());
      for (const r of raw) {
        const resolved = resolveTexPath(base, r, 'tex');
        if (resolved) {
          edges.push({ from: file, to: resolved, kind: 'input' });
          if (!visited.has(resolved)) queue.push({ file: resolved, depth: depth + 1 });
        } else {
          missing.push({ from: file, raw: r, kind: 'input' });
        }
      }
    }

    // graphics
    GRAPHICS_RE.lastIndex = 0;
    while ((m = GRAPHICS_RE.exec(text))) {
      nGraphics++;
      const resolved = resolveTexPath(base, m[1], 'graphics');
      if (resolved) edges.push({ from: file, to: resolved, kind: 'graphics' });
      else missing.push({ from: file, raw: m[1], kind: 'graphics' });
    }

    // bib
    BIB_RE.lastIndex = 0;
    while ((m = BIB_RE.exec(text))) {
      for (const r of m[1].split(',').map((s) => s.trim())) {
        nBib++;
        const resolved = resolveTexPath(base, r, 'bib');
        if (resolved) edges.push({ from: file, to: resolved, kind: 'bib' });
        else missing.push({ from: file, raw: r, kind: 'bib' });
      }
    }
  }

  // Nested aux risk: inputs that live in subdirectories (chapters/foo.tex)
  let nested = 0;
  for (const e of edges) {
    if (e.kind !== 'input') continue;
    const rel = relative(rootDir, e.to);
    if (rel.includes('/') || rel.includes('\\')) nested++;
  }

  const features = {
    graph_n_tex: nTex,
    graph_n_edges: edges.length,
    graph_n_graphics: nGraphics,
    graph_n_bib: nBib,
    graph_n_missing: missing.length,
    graph_max_depth: maxDepth,
    graph_nested_inputs: nested,
    graph_multifile: nTex > 1 ? 1 : 0,
    graph_has_missing: missing.length > 0 ? 1 : 0,
    graph_log_tex: Math.log1p(nTex),
    graph_log_missing: Math.log1p(missing.length),
  };

  return {
    root: mainAbs,
    nodes: [...visited],
    edges,
    missing,
    depth: maxDepth,
    n_tex: nTex,
    n_graphics: nGraphics,
    n_bib: nBib,
    n_missing: missing.length,
    max_depth: maxDepth,
    has_nested_aux_risk: nested > 0 ? 1 : 0,
    features,
  };
}

/**
 * Detect main .tex in a directory (prefer main.tex, else largest, else first).
 */
export function findMainTex(dirOrFile) {
  if (existsSync(dirOrFile) && statSync(dirOrFile).isFile()) {
    return normalize(dirOrFile);
  }
  const dir = dirOrFile;
  const names = readdirSync(dir).filter((n) => /\.tex$/i.test(n));
  if (!names.length) return null;
  if (names.includes('main.tex')) return join(dir, 'main.tex');
  // prefer file with \documentclass
  const scored = names.map((n) => {
    const p = join(dir, n);
    let score = statSync(p).size;
    try {
      const t = readFileSync(p, 'utf8');
      if (DOCUMENTCLASS_RE.test(t)) score += 1e9;
      if (/\\begin\{document\}/.test(t)) score += 1e8;
    } catch {
      /* ignore */
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].p;
}

/**
 * Scan directory for package-like hints without catalog.
 */
export function scanPackagesFromSource(text) {
  const pkgs = new Set();
  USEPKG_RE.lastIndex = 0;
  let m;
  while ((m = USEPKG_RE.exec(text))) {
    for (const p of m[1].split(',')) pkgs.add(p.trim().toLowerCase());
  }
  const cls = text.match(DOCUMENTCLASS_RE);
  return {
    uses_packages: [...pkgs],
    document_class: cls ? cls[1] : '',
  };
}
