// cache-reconciler.js - Sync service that monitors Redis cache and reconciles chat DB
// NEW ROLE (June 2026): Cache → Chat DB reconciliation every 15 seconds
const { Pool } = require('pg');
const Redis = require('ioredis');
const http = require('http');
require('dotenv').config();

class CacheReconcilerService {
  constructor() {
    // Redis configuration (same as chatserver-ai)
    this.redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB) || 0,
      keyPrefix: '', // No prefix - we read user:{id} directly
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3
    };

    // Chat database config (destination)
    this.chatDbConfig = {
      host: process.env.CHAT_DB_HOST || 'localhost',
      port: parseInt(process.env.CHAT_DB_PORT) || 5432,
      database: process.env.CHAT_DB_NAME || 'chat_app_02',
      user: process.env.CHAT_DB_USER || 'postgres',
      password: process.env.CHAT_DB_PASSWORD,
      max: parseInt(process.env.CHAT_DB_POOL_SIZE) || 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    // Initialize connections
    this.redis = new Redis(this.redisConfig);
    this.chatPool = new Pool(this.chatDbConfig);

    // Configuration
    this.syncIntervalSeconds = parseInt(process.env.SYNC_INTERVAL_SECONDS) || 15;
    this.userCachePrefix = 'user:';
    this.staleMissThreshold = parseInt(process.env.STALE_MISS_THRESHOLD) || 4; // Mark inactive after N consecutive misses

    // State tracking
    this.isRunning = false;
    this.isSyncInProgress = false;
    this.syncInterval = null;

    // Track consecutive cache misses per user (for deletion detection)
    this.cacheMissCount = new Map(); // userId -> count

    // Stats
    this.stats = {
      totalReconciled: 0,
      cacheHits: 0,
      cacheMisses: 0,
      usersUpdated: 0,
      usersMarkedInactive: 0,
      errors: 0,
      lastSyncTime: null,
      lastSyncDuration: null,
      lastSyncUserCount: 0
    };

    this.validateConfig();
    this.setupErrorHandlers();
  }

  validateConfig() {
    if (!process.env.CHAT_DB_PASSWORD) {
      console.error('❌ Missing required: CHAT_DB_PASSWORD');
      process.exit(1);
    }

    console.log('🔧 Cache Reconciler Configuration:');
    console.log(`   Redis: ${this.redisConfig.host}:${this.redisConfig.port}`);
    console.log(`   Chat DB: ${this.chatDbConfig.user}@${this.chatDbConfig.host}:${this.chatDbConfig.port}/${this.chatDbConfig.database}`);
    console.log(`   Sync Interval: ${this.syncIntervalSeconds} seconds`);
    console.log(`   Stale Threshold: ${this.staleMissThreshold} consecutive misses`);
  }

  setupErrorHandlers() {
    this.redis.on('error', (err) => {
      this.log('ERROR', `Redis error: ${err.message}`);
      this.stats.errors++;
    });

    this.redis.on('connect', () => {
      this.log('SUCCESS', 'Redis connected');
    });

    this.chatPool.on('error', (err) => {
      this.log('ERROR', `Chat DB pool error: ${err.message}`);
      this.stats.errors++;
    });
  }

  log(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const prefix = {
      'INFO': 'ℹ️',
      'SUCCESS': '✅',
      'WARNING': '⚠️',
      'ERROR': '❌',
      'DEBUG': '🔍'
    }[level] || 'ℹ️';

    console.log(`${prefix} [${timestamp}] ${message}`,
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '');
  }

  /**
   * Main reconciliation loop - runs every 15 seconds
   */
  async reconcile() {
    if (this.isSyncInProgress) {
      this.log('WARNING', 'Previous reconciliation still in progress, skipping');
      return;
    }

    const startTime = Date.now();
    this.isSyncInProgress = true;

    try {
      // Step 1: Get all users from chat DB
      const chatUsers = await this.getChatDbUsers();
      this.log('INFO', `Reconciling ${chatUsers.length} chat DB users against cache...`);

      // Step 2: Check cache for each user and reconcile
      let updated = 0;
      let markedInactive = 0;
      let cacheHits = 0;
      let cacheMisses = 0;

      for (const chatUser of chatUsers) {
        const externalId = chatUser.externalId;

        // Get user from Redis cache
        const cachedUser = await this.getCachedUser(externalId);

        if (cachedUser) {
          // Cache HIT - user exists in cache
          cacheHits++;
          this.cacheMissCount.delete(externalId); // Reset miss count

          // Check if data needs updating
          const needsUpdate = this.hasChanges(chatUser, cachedUser);
          if (needsUpdate) {
            await this.updateChatDbUser(externalId, cachedUser);
            updated++;
          }
        } else {
          // Cache MISS - user not in cache
          cacheMisses++;

          // Track consecutive misses
          const missCount = (this.cacheMissCount.get(externalId) || 0) + 1;
          this.cacheMissCount.set(externalId, missCount);

          // If missed N consecutive times, mark as inactive/deleted
          if (missCount >= this.staleMissThreshold) {
            await this.markUserInactive(externalId);
            markedInactive++;
            this.cacheMissCount.delete(externalId); // Reset after marking
          } else {
            this.log('DEBUG', `User ${externalId.substring(0, 8)}... cache miss ${missCount}/${this.staleMissThreshold}`);
          }
        }
      }

      // Update stats
      const duration = Date.now() - startTime;
      this.stats.totalReconciled++;
      this.stats.cacheHits += cacheHits;
      this.stats.cacheMisses += cacheMisses;
      this.stats.usersUpdated += updated;
      this.stats.usersMarkedInactive += markedInactive;
      this.stats.lastSyncTime = new Date();
      this.stats.lastSyncDuration = duration;
      this.stats.lastSyncUserCount = chatUsers.length;

      this.log('SUCCESS', `Reconciliation complete in ${duration}ms`, {
        users: chatUsers.length,
        cacheHits,
        cacheMisses,
        updated,
        markedInactive
      });

    } catch (error) {
      this.stats.errors++;
      this.log('ERROR', `Reconciliation failed: ${error.message}`);
    } finally {
      this.isSyncInProgress = false;
    }
  }

  /**
   * Get all active users from chat database
   */
  async getChatDbUsers() {
    const result = await this.chatPool.query(`
      SELECT
        id, "externalId", name, "firstName", "lastName", email, phone,
        avatar, role, "metaData", "preferredLanguage",
        "autoReplyEnabled", "autoReplyMessage", "updatedAt"
      FROM users
      WHERE "externalId" IS NOT NULL
      ORDER BY "updatedAt" DESC
    `);
    return result.rows;
  }

  /**
   * Get user from Redis cache
   */
  async getCachedUser(userId) {
    try {
      const cacheKey = `${this.userCachePrefix}${userId}`;
      const data = await this.redis.get(cacheKey);

      if (data) {
        return JSON.parse(data);
      }
      return null;
    } catch (error) {
      this.log('ERROR', `Failed to get cached user ${userId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if cached data differs from chat DB data
   * NOTE: preferredLanguage is EXCLUDED - it's synced directly via
   * /api/v1/users/:userId/language endpoint from myusta-backend.
   * Cache may have stale language data, so we don't use it here.
   */
  hasChanges(chatUser, cachedUser) {
    // Compare key fields
    const chatName = chatUser.name || '';
    const cachedName = cachedUser.name ||
      `${cachedUser.firstName || ''} ${cachedUser.lastName || ''}`.trim() || '';

    if (chatName !== cachedName) return true;
    if (chatUser.firstName !== cachedUser.firstName) return true;
    if (chatUser.lastName !== cachedUser.lastName) return true;
    if (chatUser.email !== cachedUser.email) return true;
    if (chatUser.phone !== cachedUser.phone) return true;
    if (chatUser.avatar !== cachedUser.avatarUrl) return true;
    // IMPORTANT: Do NOT compare preferredLanguage - it's synced via dedicated endpoint
    // and cache may have stale values that would overwrite correct language
    if (chatUser.autoReplyEnabled !== cachedUser.autoReplyEnabled) return true;
    if (chatUser.autoReplyMessage !== cachedUser.autoReplyMessage) return true;

    return false;
  }

  /**
   * Update user in chat DB with cached data
   * NOTE: preferredLanguage is EXCLUDED from updates - it's synced directly via
   * /api/v1/users/:userId/language endpoint from myusta-backend to avoid
   * overwriting correct language with stale cache data.
   */
  async updateChatDbUser(externalId, cachedUser) {
    try {
      const name = cachedUser.name ||
        `${cachedUser.firstName || ''} ${cachedUser.lastName || ''}`.trim() ||
        'Unknown User';

      await this.chatPool.query(`
        UPDATE users SET
          name = $1,
          "firstName" = $2,
          "lastName" = $3,
          email = $4,
          phone = $5,
          avatar = $6,
          role = $7,
          "autoReplyEnabled" = $8,
          "autoReplyMessage" = $9,
          "metaData" = "metaData" || $10::jsonb,
          "updatedAt" = NOW()
        WHERE "externalId" = $11
      `, [
        name,
        cachedUser.firstName || null,
        cachedUser.lastName || null,
        cachedUser.email || null,
        cachedUser.phone || null,
        cachedUser.avatarUrl || null,
        cachedUser.role || 'customer',
        cachedUser.autoReplyEnabled || false,
        cachedUser.autoReplyMessage || null,
        JSON.stringify({
          privacySettings: cachedUser.privacySettings,
          notificationPreference: cachedUser.notificationPreference,
          bio: cachedUser.bio,
          isVerified: cachedUser.isVerified,
          averageRating: cachedUser.averageRating,
          totalRatings: cachedUser.totalRatings,
          lastCacheSync: Date.now()
        }),
        externalId
      ]);

      this.log('DEBUG', `Updated user ${externalId.substring(0, 8)}... from cache`);
    } catch (error) {
      this.log('ERROR', `Failed to update user ${externalId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Mark user as inactive (not in cache for too long)
   */
  async markUserInactive(externalId) {
    try {
      // Update metaData to mark as inactive/potentially deleted
      await this.chatPool.query(`
        UPDATE users SET
          "metaData" = COALESCE("metaData", '{}'::jsonb) || $1::jsonb,
          "updatedAt" = NOW()
        WHERE "externalId" = $2
      `, [
        JSON.stringify({
          cacheStatus: 'not_found',
          markedInactiveAt: new Date().toISOString(),
          reason: 'User not found in cache for extended period'
        }),
        externalId
      ]);

      this.log('WARNING', `Marked user ${externalId.substring(0, 8)}... as inactive (cache miss threshold exceeded)`);
    } catch (error) {
      this.log('ERROR', `Failed to mark user ${externalId} inactive: ${error.message}`);
    }
  }

  /**
   * Start the reconciliation loop
   */
  start() {
    if (this.isRunning) {
      this.log('WARNING', 'Reconciler already running');
      return;
    }

    this.isRunning = true;
    this.log('SUCCESS', `Starting cache reconciler (every ${this.syncIntervalSeconds}s)...`);

    // Run immediately, then on interval
    this.reconcile();

    this.syncInterval = setInterval(() => {
      this.reconcile();
    }, this.syncIntervalSeconds * 1000);

    // Start HTTP server for health checks
    this.startHttpServer();
  }

  /**
   * Stop the reconciliation loop
   */
  stop() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.isRunning = false;
    this.log('INFO', 'Cache reconciler stopped');
  }

  /**
   * HTTP server for health checks
   */
  startHttpServer() {
    const port = parseInt(process.env.HTTP_PORT) || 9000;

    this.httpServer = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/health' || req.url === '/') {
        const isHealthy = this.isRunning && !this.isSyncInProgress;
        res.writeHead(isHealthy ? 200 : 503);
        res.end(JSON.stringify({
          status: isHealthy ? 'HEALTHY' : 'DEGRADED',
          service: 'cache-reconciler',
          timestamp: new Date().toISOString(),
          isRunning: this.isRunning,
          isSyncInProgress: this.isSyncInProgress,
          lastSync: this.stats.lastSyncTime?.toISOString() || null,
          lastSyncDurationMs: this.stats.lastSyncDuration
        }, null, 2));

      } else if (req.url === '/status') {
        res.writeHead(200);
        res.end(JSON.stringify({
          service: 'cache-reconciler',
          timestamp: new Date().toISOString(),
          config: {
            syncIntervalSeconds: this.syncIntervalSeconds,
            staleMissThreshold: this.staleMissThreshold
          },
          stats: this.stats,
          pendingMisses: Object.fromEntries(this.cacheMissCount)
        }, null, 2));

      } else if (req.url === '/metrics') {
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(`# Cache Reconciler Metrics
reconciler_total_runs ${this.stats.totalReconciled}
reconciler_cache_hits ${this.stats.cacheHits}
reconciler_cache_misses ${this.stats.cacheMisses}
reconciler_users_updated ${this.stats.usersUpdated}
reconciler_users_marked_inactive ${this.stats.usersMarkedInactive}
reconciler_errors ${this.stats.errors}
reconciler_last_sync_users ${this.stats.lastSyncUserCount}
reconciler_last_sync_duration_ms ${this.stats.lastSyncDuration || 0}
reconciler_is_running ${this.isRunning ? 1 : 0}
`);

      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not Found', endpoints: ['/health', '/status', '/metrics'] }));
      }
    });

    this.httpServer.listen(port, () => {
      this.log('SUCCESS', `HTTP server listening on port ${port}`);
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    this.log('WARNING', 'Shutting down cache reconciler...');

    this.stop();

    // Wait for in-progress sync
    if (this.isSyncInProgress) {
      this.log('INFO', 'Waiting for in-progress sync to complete...');
      await new Promise(resolve => {
        const check = setInterval(() => {
          if (!this.isSyncInProgress) {
            clearInterval(check);
            resolve();
          }
        }, 500);
      });
    }

    // Close connections
    if (this.httpServer) {
      await new Promise(resolve => this.httpServer.close(resolve));
    }
    await this.chatPool.end();
    await this.redis.quit();

    this.log('SUCCESS', 'Shutdown complete');
    this.log('INFO', 'Final stats:', this.stats);
  }
}

// Main execution
if (require.main === module) {
  const reconciler = new CacheReconcilerService();

  // Graceful shutdown handlers
  process.on('SIGINT', async () => {
    await reconciler.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await reconciler.shutdown();
    process.exit(0);
  });

  // Start the service
  reconciler.start();
}

module.exports = CacheReconcilerService;
