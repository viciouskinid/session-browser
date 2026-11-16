'use strict';
// Windows Hello gate for the saved-password vault. It asks Windows itself (UserConsentVerifier, the same prompt as Windows sign-in:
// PIN, fingerprint, face, or the account password as a fallback) through PowerShell, because Electron has no API for it. The app
// only learns "verified" or why not. Nothing is stored. If the check cannot run, the answer is NO (it fails closed).
const { spawn: realSpawn } = require('child_process');

// Only plain words reach the prompt text, so the message can never alter the script.
const cleanMessage = m => String(m || 'Unlock your saved passwords').replace(/[^\w .,:;!?()-]/g, '').slice(0, 80) || 'Unlock your saved passwords';

function buildScript(message) {
  return `$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  $availability = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()))
  $availability.Wait(-1) | Out-Null
  if ($availability.Result.ToString() -ne 'Available') { Write-Output ('SB_RESULT:' + $availability.Result.ToString()); exit 0 }
  $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${cleanMessage(message)}')
  $task = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  Write-Output ('SB_RESULT:' + $task.Result.ToString())
} catch { Write-Output 'SB_RESULT:Error' }
`;
}

const parseResult = out => { const m = /SB_RESULT:(\w+)/.exec(String(out || '')); return m ? m[1] : 'Error'; };

function describe(status) {
  switch (status) {
    case 'Verified': return 'Unlocked.';
    case 'Canceled': return 'Unlock cancelled.';
    case 'DeviceNotPresent': case 'NotConfiguredForUser': return 'Windows Hello is not set up on this PC. Set it up in Windows Settings > Accounts > Sign-in options.';
    case 'DisabledByPolicy': return 'Windows Hello is turned off by your administrator.';
    case 'DeviceBusy': return 'Windows Hello is busy. Try again.';
    case 'RetriesExhausted': return 'Too many failed attempts. Try again later.';
    case 'Unsupported': return 'Windows Hello is only available on Windows.';
    case 'Timeout': return 'Windows Hello did not answer in time.';
    default: return 'Windows Hello could not verify you.';
  }
}

// -> { ok, status }. opts: spawn, platform, timeoutMs (for tests)
function verify(message, opts = {}) {
  const platform = opts.platform || process.platform, spawn = opts.spawn || realSpawn;
  if (platform !== 'win32') return Promise.resolve({ ok: false, status: 'Unsupported' });
  return new Promise(resolve => {
    let out = '', settled = false;
    const done = status => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: status === 'Verified', status }); };
    let child;
    const timer = setTimeout(() => { try { child && child.kill(); } catch {} done('Timeout'); }, opts.timeoutMs || 120000);
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(buildScript(message), 'utf16le').toString('base64')], { windowsHide: true });
    } catch { return done('Error'); }
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => done('Error'));
    child.on('close', () => done(parseResult(out)));
  });
}

module.exports = { verify, describe, parseResult, buildScript, cleanMessage };
