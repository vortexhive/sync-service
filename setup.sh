#!/bin/bash

# User Sync Service - Setup Script
# This script automates the setup process

set -e  # Exit on error

echo "🚀 MyUSTA User Sync Service - Setup"
echo "===================================="
echo ""

# Check Node.js version
echo "✓ Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 14 ]; then
    echo "❌ Node.js 14 or higher is required. Current version: $(node -v)"
    exit 1
fi
echo "  Node.js version: $(node -v) ✓"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from template..."
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "  Created .env file. Please edit it with your database credentials."
        echo "  Run: nano .env"
        echo ""
        read -p "Press Enter after updating .env file..."
    else
        echo "❌ .env.example not found. Please create .env manually."
        exit 1
    fi
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install
echo "  Dependencies installed ✓"
echo ""

# Check database connectivity
echo "🔌 Checking database connectivity..."

# Source .env file
export $(cat .env | grep -v '^#' | xargs)

# Test source database
echo "  Testing source database connection..."
if psql -h "${SOURCE_DB_HOST:-localhost}" -p "${SOURCE_DB_PORT:-5432}" -U "${SOURCE_DB_USER:-postgres}" -d "${SOURCE_DB_NAME:-myusta_backend}" -c "SELECT 1;" > /dev/null 2>&1; then
    echo "    Source DB: Connected ✓"
else
    echo "    Source DB: Connection failed ❌"
    echo "    Please check your SOURCE_DB_* environment variables"
    exit 1
fi

# Test chat database
echo "  Testing chat database connection..."
if psql -h "${CHAT_DB_HOST:-localhost}" -p "${CHAT_DB_PORT:-5432}" -U "${CHAT_DB_USER:-postgres}" -d "${CHAT_DB_NAME:-myusta_chatapp}" -c "SELECT 1;" > /dev/null 2>&1; then
    echo "    Chat DB: Connected ✓"
else
    echo "    Chat DB: Connection failed ❌"
    echo "    Please check your CHAT_DB_* environment variables"
    exit 1
fi
echo ""

# Run migrations
echo "🗄️  Running database migrations..."
if [ -f migrations/001_create_sync_errors_table.sql ]; then
    echo "  Applying: 001_create_sync_errors_table.sql"
    psql -h "${CHAT_DB_HOST:-localhost}" -p "${CHAT_DB_PORT:-5432}" -U "${CHAT_DB_USER:-postgres}" -d "${CHAT_DB_NAME:-myusta_chatapp}" -f migrations/001_create_sync_errors_table.sql > /dev/null 2>&1

    # Verify table was created
    if psql -h "${CHAT_DB_HOST:-localhost}" -p "${CHAT_DB_PORT:-5432}" -U "${CHAT_DB_USER:-postgres}" -d "${CHAT_DB_NAME:-myusta_chatapp}" -c "\dt sync_errors" > /dev/null 2>&1; then
        echo "    sync_errors table created ✓"
    else
        echo "    Failed to create sync_errors table ❌"
        exit 1
    fi
else
    echo "  Migration file not found, skipping..."
fi
echo ""

# Verify sync status
echo "📊 Verifying initial sync status..."
node sync.js verify
echo ""

# Ask if user wants to start the service
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Review configuration in .env"
echo "  2. Start the service:"
echo "     - For testing: node sync.js setup"
echo "     - For production: pm2 start sync.js --name user-sync-service -- setup"
echo ""

read -p "Would you like to start the service now? (y/N): " START_NOW

if [ "$START_NOW" = "y" ] || [ "$START_NOW" = "Y" ]; then
    echo ""
    echo "🚀 Starting User Sync Service..."
    node sync.js setup
else
    echo ""
    echo "To start the service later, run:"
    echo "  node sync.js setup"
fi
