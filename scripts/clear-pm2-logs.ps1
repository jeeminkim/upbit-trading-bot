# PM2 refactor 앱 로그 비우기 (api-server, discord-operator, market-bot)
# 사용: .\scripts\clear-pm2-logs.ps1
# 또는: powershell -ExecutionPolicy Bypass -File scripts\clear-pm2-logs.ps1

$logsDir = Join-Path $PSScriptRoot "..\logs"
if (-not (Test-Path $logsDir)) {
    Write-Host "[clear-pm2-logs] logs folder not found: $logsDir"
    exit 1
}

# refactor 앱 로그 파일 (id 0=api-server, 1=discord-operator, 2=market-bot)
$names = @("error-0", "out-0", "error-1", "out-1", "error-2", "out-2")
$cleared = 0
foreach ($n in $names) {
    $path = Join-Path $logsDir "pm2-%name%-$n.log"
    if (Test-Path $path) {
        try {
            Clear-Content -Path $path -Force -ErrorAction Stop
            Write-Host "[clear-pm2-logs] cleared: pm2-%name%-$n.log"
            $cleared++
        } catch {
            Write-Warning "[clear-pm2-logs] failed (file may be in use): $path - $($_.Exception.Message)"
        }
    }
}
Write-Host "[clear-pm2-logs] done. cleared $cleared file(s). If PM2 is running, stop it first: npx pm2 delete api-server discord-operator market-bot"
