import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outputPath = path.join(root, "docs", "sbom", "floom-sbom.spdx.json");
const STABLE_CREATED_AT = "2026-06-21T00:00:00Z";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function sha1(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function spdxId(name, version) {
  return `SPDXRef-Package-${sha1(`${name}@${version || "unknown"}`)}`;
}

function addPackage(packages, seen, name, version, supplier = "NOASSERTION") {
  if (!name) return;
  const normalizedVersion = version || "NOASSERTION";
  const key = `${name}@${normalizedVersion}`;
  if (seen.has(key)) return;
  seen.add(key);
  packages.push({
    SPDXID: spdxId(name, normalizedVersion),
    name,
    versionInfo: normalizedVersion,
    supplier,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    copyrightText: "NOASSERTION",
  });
}

function collectNpm(packages, seen, relativeLockPath) {
  const lock = readJson(relativeLockPath);
  for (const [packagePath, meta] of Object.entries(lock.packages || {})) {
    if (!packagePath || !meta?.version) continue;
    const name = meta.name || packagePath.split("node_modules/").at(-1);
    addPackage(packages, seen, name, meta.version, "Organization: npm");
  }
}

function collectPip(packages, seen, relativeRequirementsPath) {
  const text = fs.readFileSync(path.join(root, relativeRequirementsPath), "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*(?:==|>=|<=|~=|>|<)?\s*([^;#\s]+)?/);
    if (!match) continue;
    addPackage(packages, seen, match[1], match[2] || "NOASSERTION", "Organization: PyPI");
  }
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const rootPackage = readJson("package.json");
const packages = [];
const seen = new Set();
addPackage(packages, seen, rootPackage.name, rootPackage.version, "Organization: Floom");
collectNpm(packages, seen, "apps/web/package-lock.json");
collectNpm(packages, seen, "apps/mcp/package-lock.json");
collectPip(packages, seen, "apps/api/requirements.txt");

const document = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "floom-sbom",
  documentNamespace: "https://github.com/floomhq/floom/sbom/main",
  creationInfo: {
    created: STABLE_CREATED_AT,
    creators: ["Tool: scripts/generate-sbom.mjs"],
  },
  packages,
  relationships: packages
    .filter((pkg) => pkg.name !== rootPackage.name)
    .map((pkg) => ({
      spdxElementId: spdxId(rootPackage.name, rootPackage.version),
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: pkg.SPDXID,
    })),
};

fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outputPath)} (${packages.length} packages)`);
