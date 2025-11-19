# Deployment Guide - User Sync Service

## 🚀 Quick Start

### Step 1: Prerequisites
- Node.js 14.0.0 or higher
- PostgreSQL 12 or higher
- Access to both `myusta_backend` and `myusta_chatapp` databases

### Step 2: Install Dependencies
```bash
cd sync-service
npm install
```

### Step 3: Configure Environment
```bash
# Copy example environment file
cp .env.example .env

# Edit with your database credentials
nano .env
```

**Required variables:**
```env
SOURCE_DB_PASSWORD=your_backend_db_password
CHAT_DB_PASSWORD=your_chat_db_password
```

**Optional but recommended:**
```env
SYNC_INTERVAL_MINUTES=1
SOURCE_DB_POOL_SIZE=10
CHAT_DB_POOL_SIZE=10
```

### Step 4: Run Database Migration
```bash
# Connect to chat database and create sync_errors table
psql -U postgres -d myusta_chatapp -f migrations/001_create_sync_errors_table.sql
```

Verify:
```sql
\c myusta_chatapp
\dt sync_errors
```

### Step 5: Test the Service
```bash
# Run initial sync and verification
node sync.js verify

# If verification passes, start the service
node sync.js setup
```

## 🐳 Production Deployment

### Option 1: Using PM2 (Recommended)

```bash
# Install PM2 globally
npm install -g pm2

# Start service with PM2
pm2 start sync.js --name "user-sync-service" -- setup

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

**PM2 Monitoring:**
```bash
# View logs
pm2 logs user-sync-service

# View real-time metrics
pm2 monit

# Restart service
pm2 restart user-sync-service

# Stop service
pm2 stop user-sync-service
```

### Option 2: Using SystemD (Linux)

Create service file:
```bash
sudo nano /etc/systemd/system/user-sync.service
```

```ini
[Unit]
Description=MyUSTA User Sync Service
After=network.target postgresql.service

[Service]
Type=simple
User=nodejs
WorkingDirectory=/path/to/sync-service
ExecStart=/usr/bin/node sync.js setup
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment="NODE_ENV=production"

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable user-sync
sudo systemctl start user-sync

# Check status
sudo systemctl status user-sync

# View logs
sudo journalctl -u user-sync -f
```

### Option 3: Using Docker

**Dockerfile:**
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["node", "sync.js", "setup"]
```

**docker-compose.yml:**
```yaml
version: '3.8'

services:
  user-sync:
    build: .
    container_name: myusta-user-sync
    restart: unless-stopped
    env_file:
      - .env
    depends_on:
      - postgres-backend
      - postgres-chat
    networks:
      - myusta-network

networks:
  myusta-network:
    external: true
```

Build and run:
```bash
docker-compose up -d

# View logs
docker-compose logs -f user-sync

# Restart
docker-compose restart user-sync
```

## 📊 Monitoring Setup

### 1. Health Check Script

Create `health-check.sh`:
```bash
#!/bin/bash

STATS=$(node -e "
const UserTableSyncService = require('./sync.js');
const service = new UserTableSyncService();
const stats = service.getSyncStats();
console.log(JSON.stringify(stats));
")

echo "$STATS" | jq '.'

# Check if healthy
HEALTH=$(echo "$STATS" | jq -r '.healthStatus.status')
if [ "$HEALTH" != "HEALTHY" ]; then
    echo "❌ Service is UNHEALTHY"
    exit 1
fi

echo "✅ Service is HEALTHY"
exit 0
```

Make executable:
```bash
chmod +x health-check.sh
```

### 2. Cron Job for Monitoring

```bash
# Add to crontab
crontab -e

# Run health check every 5 minutes
*/5 * * * * /path/to/sync-service/health-check.sh >> /var/log/user-sync-health.log 2>&1
```

### 3. Error Monitoring Query

Create `check-errors.sql`:
```sql
-- Check for recent errors
SELECT
    error_type,
    COUNT(*) as error_count,
    MAX(created_at) as last_occurrence
FROM sync_errors
WHERE created_at > NOW() - INTERVAL '1 hour'
    AND resolved = FALSE
GROUP BY error_type
ORDER BY error_count DESC;
```

Run periodically:
```bash
psql -U postgres -d myusta_chatapp -f check-errors.sql
```

## 🔐 Security Best Practices

### 1. Database Permissions

```sql
-- Create dedicated sync user
CREATE USER sync_service WITH PASSWORD 'strong_password_here';

-- Grant minimal required permissions on source DB
GRANT CONNECT ON DATABASE myusta_backend TO sync_service;
GRANT SELECT ON users TO sync_service;

-- Grant required permissions on chat DB
GRANT CONNECT ON DATABASE myusta_chatapp TO sync_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO sync_service;
GRANT INSERT, SELECT ON sync_errors TO sync_service;
GRANT USAGE, SELECT ON SEQUENCE sync_errors_id_seq TO sync_service;
```

### 2. Environment File Protection

```bash
# Restrict .env file permissions
chmod 600 .env

# Never commit .env to version control
echo ".env" >> .gitignore
```

### 3. Connection Encryption

Update `.env`:
```env
SOURCE_DB_SSL=true
CHAT_DB_SSL=true
```

## 🔧 Configuration Tuning

### For Small Deployments (< 10,000 users)
```env
SYNC_INTERVAL_MINUTES=1
SOURCE_DB_POOL_SIZE=5
CHAT_DB_POOL_SIZE=5
MAX_RETRIES=3
```

