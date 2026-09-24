#!/bin/bash
# Gets a fresh container ready to build, test and run MiBlox.
#
# `dist/` is gitignored, and every package's tests import the built output
# rather than the TypeScript sources - so on a fresh clone `npm test` fails
# until a build has run. Building here means a session can run the suite,
# start the portal or drive the browser without first working that out.
set -euo pipefail

# Only for Claude Code on the web; a local checkout is already set up.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "${BASH_SOURCE[0]}")/../..}"

# `install` rather than `ci`: the container image is cached after this hook,
# and install reuses what is already there instead of deleting node_modules.
npm install --no-audit --no-fund

# Builds every package in dependency order, including compiling the terrain
# mesher to WebAssembly with AssemblyScript.
npm run build
