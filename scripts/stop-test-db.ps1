# Stop the MyTeam local test database.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/stop-test-db.ps1

$MYSQL_BIN = 'D:\MySQL\Server-8.4.11\bin'

if (-not (Test-Path "$MYSQL_BIN\mysqladmin.exe")) {
    Write-Host "MySQL not found at: $MYSQL_BIN (edit MYSQL_BIN at the top of this script)"
    exit 1
}

& "$MYSQL_BIN\mysqladmin.exe" --user=root --skip-password --host=127.0.0.1 --port=3307 shutdown 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host 'OK: test DB stopped'
} else {
    Write-Host 'No running test DB detected (or already stopped)'
}
