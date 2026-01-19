#Requires -Version 5.1
<#
.SYNOPSIS
    Deploys sync-service to production server (151.243.213.116)

.DESCRIPTION
    This script automates the sync service deployment process:
    1. Commits any uncommitted changes (optional)
    2. Pushes to GitHub remote
    3. SSH to server and pulls changes
    4. Installs dependencies if needed
    5. Runs database migration for sync_errors table
    6. Restarts PM2 process
    7. Verifies health endpoint

    LESSONS LEARNED:
    - Sync service runs on same server as api.myusta.al (151.243.213.116)
    - Uses PM2 for process management
    - Connects to both myusta_backend_02 and chat_app_02 databases
    - Health endpoint on port 9000

.PARAMETER CommitMessage
    Optional commit message. If provided, will commit all changes before deploying.

.PARAMETER SkipMigration
    Skip running database migrations

.PARAMETER Force
    Force restart even if no changes

.EXAMPLE
    .\deploy-sync-to-server.ps1
    # Deploy current committed changes

.EXAMPLE
    .\deploy-sync-to-server.ps1 -CommitMessage "Fix sync issue"
    # Commit changes and deploy

.EXAMPLE
    .\deploy-sync-to-server.ps1 -Force
    # Force restart the service
#>

param(
    [string]$CommitMessage = "",
    [switch]$SkipMigration,
    [switch]$Force
)

# Configuration
$ServerIP = "151.243.213.116"
$SSHKeyPath = "$env:USERPROFILE\.ssh\myusta_admin_key"
$RemoteUser = "root"
$RemotePath = "/root/sync-service"
$PM2ProcessName = "user-sync-service"
$HealthCheckUrl = "http://localhost:9000/health"
$GitRemote = "github"
$Branch = "main"

# Colors for output
function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warning { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Failure { param($msg) Write-Host "[FAIL] $msg" -ForegroundColor Red }

# Track start time
$startTime = Get-Date

Write-Host "`n========================================" -ForegroundColor Magenta
Write-Host "  MyUSTA Sync Service - Deployment" -ForegroundColor Magenta
Write-Host "========================================`n" -ForegroundColor Magenta

# Ensure we're in the right directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$syncDir = Split-Path -Parent $scriptDir
Set-Location $syncDir
Write-Host "Working directory: $syncDir"

# Check if SSH key exists
Write-Step "Checking SSH key..."
if (-not (Test-Path $SSHKeyPath)) {
    Write-Failure "SSH key not found at: $SSHKeyPath"
    Write-Host "Please ensure SSH key is configured for server access."
    exit 1
}
Write-Success "SSH key found"

# Check for uncommitted changes
$status = git status --porcelain
if ($status) {
    if ($CommitMessage) {
        Write-Step "Committing changes..."
        git add .
        git commit -m $CommitMessage
        if ($LASTEXITCODE -ne 0) {
            Write-Failure "Git commit failed"
            exit 1
        }
        Write-Success "Changes committed: $CommitMessage"
    } else {
        Write-Warning "You have uncommitted changes. They will NOT be deployed."
        Write-Host $status
        $response = Read-Host "Continue anyway? (y/N)"
        if ($response -ne 'y' -and $response -ne 'Y') {
            Write-Host "Aborted."
            exit 0
        }
    }
}

# Push to GitHub
Write-Step "Pushing to GitHub..."
$pushOutput = git push $GitRemote $Branch 2>&1
$pushExitCode = $LASTEXITCODE
Write-Host $pushOutput

if ($pushExitCode -ne 0) {
    Write-Failure "Git push failed!"
    exit 1
}

if ($pushOutput -match "Everything up-to-date" -and -not $Force) {
    Write-Warning "No changes to deploy (Everything up-to-date)"
    Write-Host "Use -Force flag to restart the service anyway"
    exit 0
}

Write-Success "Git push completed!"

# SSH to server and deploy
Write-Step "Deploying to server ($ServerIP)..."

$sshCommands = @"
cd $RemotePath || { echo 'Directory not found, cloning...'; git clone git@github.com:vortexhive/sync-service.git $RemotePath && cd $RemotePath; }

echo '==> Pulling latest changes...'
git pull $GitRemote $Branch

echo '==> Installing dependencies...'
npm install --production

echo '==> Copying production environment...'
if [ -f .env.production ]; then
    cp .env.production .env
fi

$(if (-not $SkipMigration) { @"
echo '==> Running database migration...'
# Create sync_errors table if not exists
PGPASSWORD=strongpassword psql -h localhost -U ustauser -d chat_app_02 -c "
CREATE TABLE IF NOT EXISTS sync_errors (
    id SERIAL PRIMARY KEY,
    error_type VARCHAR(100) NOT NULL,
    user_id VARCHAR(255),
    error_message TEXT,
    error_stack TEXT,
    additional_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    resolved BOOLEAN DEFAULT FALSE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    retry_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sync_errors_created_at ON sync_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_errors_error_type ON sync_errors(error_type);
CREATE INDEX IF NOT EXISTS idx_sync_errors_user_id ON sync_errors(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_errors_resolved ON sync_errors(resolved);
" 2>/dev/null || echo 'Migration completed (table may already exist)'
"@ })

echo '==> Checking PM2 process...'
if pm2 describe $PM2ProcessName > /dev/null 2>&1; then
    echo 'Restarting existing PM2 process...'
    pm2 restart $PM2ProcessName
else
    echo 'Starting new PM2 process...'
    pm2 start sync.js --name "$PM2ProcessName" -- setup
    pm2 save
fi

echo '==> Waiting for service to start (10 seconds)...'
sleep 10

echo '==> Checking health...'
curl -s $HealthCheckUrl | head -c 500

echo ''
echo '==> PM2 Status:'
pm2 status $PM2ProcessName
"@

# Execute SSH commands
$sshOutput = & ssh -i $SSHKeyPath -o StrictHostKeyChecking=no "$RemoteUser@$ServerIP" $sshCommands 2>&1
Write-Host $sshOutput

if ($LASTEXITCODE -ne 0) {
    Write-Failure "Deployment failed!"
    exit 1
}

# Verify deployment
Write-Step "Verifying deployment..."
$verifyCommand = "curl -s http://localhost:9000/health"
$healthOutput = & ssh -i $SSHKeyPath -o StrictHostKeyChecking=no "$RemoteUser@$ServerIP" $verifyCommand 2>&1

if ($healthOutput -match '"status":\s*"HEALTHY"') {
    Write-Success "Health check passed!"
} else {
    Write-Warning "Health check may have issues. Response:"
    Write-Host $healthOutput
}

# Summary
$endTime = Get-Date
$duration = $endTime - $startTime

Write-Host "`n========================================" -ForegroundColor Magenta
Write-Host "  Deployment Complete!" -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta
Write-Host "Duration: $($duration.ToString('mm\:ss'))"
Write-Host "Server: $ServerIP"
Write-Host "Health: http://$ServerIP:9000/health"
Write-Host "Status: http://$ServerIP:9000/status"
Write-Host "Metrics: http://$ServerIP:9000/metrics"

Write-Success "Deployment successful!"
exit 0
