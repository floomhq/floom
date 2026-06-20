# Third-Party Licenses And SBOM

Workeros is source-available under SUL-1.0. Third-party packages keep their own
licenses. This page is the release-time inventory policy for dependency license
review and SBOM publication.

## Dependency Manifests

The authoritative dependency manifests are:

- Backend: `apps/api/requirements.txt`
- Web: `apps/web/package.json` and `apps/web/package-lock.json`
- MCP/CLI: `apps/mcp/package.json` and `apps/mcp/package-lock.json`
- GitHub Actions: `.github/workflows/*.yml`

Dependabot is enabled for those ecosystems in `.github/dependabot.yml`.
Once the repository is public, pull requests that change dependency manifests
also run GitHub dependency review from
`.github/workflows/dependency-review.yml`; the gate fails on high-severity
production advisories and copyleft licenses that need legal review before
distribution. The workflow is gated to public repositories because GitHub's
dependency-review action requires GitHub Advanced Security for private repos.

## Direct Runtime Dependencies

Backend direct dependencies include FastAPI, Uvicorn, Pydantic, HTTPX, OpenAI,
OpenAI Agents, LiteLLM, E2B, cryptography, PyJWT, bcrypt, requests, ddgs, pypdf,
python-docx, lxml, slowapi, croniter, tzdata, Resend, python-dotenv, PyYAML,
python-multipart, boto3, and google-auth.

Web direct dependencies include Next.js, React, React DOM, TanStack Query,
Tailwind CSS, Base UI, shadcn, lucide-react, js-yaml, JSZip, PapaParse, pdfjs,
react-markdown, remark-gfm, highlight.js, sonner, cmdk, diff, and supporting UI
utilities.

MCP/CLI direct dependencies include the Model Context Protocol SDK, commander,
chalk, open, yaml, zod, TypeScript, tsx, and Node.js type definitions.

## Release SBOM

For each public release, generate and attach a software bill of materials from a
clean checkout after lockfiles are up to date. Preferred formats are SPDX JSON
and CycloneDX JSON.

Recommended commands:

```bash
# Whole repository SPDX SBOM from GitHub's dependency graph
gh api \
  -H "Accept: application/vnd.github+json" \
  /repos/floomhq/workeros/dependency-graph/sbom \
  > workeros-sbom.spdx.json

# Optional local cross-check when syft is installed
syft . -o cyclonedx-json > workeros-sbom.cdx.json
```

Release reviewers should check that:

- No dependency license conflicts with SUL-1.0 distribution.
- New dependencies are necessary and maintained.
- High and critical production advisories are resolved or explicitly documented.
- Generated SBOM files match the release tag, not an uncommitted working tree.
