/**
 * Unit tests for Suite H fix #5 (PHP extension auto-install).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPhpExtensions } from '@floom/detect';

test('detectPhpExtensions: ext-curl -> php-curl (ai-client-html case)', () => {
  const composer = JSON.stringify({
    name: 'aimeos/ai-client-html',
    require: {
      php: '>=8.0',
      'ext-curl': '*',
      'ext-mbstring': '*',
    },
  });
  const result = detectPhpExtensions({ composerJsonRaw: composer });
  assert.deepEqual(result.extensions.sort(), ['curl', 'mbstring']);
  assert.deepEqual(result.aptPackages.sort(), ['php-curl', 'php-mbstring']);
  assert.match(result.installPrefix, /apt-get install.*php-curl/);
});

test('detectPhpExtensions: unknown extension is surfaced', () => {
  const composer = JSON.stringify({
    name: 'exotic',
    require: {
      'ext-imagick': '*',
    },
  });
  const result = detectPhpExtensions({ composerJsonRaw: composer });
  assert.deepEqual(result.unknownExtensions, ['imagick']);
  assert.deepEqual(result.aptPackages, []);
});

test('detectPhpExtensions: no ext-* deps means no prefix', () => {
  const composer = JSON.stringify({
    name: 'no-ext',
    require: { php: '>=8.0', 'symfony/console': '^5' },
  });
  const result = detectPhpExtensions({ composerJsonRaw: composer });
  assert.equal(result.installPrefix, '');
  assert.equal(result.extensions.length, 0);
});

test('detectPhpExtensions: built-ins (json, openssl) add no apt pkgs', () => {
  const composer = JSON.stringify({
    name: 'builtin',
    require: { 'ext-json': '*', 'ext-openssl': '*' },
  });
  const result = detectPhpExtensions({ composerJsonRaw: composer });
  assert.equal(result.installPrefix, '');
  assert.deepEqual(result.extensions.sort(), ['json', 'openssl']);
});
