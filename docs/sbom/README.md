# SBOM

`floom-sbom.spdx.json` is the generated SPDX software bill of materials for the
current repository dependency manifests.

Regenerate it from the repository root before each public release:

```bash
node scripts/generate-sbom.mjs
```

If GitHub dependency graph export is available, release managers can also attach
GitHub's generated SPDX export as a cross-check:

```bash
gh api \
  -H "Accept: application/vnd.github+json" \
  /repos/floomhq/floom/dependency-graph/sbom \
  > floom-sbom.github.spdx.json
```
