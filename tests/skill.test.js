'use strict';
// Keeps skills/multi-account-login/SKILL.md honest: every file, function and IPC channel it names must exist in the source.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const skill = fs.readFileSync(path.join(root, 'skills', 'multi-account-login', 'SKILL.md'), 'utf8');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const section = name => { const a = skill.indexOf('## ' + name); const b = skill.indexOf('\n## ', a + 3); return skill.slice(a, b < 0 ? undefined : b); };

test('the skill has the required front matter', () => {
  assert.match(skill, /^---\nname: multi-account-login\ndescription: .{60,}\n---\n/);
});

test('every function in the code map exists in the file it is listed under', () => {
  const lines = section('6. Code map').split('\n').filter(l => l.startsWith('- `'));
  assert.ok(lines.length >= 15);
  for (const l of lines) {
    const [, name, file] = /^- `(\w+)` - `([^`]+)`/.exec(l) || [];
    assert.ok(name && file, 'unparsed line: ' + l);
    assert.ok(fs.existsSync(path.join(root, file)), file + ' exists');
    assert.match(read(file), new RegExp(`(function\\s+${name}\\b|\\b${name}\\s*[(:=]|async\\s+${name}\\b)`), `${name} in ${file}`);
  }
});

test('every IPC channel the skill names is registered in the main process', () => {
  const main = read('src/main.js'), chans = [...section('7. IPC channels').matchAll(/`([\w:]+)`/g)].map(m => m[1]);
  assert.ok(chans.length >= 12);
  for (const c of chans) assert.ok(main.includes(`'${c}'`), c);
});

test('the invariants the skill promises are present in the code', () => {
  const main = read('src/main.js'), vault = read('src/vault.js'), pre = read('src/sitepreload.js'), hello = read('src/hello.js');
  assert.match(vault, /A username is required/);                                   // 5: no username, no save
  assert.match(main, /scheduleLoginRefresh|refreshLogin/); assert.match(main, /noAuto\.add\(id\)/);       // 10: logout blocks auto sign-in
  assert.match(main, /eligibleOrigin\(url\) === sec\.origin/);                     // 6: origin re-checked at fill time
  assert.match(pre, /form\.action[^;]*location\.origin|origin !== location\.origin/);   // 6: never post to another origin
  assert.match(hello, /Unsupported/); assert.match(main, /hello\.verify\(on \?/);       // 8: Hello verified when turned on
  assert.match(main, /for \(const c of await ses\.cookies\.get\(\{\}\)\) \{[\s\S]{0,200}siteKey/);       // 9: logout clears the site's cookies only
  assert.match(main, /helloLocked\(\)/);
  assert.match(main, /3 \* 60 \* 1000|10 \* 60 \* 1000/);                         // held logins expire
});
