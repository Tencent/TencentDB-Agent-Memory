<#
.SYNOPSIS
    Windows native control script for the memory-tencentdb Gateway.

.DESCRIPTION
    PowerShell equivalent of scripts/memory-tencentdb-ctl.sh, intended for
    Windows users who don't want to run inside Docker or WSL. Supports
    start / stop / restart / status / health / logs subcommands; reuses
    the same MEMORY_TENCENTDB_* env-var names as the POSIX script so
    config carries over.

    See issue #113.

.PARAMETER Command
    Subcommand to run: start | stop | restart | status | health | logs | help.

.PARAMETER NoFollow
    For `logs`: print the existing log content and exit instead of tailing.

.EXAMPLE
    PS> .\scripts\memory-tencentdb-ctl.ps1 start

.EXAMPLE
    PS> $env:MEMORY_TENCENTDB_LLM_API_KEY = "sk-..."
    PS> .\scripts\memory-tencentdb-ctl.ps1 restart

.NOTES
    Requires PowerShell 5.1+ (ships with Windows 10/11) and Node.js >= 22.16.
    npx tsx is used to run the Gateway entry, identical to the POSIX path.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'health', 'logs', 'help', '')]
    [string]$Command = 'help',

    [switch]$NoFollow
)

$ErrorActionPreference = 'Stop'
$ScriptName = 'memory-tencentdb-ctl'

# ────────────────────────────────────────────────────────────────────
# Path / port / env resolution — keep names in lock-step with ctl.sh
# ────────────────────────────────────────────────────────────────────

function Resolve-DefaultPath {
    param([string]$EnvName, [string]$Fallback)
    $value = [Environment]::GetEnvironmentVariable($EnvName)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
    return $value
}

$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$MemoryRoot = Resolve-DefaultPath 'MEMORY_TENCENTDB_ROOT' (Join-Path $UserHome '.memory-tencentdb')
$DataDir    = Resolve-DefaultPath 'TDAI_DATA_DIR'        (Join-Path $MemoryRoot 'memory-tdai')
$LogDir     = Resolve-DefaultPath 'MEMORY_TENCENTDB_LOG_DIR' (Join-Path $DataDir 'logs')
$InstallDir = Resolve-DefaultPath 'TDAI_INSTALL_DIR'     (Join-Path $MemoryRoot 'tdai-memory-openclaw-plugin')

$GatewayHost = Resolve-DefaultPath 'MEMORY_TENCENTDB_GATEWAY_HOST' '127.0.0.1'
[int]$GatewayPort = [int](Resolve-DefaultPath 'MEMORY_TENCENTDB_GATEWAY_PORT' '8420')

$PidFile    = Join-Path $LogDir 'gateway.pid'
$StdoutLog  = Join-Path $LogDir 'gateway.stdout.log'
$StderrLog  = Join-Path $LogDir 'gateway.stderr.log'
$GatewayUrl = "http://${GatewayHost}:${GatewayPort}"

# ────────────────────────────────────────────────────────────────────
# Logging
# ────────────────────────────────────────────────────────────────────

function Write-Info  { param([string]$Msg) Write-Host "[$ScriptName] $Msg" }
function Write-Warn2 { param([string]$Msg) Write-Host "[$ScriptName] WARN: $Msg" -ForegroundColor Yellow }
function Write-Die   { param([string]$Msg) Write-Host "[$ScriptName] ERROR: $Msg" -ForegroundColor Red; exit 1 }

# ────────────────────────────────────────────────────────────────────
# Dependency / port helpers
# ────────────────────────────────────────────────────────────────────

function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-ListeningPids {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $conns) { return @() }
        return @($conns | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        # Older PowerShell / restricted environments — fall back to netstat.
        $lines = netstat -ano | Select-String -Pattern "LISTENING" |
                 Select-String -Pattern ":$Port\b"
        $foundPids = @()
        foreach ($line in $lines) {
            $parts = -split $line.ToString()
            if ($parts.Length -ge 5) {
                $candidate = [int]$parts[-1]
                if ($candidate -gt 0) { $foundPids += $candidate }
            }
        }
        return $foundPids | Sort-Object -Unique
    }
}

