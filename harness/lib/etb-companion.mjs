/**
 * ETB-Porta companion system: static engine recommender + portability gate.
 * Features from catalog/source signals + multi-file include graph.
 * Evaluated against ETB per-engine outcomes.
 *
 * License: MIT
 */

import { buildIncludeGraph } from './include-graph.mjs';

/** Packages / classes that strongly imply non-pdfLaTeX font stacks. */
export const FONT_STACK_RE =
  /fontspec|unicode-math|mathspec|polyglossia|xecjk|xelatex|lualatex|fontawesome5|academicons|libertinus|sourcesans|sourceserif|noto|fira|roboto|montserrat|helvet|tgheros|fontawesome|awesomebox/i;

export const CJK_RE = /ctex|xeCJK|luatexja|zhnumber|CJKutf8|xeCJK|bxjs/i;

/**
 * Extract static features from a catalog document (+ optional source text).
 * @param {object} doc catalog entry
 * @param {string} [sourceText]
 * @param {{ mainFile?: string, graph?: object }} [opts]
 */
export function extractFeatures(doc, sourceText = '', opts = {}) {
  const pkgs = (doc.uses_packages || []).map((p) => String(p).toLowerCase());
  const pkgStr = pkgs.join(' ');
  const cls = String(doc.document_class || '').toLowerCase();
  const cat = String(doc.category || 'misc').toLowerCase();
  const src = String(doc.source || 'unknown').toLowerCase();
  const text = `${sourceText}\n${pkgStr}\n${cls}`.toLowerCase();

  const hasFontStack =
    FONT_STACK_RE.test(pkgStr) ||
    FONT_STACK_RE.test(text) ||
    /\\setmainfont|\\setsansfont|\\setmonofont|\\fontspec/.test(sourceText);
  const hasCjk = CJK_RE.test(pkgStr) || CJK_RE.test(text) || /\\usepackage\{ctex\}/.test(sourceText);
  const hasTikz = /\btikz\b|pgfplots|circuitikz|pgf\b/.test(pkgStr);
  const hasBeamer = cls.includes('beamer') || cat === 'beamer' || /beamer/.test(pkgStr);
  const isThesis = cat === 'thesis' || /thesis|dissertation/.test(cls);
  const isLetter = cat === 'letter' || cls.includes('letter');
  const isCv = cat === 'cv' || /moderncv|resume|curriculum/.test(pkgStr + cls);
  const nPkgs = pkgs.length;
  const sizeKb = (doc.size_bytes || 0) / 1024;

  // Include-graph features
  let graph = opts.graph || null;
  if (!graph && opts.mainFile) {
    try {
      graph = buildIncludeGraph(opts.mainFile);
    } catch {
      graph = null;
    }
  }
  const gf = graph?.features || {
    graph_n_tex: 1,
    graph_n_edges: 0,
    graph_n_graphics: 0,
    graph_n_bib: 0,
    graph_n_missing: 0,
    graph_max_depth: 0,
    graph_nested_inputs: 0,
    graph_multifile: 0,
    graph_has_missing: 0,
    graph_log_tex: 0,
    graph_log_missing: 0,
  };

  return {
    doc_id: doc.id,
    hasFontStack: hasFontStack ? 1 : 0,
    hasCjk: hasCjk ? 1 : 0,
    hasTikz: hasTikz ? 1 : 0,
    hasBeamer: hasBeamer ? 1 : 0,
    isThesis: isThesis ? 1 : 0,
    isLetter: isLetter ? 1 : 0,
    isCv: isCv ? 1 : 0,
    nPkgs,
    logSize: Math.log1p(doc.size_bytes || 0),
    sizeKb,
    srcGithub: src.includes('github') ? 1 : 0,
    srcOverleaf: src === 'overleaf' ? 1 : 0,
    srcCtan: src === 'ctan' ? 1 : 0,
    srcTemplates: src.includes('template') ? 1 : 0,
    ...gf,
    category: cat,
    document_class: cls,
    packages: pkgs,
    _graph: graph,
  };
}

export const FEATURE_KEYS = [
  'hasFontStack',
  'hasCjk',
  'hasTikz',
  'hasBeamer',
  'isThesis',
  'isLetter',
  'isCv',
  'nPkgs',
  'logSize',
  'srcGithub',
  'srcOverleaf',
  'srcCtan',
  'srcTemplates',
  'graph_n_tex',
  'graph_n_graphics',
  'graph_n_missing',
  'graph_max_depth',
  'graph_nested_inputs',
  'graph_multifile',
  'graph_has_missing',
  'graph_log_tex',
];

export function featureVector(f) {
  return FEATURE_KEYS.map((k) => Number(f[k] || 0));
}

/**
 * Rule-based recommender (deterministic baseline + production default).
 * Returns ordered engines for authoring and a CI gate set.
 */