### For Medium Deployments (10,000 - 100,000 users)
```env
SYNC_INTERVAL_MINUTES=1
SOURCE_DB_POOL_SIZE=10
CHAT_DB_POOL_SIZE=10
MAX_RETRIES=5
SYNC_WINDOW_MULTIPLIER=3
```

### For Large Deployments (> 100,000 users)
```env
SYNC_INTERVAL_MINUTES=2
SOURCE_DB_POOL_SIZE=20
CHAT_DB_POOL_SIZE=20
MAX_RETRIES=5
SYNC_WINDOW_MULTIPLIER=3
```

## 📈 Performance Optimization

### Database Indexes

```sql
-- On source database (myusta_backend)
CREATE INDEX CONCURRENTLY idx_users_status_updated
ON users(status, updated_at DESC)
WHERE status = 'active';

CREATE INDEX CONCURRENTLY idx_users_id
ON users(id)
WHERE id IS NOT NULL;

-- On chat database (myusta_chatapp)
CREATE INDEX CONCURRENTLY idx_users_external_id
ON users("externalId");

CREATE INDEX CONCURRENTLY idx_users_updated_at
ON users("updatedAt" DESC);
```

### Connection Pool Monitoring

Add to your monitoring:
```javascript
// Log pool stats every 5 minutes
setInterval(() => {
    console.log('Pool Stats:', {
        source: {
            total: this.sourcePool.totalCount,
            idle: this.sourcePool.idleCount,
            waiting: this.sourcePool.waitingCount
        },
        chat: {
            total: this.chatPool.totalCount,
            idle: this.chatPool.idleCount,
            waiting: this.chatPool.waitingCount
        }
    });
}, 5 * 60 * 1000);
```

## 🚨 Alerting Setup

### Email Alerts (using nodemailer)

```bash
npm install nodemailer
```

Create `alert.js`:
```javascript
const nodemailer = require('nodemailer');

async function sendAlert(subject, message) {
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });

    await transporter.sendMail({
        from: 'sync-service@myusta.com',
        to: 'ops-team@myusta.com',
        subject: `[SYNC SERVICE] ${subject}`,
        text: message
    });
}

module.exports = { sendAlert };
```

### Slack Alerts (using webhook)

```javascript
const axios = require('axios');

async function sendSlackAlert(message) {
    await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: `🚨 User Sync Service Alert`,
        blocks: [{
            type: 'section',
            text: { type: 'mrkdwn', text: message }
        }]
    });
}
```

## 🔄 Backup & Recovery

### Database Backup Schedule

```bash
# Backup sync_errors table daily
0 2 * * * pg_dump -U postgres -d myusta_chatapp -t sync_errors -f /backups/sync_errors_$(date +\%Y\%m\%d).sql
```

### Recovery Procedure

If sync service fails and needs full resync:

```bash
# 1. Stop the service
pm2 stop user-sync-service

# 2. Clear chat database users (optional, for full refresh)
psql -U postgres -d myusta_chatapp -c "TRUNCATE TABLE users RESTART IDENTITY CASCADE;"

# 3. Run full sync
node sync.js sync-all

# 4. Verify counts match
node sync.js verify

# 5. Restart service
pm2 restart user-sync-service
```

## 📋 Pre-Deployment Checklist

- [ ] Database migrations applied
- [ ] `.env` file configured with correct credentials
- [ ] Database users have correct permissions
- [ ] Required indexes created
- [ ] Service starts without errors
- [ ] Health check passes
- [ ] Logs are accessible
- [ ] Monitoring is configured
- [ ] Alerting is set up (if applicable)
- [ ] Backup procedures in place
- [ ] Documentation reviewed by team
- [ ] Rollback plan prepared

## 🔍 Post-Deployment Validation

### Day 1
```bash
# Check service is running
pm2 status user-sync-service

# Verify sync counts
node sync.js verify

# Check error logs
psql -U postgres -d myusta_chatapp -c "SELECT COUNT(*) FROM sync_errors WHERE created_at > NOW() - INTERVAL '24 hours';"

# Monitor health
./health-check.sh
```

### Week 1
- Review error rates in `sync_errors` table
- Check average sync duration vs interval
- Verify no memory leaks (monitor process memory)
- Ensure connection pool is not exhausted
- Review database query performance

### Month 1
- Analyze error patterns
- Optimize slow queries if needed
- Adjust pool sizes based on usage
- Consider interval adjustment if syncs are slow
- Review and clean old error logs

## 🆘 Troubleshooting

### Service Won't Start
```bash
# Check Node.js version
node --version

# Check database connectivity
psql -U postgres -d myusta_backend -c "SELECT 1;"
psql -U postgres -d myusta_chatapp -c "SELECT 1;"

# Verify environment variables
cat .env | grep -v PASSWORD

# Check for port conflicts
lsof -i :5432
```

### High Error Rate
```sql
-- Find most common errors
SELECT error_type, COUNT(*), error_message
FROM sync_errors
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY error_type, error_message
ORDER BY COUNT(*) DESC
LIMIT 10;
```

### Slow Syncs
```sql
-- Check for table bloat
SELECT schemaname, tablename,
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE tablename = 'users';

-- Run VACUUM if needed
VACUUM ANALYZE users;
```

## 📞 Support Contacts

- **Technical Lead:** [Name]
- **DevOps Team:** ops@myusta.com
- **On-Call:** [Phone/Slack Channel]
- **Documentation:** README_IMPLEMENTATION.md

---

**Deployment Version:** 2.0.0
**Last Updated:** 2025-01-20
**Reviewed By:** [Your Name]
