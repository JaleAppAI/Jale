[CmdletBinding()]
param(
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$databaseUrl = 'postgres://postgres:test@localhost:55432/jale'

function Invoke-InDirectory {
  param([string]$Path, [scriptblock]$Command)
  Push-Location (Join-Path $repoRoot $Path)
  try { & $Command } finally { Pop-Location }
}

if (-not $SkipInstall) {
  foreach ($directory in @('frontend', 'infra', 'scripts/stripe-spike')) {
    Write-Host "Installing pinned dependencies in $directory..."
    Invoke-InDirectory $directory { npm ci }
  }
}

if (-not (Test-Path (Join-Path $repoRoot 'scripts/stripe-spike/.env'))) {
  throw 'Missing scripts/stripe-spike/.env. Copy .env.example and add a Stripe test key before the Stripe demo.'
}

if (-not (Test-Path (Join-Path $repoRoot 'frontend/.env.local'))) {
  Write-Warning 'frontend/.env.local is missing. Database and Stripe checks can continue, but the UI demo is not ready.'
}

Write-Host 'Recreating disposable local Postgres container jale-test-pg...'
& docker rm -f jale-test-pg 2>$null
& docker run -d --name jale-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16
Start-Sleep -Seconds 5
& docker exec jale-test-pg pg_isready -U postgres
& docker exec jale-test-pg psql -U postgres -c "CREATE ROLE jale_admin LOGIN PASSWORD 'test-admin-pw' CREATEROLE" -c "CREATE DATABASE jale OWNER jale_admin"

$env:JALE_TEST_DATABASE_URL = $databaseUrl
try {
  Write-Host 'Applying migrations from an empty database...'
  Invoke-InDirectory 'infra' { npx jest test/unit/db/migrations/apply-order.test.ts -t 'applies migrations' }
  Write-Host 'Running billing database integration tests...'
  Invoke-InDirectory 'infra' {
    npx jest test/unit/db/billing-rls.integration.test.ts test/unit/db/entitlement-concurrency.integration.test.ts --runInBand
  }
} finally {
  Remove-Item Env:JALE_TEST_DATABASE_URL -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Database preflight passed. Next: dry-run Stripe checkout and npm run dev in frontend.' -ForegroundColor Green