export function recommendRules(features) {
  const reasons = [];
  let primary = 'tectonic';
  let authoring = ['tectonic', 'pdflatex'];
  let ciGate = ['tectonic'];

  if (features.hasFontStack || features.hasCjk || features.isCv) {
    primary = 'tectonic';
    authoring = ['tectonic', 'xelatex', 'lualatex'];
    ciGate = ['tectonic', 'xelatex'];
    // pdfLaTeX is an acceptance gate only when venue requires it — high risk
    reasons.push('font_stack_or_cjk_or_cv');
    if (features.hasFontStack) reasons.push('fontspec_family');
    if (features.hasCjk) reasons.push('cjk');
  } else if (features.isThesis || features.graph_nested_inputs > 0 || features.graph_multifile) {
    primary = 'tectonic';
    authoring = ['tectonic', 'pdflatex', 'lualatex'];
    ciGate = ['tectonic', 'pdflatex'];
    if (features.isThesis) reasons.push('thesis_layout_risk');
    if (features.graph_nested_inputs > 0 || features.graph_multifile) {
      reasons.push('multifile_include_graph');
    }
  } else if (features.hasBeamer) {
    primary = 'pdflatex';
    authoring = ['pdflatex', 'tectonic', 'xelatex'];
    ciGate = ['pdflatex', 'tectonic'];
    reasons.push('beamer_classic');
  } else {
    primary = 'tectonic';
    authoring = ['tectonic', 'pdflatex'];
    ciGate = ['tectonic', 'pdflatex'];
    reasons.push('default_portable_lean');
  }

  // Risk scores in [0,1] (higher = more likely to fail)
  const risk = {
    pdflatex: clamp01(
      0.05 +
        0.55 * features.hasFontStack +
        0.25 * features.hasCjk +
        0.15 * features.isThesis +
        0.1 * features.isCv +
        0.05 * features.srcGithub +
        0.1 * (features.graph_nested_inputs > 0 ? 1 : 0),
    ),
    xelatex: clamp01(
      0.04 +
        0.2 * features.isThesis +
        0.1 * features.srcGithub +
        0.08 * features.hasFontStack +
        0.12 * (features.graph_nested_inputs > 0 ? 1 : 0) +
        0.08 * (features.graph_has_missing || 0),
    ),
    lualatex: clamp01(
      0.04 +
        0.2 * features.isThesis +
        0.1 * features.srcGithub +
        0.08 * features.hasFontStack +
        0.12 * (features.graph_nested_inputs > 0 ? 1 : 0) +
        0.08 * (features.graph_has_missing || 0),
    ),
    tectonic: 0.02, // empirical: 0 fails on ETB full set under construction gate
  };

  return {
    system: 'etb-porta-rules',
    primary,
    authoring,
    ci_gate: ciGate,
    require_pdf_acceptance_gate: Boolean(features.hasFontStack || features.hasCjk || features.isThesis),
    risk,
    reasons,
  };
}

/**
 * Logistic regression weights fit offline (see eval-companion.mjs).
 * Default weights are placeholders overwritten after training export.
 */
export let LOGREG_PDF_FAIL = {
  bias: -2.7,
  weights: {
    hasFontStack: 3.2,
    hasCjk: 1.4,
    hasTikz: 0.1,
    hasBeamer: -0.3,
    isThesis: 1.1,
    isLetter: 0.8,
    isCv: 0.6,
    nPkgs: 0.02,
    logSize: 0.05,
    srcGithub: 0.4,
    srcOverleaf: 0.35,
    srcCtan: -1.2,
    srcTemplates: -0.8,
  },
};

export function predictLogReg(features, model = LOGREG_PDF_FAIL) {
  let z = model.bias;
  for (const k of FEATURE_KEYS) {
    z += (model.weights[k] || 0) * Number(features[k] || 0);
  }
  const p = 1 / (1 + Math.exp(-z));
  return p;
}

/**
 * Hybrid recommender: rules + logistic risk for pdfLaTeX.
 */
export function recommendHybrid(features, model = LOGREG_PDF_FAIL) {
  const base = recommendRules(features);
  const pFailPdf = predictLogReg(features, model);
  base.system = 'etb-porta-hybrid';
  base.risk = { ...base.risk, pdflatex: clamp01(0.5 * base.risk.pdflatex + 0.5 * pFailPdf) };
  base.p_fail_pdflatex = pFailPdf;

  // High-recall bias: if model risks pdf fail, demote pdf from primary/authoring
  // and force pdf into CI for venue safety.
  if (pFailPdf >= 0.35) {
    base.primary = base.primary === 'pdflatex' ? 'tectonic' : base.primary;
    base.authoring = [
      'tectonic',
      ...base.authoring.filter((e) => e !== 'pdflatex' && e !== 'tectonic'),
    ];
    if (!base.authoring.includes('xelatex')) base.authoring.push('xelatex');
    base.require_pdf_acceptance_gate = true;
    if (!base.ci_gate.includes('pdflatex')) base.ci_gate.push('pdflatex');
    if (!base.ci_gate.includes('tectonic')) base.ci_gate.unshift('tectonic');
    base.reasons.push('logreg_pdf_fail_risk');
  }
  return base;
}