function Test-GatewayHealth {
    param([int]$TimeoutSec = 2)
    try {
        $resp = Invoke-RestMethod -Uri "$GatewayUrl/health" -TimeoutSec $TimeoutSec
        if ($resp -and ($resp.status -eq 'ok' -or $resp.status -eq 'degraded')) {
            return $true
        }
    } catch {
        return $false
    }
    return $false
}

function Resolve-GatewayCommand {
    if ($env:MEMORY_TENCENTDB_GATEWAY_CMD) {
        return $env:MEMORY_TENCENTDB_GATEWAY_CMD
    }
    $entry = Join-Path $InstallDir 'src\gateway\server.ts'
    if (-not (Test-Path $entry)) {
        Write-Die "Gateway entry not found: $entry. Install the plugin first (npm install @tencentdb-agent-memory/memory-tencentdb@<version>) or set MEMORY_TENCENTDB_GATEWAY_CMD."
    }
    return @{
        WorkingDirectory = $InstallDir
        FilePath         = 'npx'
        ArgumentList     = @('tsx', 'src/gateway/server.ts')
    }
}

function Ensure-Paths {
    foreach ($d in @($DataDir, $LogDir)) {
        if (-not (Test-Path $d)) {
            New-Item -ItemType Directory -Path $d -Force | Out-Null
        }
    }
}

# ────────────────────────────────────────────────────────────────────
# Subcommands
# ────────────────────────────────────────────────────────────────────

function Invoke-Start {
    Ensure-Paths

    $existing = Get-ListeningPids -Port $GatewayPort
    if ($existing.Count -gt 0) {
        Write-Warn2 "Gateway already running on :$GatewayPort (pid=$($existing -join ','))"
        return 0
    }

    foreach ($needed in @('node', 'npx')) {
        if (-not (Test-CommandExists $needed)) {
            Write-Die "$needed is not on PATH. Install Node.js >= 22.16 (https://nodejs.org/) and retry."
        }
    }

    $cmd = Resolve-GatewayCommand
    Write-Info "starting gateway: npx tsx src/gateway/server.ts  (cwd=$($cmd.WorkingDirectory))"
    Write-Info "stdout -> $StdoutLog"
    Write-Info "stderr -> $StderrLog"

    $proc = Start-Process -FilePath $cmd.FilePath `
                          -ArgumentList $cmd.ArgumentList `
                          -WorkingDirectory $cmd.WorkingDirectory `
                          -WindowStyle Hidden `
                          -RedirectStandardOutput $StdoutLog `
                          -RedirectStandardError  $StderrLog `
                          -PassThru
    Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
    Write-Info "spawned pid=$($proc.Id)"

    # Wait for the port to start listening + health probe (up to ~15 s).
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        $listening = Get-ListeningPids -Port $GatewayPort
        if ($listening.Count -gt 0 -and (Test-GatewayHealth -TimeoutSec 2)) {
            Write-Info "gateway healthy on $GatewayUrl"
            return 0
        }
    }
    Write-Warn2 "gateway did not pass health check within 15 s; see $StderrLog"
    return 1
}

function Invoke-Stop {
    $portPids = Get-ListeningPids -Port $GatewayPort
    if ($portPids.Count -eq 0) {
        Write-Info "no gateway listening on :$GatewayPort"
        if (Test-Path $PidFile) {
            $wpid = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($wpid) {
                try { Stop-Process -Id $wpid -ErrorAction SilentlyContinue } catch {}
            }
            Remove-Item $PidFile -ErrorAction SilentlyContinue
        }
        return 0
    }

    Write-Info "sending Stop-Process to: $($portPids -join ',')"
    foreach ($p in $portPids) {
        try { Stop-Process -Id $p -ErrorAction SilentlyContinue } catch {}
    }

    # Wait up to 5 s for clean shutdown, then force-kill leftovers.
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        if ((Get-ListeningPids -Port $GatewayPort).Count -eq 0) {
            Write-Info "gateway stopped"
            Remove-Item $PidFile -ErrorAction SilentlyContinue
            return 0
        }
    }
    Write-Warn2 "gateway did not exit cleanly; sending force-kill"
    foreach ($p in (Get-ListeningPids -Port $GatewayPort)) {
        try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    return 0
}

function Invoke-Status {
    $portPids = Get-ListeningPids -Port $GatewayPort
    if ($portPids.Count -eq 0) {
        Write-Info "gateway: NOT RUNNING (no listener on :$GatewayPort)"
        return 1
    }
    Write-Info "gateway: RUNNING on $GatewayUrl (pid=$($portPids -join ','))"
    if (Test-GatewayHealth -TimeoutSec 2) {
        Write-Info "health : OK"
    } else {
        Write-Warn2 "health : FAILED (port open but /health did not respond)"
    }
    return 0
}

