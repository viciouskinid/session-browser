'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const ui = path.join(__dirname, '..', 'src', 'ui');
const src = fs.readFileSync(path.join(ui, 'build.js'), 'utf8');

test('build.js holds exactly one stamp and one version, in a valid combination', () => {
  const stamps = src.match(/^const BUILD_STAMP\s*=\s*'([^']*)';\s*\/\/ BUILD_STAMP$/gm) || [];
  const versions = src.match(/^const BUILD_VERSION\s*=\s*([^;]*);\s*\/\/ BUILD_VERSION$/gm) || [];
  assert.equal(stamps.length, 1); assert.equal(versions.length, 1);
  const stamp = /'([^']*)'/.exec(stamps[0])[1], version = /=\s*([^;]*);/.exec(versions[0])[1].trim();
  if (stamp === 'unknown') assert.match(version, /^[1-9]\d*$/);
  else { assert.match(stamp, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/); assert.equal(version, 'null'); assert.ok(stamp > '2026-01-01 00:00:00'); }
});

test('the page only displays the constants and never computes the build time', () => {
  assert.match(fs.readFileSync(path.join(ui, 'index.html'), 'utf8'), /<script src="build\.js"><\/script>\s*<script src="ui\.js">/);
  const js = fs.readFileSync(path.join(ui, 'ui.js'), 'utf8');
  assert.ok(js.includes('BUILD_STAMP') && !/new Date\(/.test(js));
});