/**
 * Portability gate decision after compile outcomes (and optional Spdf matrix).
 * @param {{ required_engines: string[], outcomes: Record<string, boolean>, min_spdf?: number|null, spdf_threshold?: number }} input
 */
export function portabilityGate(input) {
  const {
    required_engines,
    outcomes,
    min_spdf = null,
    spdf_threshold = 0.95,
  } = input;
  const missing = required_engines.filter((e) => !outcomes[e]);
  const compile_ok = missing.length === 0;
  const spdf_ok =
    min_spdf == null ? true : Number.isFinite(min_spdf) && min_spdf >= spdf_threshold;
  return {
    pass: compile_ok && spdf_ok,
    compile_ok,
    spdf_ok,
    missing_engines: missing,
    min_spdf,
    spdf_threshold,
    message: !compile_ok
      ? `compile gate failed: missing success for ${missing.join(',')}`
      : !spdf_ok
        ? `text consistency gate failed: min Spdf=${min_spdf} < ${spdf_threshold}`
        : 'portability gate passed',
  };
}

/**
 * Cost model: number of CI compiles = |ci_gate|.
 * Utility: primary engine works; gate would catch true multi-engine failures.
 */
export function scoreRecommendation(rec, truth) {
  // truth: { pdflatex: bool success, xelatex, lualatex, tectonic, engine_specific }
  const primaryOk = Boolean(truth[rec.primary]);
  const anyAuthoringOk = rec.authoring.some((e) => truth[e]);
  // If we require pdf acceptance gate, "caught" means: we scheduled pdf AND pdf fails
  // (true positive catch) OR pdf succeeds (gate green)
  let acceptanceAware = true;
  if (rec.require_pdf_acceptance_gate) {
    // Venue path: authoring primary works AND (pdf scheduled in CI)
    acceptanceAware =
      primaryOk && rec.ci_gate.includes('pdflatex');
  }
  // Portability: all engines in ci_gate succeed
  const gateAllOk = rec.ci_gate.every((e) => truth[e]);
  // Waste: scheduled engines that fail (false confidence if we didn't report risk)
  const scheduledFails = rec.ci_gate.filter((e) => !truth[e]).length;

  return {
    primary_ok: primaryOk,
    any_authoring_ok: anyAuthoringOk,
    gate_all_ok: gateAllOk,
    acceptance_aware: acceptanceAware,
    ci_cost: rec.ci_gate.length,
    scheduled_fails: scheduledFails,
    // High-stakes: doc fails pdf but we didn't warn (risk.pdflatex < 0.3 and no pdf gate)
    silent_pdf_fail:
      !truth.pdflatex &&
      (rec.risk?.pdflatex ?? 0) < 0.3 &&
      !rec.ci_gate.includes('pdflatex'),
  };
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Fit logistic regression with L2 via gradient descent (binary labels 0/1).
 * Supports class weights for rare positives (e.g. pdf fail ~9%).
 */
export function fitLogReg(samples, labels, opts = {}) {
  const lr = opts.lr ?? 0.08;
  const epochs = opts.epochs ?? 400;
  const l2 = opts.l2 ?? 0.01;
  const n = samples.length;
  const d = FEATURE_KEYS.length;
  const nPos = labels.reduce((a, b) => a + b, 0);
  const nNeg = n - nPos;
  // default balanced weights
  const wPos = opts.wPos ?? (nPos ? n / (2 * nPos) : 1);
  const wNeg = opts.wNeg ?? (nNeg ? n / (2 * nNeg) : 1);
  let bias = 0;
  const w = new Array(d).fill(0);

  for (let ep = 0; ep < epochs; ep++) {
    let gb = 0;
    const gw = new Array(d).fill(0);
    let wsum = 0;
    for (let i = 0; i < n; i++) {
      const x = samples[i];
      let z = bias;
      for (let j = 0; j < d; j++) z += w[j] * x[j];
      const p = 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
      const wi = labels[i] ? wPos : wNeg;
      const err = wi * (p - labels[i]);
      wsum += wi;
      gb += err;
      for (let j = 0; j < d; j++) gw[j] += err * x[j];
    }
    bias -= (lr * gb) / wsum;
    for (let j = 0; j < d; j++) {
      w[j] -= lr * (gw[j] / wsum + l2 * w[j]);
    }
  }
  const weights = {};
  FEATURE_KEYS.forEach((k, j) => {
    weights[k] = w[j];
  });
  return { bias, weights, wPos, wNeg };
}
