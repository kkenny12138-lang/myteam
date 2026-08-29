# Start MyTeam local MySQL (standalone instance on port 3307).
# - Does NOT affect the existing MySQL service on the default port 3306.
# - Creates database `myteam` and app user `myteam` / `myteam123` (idempotent).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/start-test-db.ps1

$MYSQL_BIN = 'D:\MySQL\Server-8.4.11\bin'
$ROOT = Join-Path $PSScriptRoot '..'
$DIR = Join-Path $ROOT '.test-db'
$DATA = Join-Path $DIR 'data'
New-Item -ItemType Directory -Force -Path $DIR | Out-Null

if (-not (Test-Path "$MYSQL_BIN\mysqld.exe")) {
    Write-Host "MySQL not found at: $MYSQL_BIN (edit MYSQL_BIN at the top of this script)"
    exit 1
}

$existing = Get-NetTCPConnection -LocalPort 3307 -State Listen -ErrorAction SilentlyContinue
if (-not $existing) {
    if (-not (Test-Path "$DATA\mysql")) {
        Write-Host 'First run: initializing data directory...'
        & "$MYSQL_BIN\mysqld.exe" --initialize-insecure --datadir="$DATA"
        if ($LASTEXITCODE -ne 0) { Write-Host 'Init failed'; exit 1 }
    }
    Write-Host 'Starting MySQL on 127.0.0.1:3307 ...'
    Start-Process -FilePath "$MYSQL_BIN\mysqld.exe" -ArgumentList "--datadir=$DATA","--port=3307","--bind-address=127.0.0.1","--enable-named-pipe=OFF","--pid-file=$DIR\mysql.pid","--log-error=$DIR\error.log" -WindowStyle Hidden
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        & "$MYSQL_BIN\mysqladmin.exe" --user=root --skip-password --host=127.0.0.1 --port=3307 ping 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) { Write-Host 'Startup timeout, see .test-db\error.log'; exit 1 }
} else {
    Write-Host 'MySQL already running on 127.0.0.1:3307'
}

# Ensure database and app user exist (idempotent)
$sql = @'
CREATE DATABASE IF NOT EXISTS myteam CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'myteam'@'%' IDENTIFIED BY 'myteam123';
GRANT ALL PRIVILEGES ON myteam.* TO 'myteam'@'%';
FLUSH PRIVILEGES;
'@
$sql | & "$MYSQL_BIN\mysql.exe" --user=root --skip-password --host=127.0.0.1 --port=3307 2>&1 | Out-Null

Write-Host ''
Write-Host 'OK: local MySQL ready'
Write-Host '    host:     127.0.0.1:3307'
Write-Host '    database: myteam'
Write-Host '    user:     myteam / myteam123'
Write-Host 'Next: Copy-Item .env.test .env ; then npm run start'
