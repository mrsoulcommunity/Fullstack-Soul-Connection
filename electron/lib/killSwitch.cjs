'use strict';
const { execFile } = require('child_process');

// Windows Firewall (WFP) picks rule precedence by specificity, not insertion
// order or allow-vs-block: a rule that names a program or remote IP is more
// specific than the bare "block everything" rule below, so the two allow
// rules win even though the block rule also matches. That's what lets a
// single generic block-all rule co-exist with "but let xray's own process
// and loopback through" without any priority/weight flags.
const RULE_BLOCK = 'SoulConnectionKillSwitch-Block';
const RULE_ALLOW_XRAY = 'SoulConnectionKillSwitch-AllowXray';
const RULE_ALLOW_LOOPBACK = 'SoulConnectionKillSwitch-AllowLoopback';
const ALL_RULES = [RULE_BLOCK, RULE_ALLOW_XRAY, RULE_ALLOW_LOOPBACK];

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('netsh.exe', args, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function deleteRule(name) {
  try {
    await run(['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`]);
  } catch {
    // Rule may simply not exist -- deleting is always best-effort cleanup.
  }
}

async function disable() {
  for (const name of ALL_RULES) await deleteRule(name);
}

// Adds the two allow rules first and the block-all rule last, so that if
// anything throws partway through (most likely: not actually elevated, which
// fails every one of these identically), we abort before the dangerous
// block-all rule ever lands and roll back whatever partial state resulted.
async function enable(xrayBinPath) {
  await disable(); // idempotent: clear any stale rules from a previous run first
  try {
    await run(['advfirewall', 'firewall', 'add', 'rule', `name=${RULE_ALLOW_LOOPBACK}`, 'dir=out', 'action=allow', 'remoteip=127.0.0.1', 'enable=yes', 'profile=any']);
    await run(['advfirewall', 'firewall', 'add', 'rule', `name=${RULE_ALLOW_XRAY}`, 'dir=out', 'action=allow', `program=${xrayBinPath}`, 'enable=yes', 'profile=any']);
    await run(['advfirewall', 'firewall', 'add', 'rule', `name=${RULE_BLOCK}`, 'dir=out', 'action=block', 'enable=yes', 'profile=any']);
  } catch (err) {
    await disable();
    throw err;
  }
}

async function isActive() {
  try {
    const out = await run(['advfirewall', 'firewall', 'show', 'rule', `name=${RULE_BLOCK}`]);
    return !/no rules match/i.test(out);
  } catch {
    return false;
  }
}

module.exports = { enable, disable, isActive };
