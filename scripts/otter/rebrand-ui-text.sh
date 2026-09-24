#!/usr/bin/env bash
# Renames "T3 Code" to "Otter Code" in client UI text. Run by hand from the repo
# root (needs `vp` on PATH), review the diff, and commit it yourself. Nothing
# runs this automatically.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Rebrand UI text to Otter Code: web, desktop, and mobile clients plus the
# client-side packages they render from. Comment lines, identifiers
# (`@t3tools/*`, `T3CODE_*`, `t3_*` MCP tools), artwork, the CLI, and the server
# stay upstream's, and so do matchers for text the server or agents emit.
# Attribution to T3 Code lives in README.md and OTTER.md, which this never touches.
git grep -l -I -z -E 'T3|t3 ' -- \
  apps/web apps/desktop apps/mobile packages/client-runtime \
  ':!*.md' ':!*.svg' ':!*.podspec' ':!packages/client-runtime/src/errors/transport*' \
  | xargs -0 perl -pi -e '
      next if /^\s*(\/\/|\*|\/\*|#)/;
      s/T3 Nightly\b/Otter Code Nightly/g;
      s/T3([ +])(Code|Connect)\b/Otter$1$2/g;
      s/\bT3 CODE\b/OTTER CODE/g;
      s/\ba T3 thread\b/an Otter Code thread/g;
      s/\bT3 thread\b/Otter Code thread/g;
      s/\bT3 ([Aa]ccount|home|environment|[Ss]erver|process|system|operations|needs|threads)\b/Otter Code $1/g;
      s/\b(Open|Start|Restart) T3\b/$1 Otter Code/g;
      s/\b(in|through) T3(?=$|["\x27.,])/$1 Otter Code/g;
      s/(`|npx )t3 (service|connect|update|pair|app|theme|serve|uninstall|project)\b/$1otter-code $2/g;
    '
# Work-log labels for the t3-code MCP tools. Only the labels: agents still report
# the server as "T3 Code", and the tests feed that in.
perl -pi -e '
  next if /^\s*(\/\/|\*|\/\*)/;
  s/"(Create|List) T3 threads"/"$1 Otter Code threads"/g;
  s/"T3 threads"/"Otter Code threads"/g;
  s/\ba T3 thread\b/an Otter Code thread/g;
  s/\bT3 thread\b/Otter Code thread/g;
' packages/shared/src/t3McpToolPresentation.ts packages/shared/src/t3McpToolPresentation.test.ts
# Longer names can push lines past the print width.
git diff --name-only -z -- apps packages | xargs -0 vp fmt --no-error-on-unmatched-pattern >/dev/null 2>&1
