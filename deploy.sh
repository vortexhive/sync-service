#!/bin/bash

# Deployment script for sync-service
# Run this on the production server

set -e  # Exit on error

echo "=========================================="
echo "  Sync Service Deployment Script"
echo "=========================================="
echo ""

# Navigate to sync-service directory
cd /root/sync-service

echo "1️⃣  Pulling latest changes from git..."
git pull origin main
echo "✅ Code updated"
echo ""

echo "2️⃣  Installing/updating dependencies..."
npm install
echo "✅ Dependencies installed"
echo ""

echo "3️⃣  Applying database migrations..."
echo "   Creating sync_errors table (if not exists)..."
PGPASSWORD=${CHAT_DB_PASSWORD} psql -h localhost -U postgres -d myusta_chatapp -f migrations/001_create_sync_errors_table.sql
echo "✅ Migrations applied"
echo ""

echo "4️⃣  Fixing email unique constraint..."
PGPASSWORD=${CHAT_DB_PASSWORD} psql -h localhost -U postgres -d myusta_chatapp << 'EOF'
-- Drop old constraint
DROP INDEX IF EXISTS idx_users_email;

-- Create partial unique index (allows NULL duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
ON users (email)
WHERE email IS NOT NULL AND email != '';

-- Verify
\di idx_users_email_unique
EOF
echo "✅ Email constraint fixed"
echo ""

echo "5️⃣  Stopping PM2 service..."
pm2 stop user-sync-service || echo "Service was not running"
echo ""

echo "6️⃣  Starting PM2 service..."
pm2 start sync.js --name user-sync-service -- setup
pm2 save
echo "✅ Service started"
echo ""

echo "7️⃣  Checking service status..."
pm2 status user-sync-service
echo ""

echo "8️⃣  Monitoring logs (press Ctrl+C to exit)..."
echo "=========================================="
sleep 2
pm2 logs user-sync-service --lines 100
