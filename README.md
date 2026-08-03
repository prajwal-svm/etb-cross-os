# ETB Cross-OS Compilation Campaign

Public harness for **Engine-Transfer-Bench** multi-platform validation.

| Host | Status |
| --- | --- |
| macOS arm64 | Collected in private paper repo |
| **ubuntu-latest** | GitHub Actions (this repo) |
| **windows-latest** | GitHub Actions (this repo) |
| **macos-latest** (GHA) | GitHub Actions audit run (compare to local) |

## What this measures

**Success rates only** (not wall-clock timing) for:

- Tectonic, pdfLaTeX, XeLaTeX, LuaLaTeX on 809 LaTeX seeds  
- Typst on 975 Typst seeds  

Markdown backends are skipped in CI (secondary for cross-OS).

## Layout

```
catalog.json          # 1,784 docs; file_path → seeds/...
seeds/                # processed .tex / .typ trees
harness/compile-all.mjs
.github/workflows/cross-os.yml
```

## Local smoke

```bash
# needs: node 20+, tectonic, texlive engines, typst (optional)
node harness/compile-all.mjs \
  --catalog-path catalog.json \
  --host local-smoke \
  --skip-markdown \
  --limit 5
```

## CI

Actions → **Cross-OS Compilation** → **Run workflow**  
Optional `limit` input: `5` for smoke, `0` for full corpus.

`target_os`: `all` | `ubuntu` | `windows` | `macos` | `both` (ubuntu+windows).

Artifacts: `etb-results-ubuntu-x64` and `etb-results-windows-x64` JSONL files.

## Merge with macOS

```bash
# in engine-transfer-bench after downloading artifacts
cp etb-results-ubuntu-x64/per-engine-results-ubuntu-x64.jsonl results/by-host/
cp etb-results-windows-x64/per-engine-results-windows-x64.jsonl results/by-host/
node harness/merge-cross-os-comparison.mjs
```

## Notes

- **MiKTeX on Windows** auto-installs packages → may show higher success than Ubuntu apt TeX Live. That is a finding.
- Do **not** compare absolute timings across platforms (different VMs/hardware).
- Manual `workflow_dispatch` only (avoids burning CI on every push).

## License

MIT harness. Seed documents retain their original open licenses (see per-directory `SOURCE.json` where present).

## Citation

Part of Engine-Transfer-Bench (Paper 2). See Oleafly research notes.
