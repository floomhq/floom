/**
 * Suite H fix #5: PHP extension auto-install from composer.json.
 *
 * aimeos/ai-client-html failed because its composer.json has `ext-curl` in
 * `require`, and the default e2b image's PHP is compiled without the curl
 * extension. The fix: parse composer.json, find all `ext-*` requirements,
 * and prefix the build command with an `apt-get install` for the matching
 * Debian packages.
 *
 * Mapping is deliberately minimal — we only translate the ~15 most common
 * PHP extensions. Anything else bubbles up as a build failure with a clear
 * error that mentions the missing extension.
 */

export const EXT_TO_APT: Record<string, string[]> = {
  curl: ['php-curl'],
  mbstring: ['php-mbstring'],
  xml: ['php-xml'],
  json: [], // built in since PHP 8
  gd: ['php-gd'],
  zip: ['php-zip'],
  mysqli: ['php-mysql'],
  pdo: ['php-common'],
  pdo_mysql: ['php-mysql'],
  pdo_pgsql: ['php-pgsql'],
  pgsql: ['php-pgsql'],
  sqlite3: ['php-sqlite3'],
  intl: ['php-intl'],
  bcmath: ['php-bcmath'],
  soap: ['php-soap'],
  redis: ['php-redis'],
  openssl: [], // compiled in
  fileinfo: [], // compiled in
  tokenizer: [], // compiled in
};

export interface PhpExtInput {
  composerJsonRaw?: string;
}

export interface PhpExtResult {
  extensions: string[];
  aptPackages: string[];
  unknownExtensions: string[];
  /** Prefix to prepend to the build command (empty string if no extensions). */
  installPrefix: string;
}

export function detectPhpExtensions(input: PhpExtInput): PhpExtResult {
  const raw = input.composerJsonRaw ?? '';
  const extensions: string[] = [];

  if (!raw) {
    return { extensions: [], aptPackages: [], unknownExtensions: [], installPrefix: '' };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const req = parsed['require'];
    if (req && typeof req === 'object') {
      for (const key of Object.keys(req as Record<string, unknown>)) {
        if (key.startsWith('ext-')) {
          extensions.push(key.slice(4).toLowerCase());
        }
      }
    }
  } catch {
    return { extensions: [], aptPackages: [], unknownExtensions: [], installPrefix: '' };
  }

  const aptPackages: string[] = [];
  const unknownExtensions: string[] = [];
  for (const ext of extensions) {
    const pkgs = EXT_TO_APT[ext];
    if (pkgs === undefined) {
      unknownExtensions.push(ext);
    } else {
      aptPackages.push(...pkgs);
    }
  }

  const unique = [...new Set(aptPackages)];
  const installPrefix = unique.length
    ? `sudo apt-get update && sudo apt-get install -y ${unique.join(' ')} && `
    : '';

  return { extensions, aptPackages: unique, unknownExtensions, installPrefix };
}
