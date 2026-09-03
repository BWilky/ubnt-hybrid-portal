'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSchedulerCmd } = require('../lib/ssh');

// A fake vyatta-cfg-cmd-wrapper: `set` on an already-configured node exits 1
// with the real "already exists" message (as EdgeOS does on a re-deploy);
// begin/commit/delete/save/end record that they ran and exit 0.
function harness(vars) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  const W = path.join(dir, 'wrap');
  fs.writeFileSync(W, `#!/usr/bin/env bash
op="$1"; shift
case "$op" in
  set)    echo "The specified configuration node already exists"; exit 1 ;;
  delete) echo "delete $*" >> "${dir}/ran"; exit 0 ;;
  commit) echo "commit" >> "${dir}/ran"; exit 0 ;;
  begin|end|save) echo "$op" >> "${dir}/ran"; exit 0 ;;
esac`);
  fs.chmodSync(W, 0o755);
  const cmd = buildSchedulerCmd(vars, W);
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  const ran = fs.existsSync(path.join(dir, 'ran')) ? fs.readFileSync(path.join(dir, 'ran'), 'utf8') : '';
  return { ran, code: r.status };
}

test('re-deploy still reaches delete weekly-ap-cycle and commit even when set reports the node already exists', () => {
  const { ran } = harness({ REBOOT_CRON: '0 4 * * 0' });
  assert.match(ran, /delete .*weekly-ap-cycle/, 'the retired weekly-ap-cycle task is deleted');
  assert.match(ran, /commit/, 'the config is committed so the delete persists');
});