function Invoke-Health {
    try {
        $resp = Invoke-RestMethod -Uri "$GatewayUrl/health" -TimeoutSec 5
        $resp | ConvertTo-Json -Depth 4
        return 0
    } catch {
        Write-Die "health probe failed: $($_.Exception.Message)"
    }
}

function Invoke-Logs {
    if (-not (Test-Path $StderrLog) -and -not (Test-Path $StdoutLog)) {
        Write-Die "no log files yet at $LogDir; run 'start' first"
    }
    if ($NoFollow) {
        if (Test-Path $StdoutLog) { Write-Info "==> $StdoutLog <=="; Get-Content $StdoutLog -Tail 100 }
        if (Test-Path $StderrLog) { Write-Info "==> $StderrLog <=="; Get-Content $StderrLog -Tail 100 }
        return 0
    }
    Write-Info "tailing logs (Ctrl-C to stop). Use -NoFollow for a one-shot dump."
    # Tail both files concurrently. PowerShell's Get-Content -Wait blocks per file,
    # so spawn a job for stdout and tail stderr in the foreground.
    $stdoutJob = $null
    if (Test-Path $StdoutLog) {
        $stdoutJob = Start-Job -ScriptBlock {
            param($p) Get-Content $p -Wait -Tail 50 | ForEach-Object { "[stdout] $_" }
        } -ArgumentList $StdoutLog
    }
    try {
        if (Test-Path $StderrLog) {
            Get-Content $StderrLog -Wait -Tail 50 | ForEach-Object { "[stderr] $_" }
        }
    } finally {
        if ($stdoutJob) {
            Stop-Job -Job $stdoutJob -ErrorAction SilentlyContinue | Out-Null
            Remove-Job -Job $stdoutJob -Force -ErrorAction SilentlyContinue | Out-Null
        }
    }
    return 0
}

function Invoke-Help {
    @"
$ScriptName — control script for the memory-tencentdb Gateway on Windows.

Usage:
    .\scripts\memory-tencentdb-ctl.ps1 <command> [-NoFollow]

Commands:
    start     Launch the Gateway in the background, redirect stdout/stderr
              to $StdoutLog and $StderrLog, and wait for /health to respond.
    stop      Send Stop-Process to whatever is listening on :$GatewayPort,
              then force-kill if it does not exit within 5 s.
    restart   stop && start.
    status    Print whether the Gateway is listening and whether /health passes.
    health    Curl /health once and print the JSON response.
    logs      Tail stdout + stderr logs. Use -NoFollow for a one-shot dump.
    help      This message.

Environment variables (override any of these in the calling shell):
    MEMORY_TENCENTDB_ROOT        $MemoryRoot
    TDAI_INSTALL_DIR             $InstallDir
    TDAI_DATA_DIR                $DataDir
    MEMORY_TENCENTDB_LOG_DIR     $LogDir
    MEMORY_TENCENTDB_GATEWAY_HOST $GatewayHost
    MEMORY_TENCENTDB_GATEWAY_PORT $GatewayPort
    MEMORY_TENCENTDB_GATEWAY_CMD (optional override for the spawn command)
    MEMORY_TENCENTDB_LLM_API_KEY, MEMORY_TENCENTDB_LLM_BASE_URL, MEMORY_TENCENTDB_LLM_MODEL
                                 (consumed by the Gateway sidecar, not this script)

Hosts older than PowerShell 5.1 are not supported; the script falls back to
netstat / parsing when Get-NetTCPConnection is unavailable, but that path is
best-effort.
"@
    return 0
}

# ────────────────────────────────────────────────────────────────────
# Dispatch
# ────────────────────────────────────────────────────────────────────

switch ($Command) {
    'start'   { exit (Invoke-Start) }
    'stop'    { exit (Invoke-Stop) }
    'restart' {
        Invoke-Stop  | Out-Null
        exit (Invoke-Start)
    }
    'status'  { exit (Invoke-Status) }
    'health'  { exit (Invoke-Health) }
    'logs'    { exit (Invoke-Logs) }
    default   { exit (Invoke-Help) }
}
