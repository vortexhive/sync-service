// userTableSync.js - Complete sync service for source -> chat database
// v2.0: Added cache reconciliation mode (June 2026)
const { Pool } = require('pg');
const Redis = require('ioredis');
const http = require('http');
require('dotenv').config();

class UserTableSyncService {
  constructor() {
    // Source database config with connection pooling
    this.sourceDbConfig = {
      host: process.env.SOURCE_DB_HOST || 'localhost',
      port: parseInt(process.env.SOURCE_DB_PORT) || 5432,
      database: process.env.SOURCE_DB_NAME || 'myusta_backend',
      user: process.env.SOURCE_DB_USER || 'postgres',
      password: process.env.SOURCE_DB_PASSWORD,
      max: parseInt(process.env.SOURCE_DB_POOL_SIZE) || 10, // Connection pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    // Destination database config (chat app) with connection pooling
    this.chatDbConfig = {
      host: process.env.CHAT_DB_HOST || 'localhost',
      port: parseInt(process.env.CHAT_DB_PORT) || 5432,
      database: process.env.CHAT_DB_NAME || 'myusta_chatapp',
      user: process.env.CHAT_DB_USER || 'postgres',
      password: process.env.CHAT_DB_PASSWORD,
      max: parseInt(process.env.CHAT_DB_POOL_SIZE) || 10, // Connection pool size
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

    // Initialize connection pools
    this.sourcePool = new Pool(this.sourceDbConfig);
    this.chatPool = new Pool(this.chatDbConfig);

    // Redis configuration for cache reconciliation mode
    this.redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB) || 0,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3
    };
    this.redis = null; // Lazy init
    this.userCachePrefix = 'user:';
    this.cacheMissCount = new Map(); // Track consecutive misses per user
    this.staleMissThreshold = parseInt(process.env.STALE_MISS_THRESHOLD) || 4;
    this.cacheMode = process.env.SYNC_MODE === 'cache'; // Enable with SYNC_MODE=cache
    // If true, users not in cache are immediately marked inactive (deleted from backend)
    // If false, wait for staleMissThreshold consecutive misses
    this.immediateInactive = process.env.IMMEDIATE_INACTIVE === 'true';

    // Circuit breaker for Redis failures - prevents mass deactivation on Redis outage
    this.redisCircuitBreaker = {
      failures: 0,
      maxFailures: parseInt(process.env.REDIS_MAX_FAILURES) || 3,
      isOpen: false,
      lastFailure: null,
      resetAfterMs: parseInt(process.env.REDIS_CIRCUIT_RESET_MS) || 60000 // 1 minute
    };

    // Enhanced telemetry for cache reconciliation
    this.telemetry = {
      totalReconciliations: 0,
      avgReconcileTimeMs: 0,
      avgCacheFetchTimeMs: 0,
      avgDbUpdateTimeMs: 0,
      lastReconciliation: null,
      reconciliationHistory: [], // Last 100 detailed reports
      operations: {
        fetchChatUsers: { count: 0, totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0 },
        fetchCachedUser: { count: 0, totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0 },
        compareChanges: { count: 0, totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0 },
        updateUser: { count: 0, totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0 },
        markInactive: { count: 0, totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0 },
        deactivateDuplicate: { count: 0, totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0 },
        closeUserSessions: { count: 0, totalMs: 0, avgMs: 0, minMs: Infinity, maxMs: 0 }
      }
    };

    // Real-time sync client (separate from pool)
    this.realtimeClient = null;
    this.realtimeReconnectAttempts = 0;
    this.maxReconnectAttempts = parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10;
    this.realtimeReconnectTimeout = null;

    // Sync state management
    this.isListening = false;
    this.isSyncInProgress = false; // Mutex for preventing concurrent syncs
    this.scheduledSyncTimeout = null;

    this.syncStats = {
      totalSynced: 0,
      lastSyncTime: null,
      lastSyncDuration: null,
      errors: 0,
      consecutiveFailures: 0,
      lastError: null,
      realtimeSyncActive: false,
      scheduledSyncActive: false
    };

    // Configuration
    this.retryConfig = {
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      initialDelayMs: parseInt(process.env.RETRY_INITIAL_DELAY) || 1000,
      maxDelayMs: parseInt(process.env.RETRY_MAX_DELAY) || 30000,
      backoffMultiplier: parseFloat(process.env.RETRY_BACKOFF_MULTIPLIER) || 2
    };

    // Support both SYNC_INTERVAL_SECONDS (preferred) and SYNC_INTERVAL_MINUTES (legacy)
    // SYNC_INTERVAL_SECONDS takes precedence for near real-time sync
    const intervalSeconds = parseInt(process.env.SYNC_INTERVAL_SECONDS);
    const intervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 1;
    this.syncIntervalSeconds = intervalSeconds || (intervalMinutes * 60);
    this.syncIntervalMinutes = this.syncIntervalSeconds / 60; // Keep for backward compat
    this.syncWindowMultiplier = parseInt(process.env.SYNC_WINDOW_MULTIPLIER) || 3; // Look back 3x interval

    // Validate required environment variables
    this.validateConfig();

    // Setup pool error handlers
    this.setupPoolErrorHandlers();
  }

  setupPoolErrorHandlers() {
    this.sourcePool.on('error', (err) => {
      console.error('❌ Unexpected error on source database pool:', err);
      this.logError('POOL_ERROR', null, err);
    });

    this.chatPool.on('error', (err) => {
      console.error('❌ Unexpected error on chat database pool:', err);
      this.logError('POOL_ERROR', null, err);
    });
  }

  // Connection pool health check with auto-recovery
  async checkPoolHealth() {
    const healthCheckTimeout = 5000; // 5 second timeout for health checks
    const results = {
      source: { healthy: false, latency: null, error: null },
      chat: { healthy: false, latency: null, error: null }
    };

    // Check source pool
    try {
      const startSource = Date.now();
      const sourceClient = await Promise.race([
        this.sourcePool.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), healthCheckTimeout))
      ]);
      await sourceClient.query('SELECT 1');
      sourceClient.release();
      results.source.healthy = true;
      results.source.latency = Date.now() - startSource;
    } catch (err) {
      results.source.error = err.message;
      this.log('ERROR', `Source pool health check failed: ${err.message}`);
    }

    // Check chat pool
    try {
      const startChat = Date.now();
      const chatClient = await Promise.race([
        this.chatPool.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), healthCheckTimeout))
      ]);
      await chatClient.query('SELECT 1');
      chatClient.release();
      results.chat.healthy = true;
      results.chat.latency = Date.now() - startChat;
    } catch (err) {
      results.chat.error = err.message;
      this.log('ERROR', `Chat pool health check failed: ${err.message}`);
    }

    return results;
  }

  // Reset connection pools (recreate them)
  async resetPools() {
    this.log('WARNING', 'Resetting database connection pools...');

    try {
      // End existing pools gracefully
      await Promise.allSettled([
        this.sourcePool.end(),
        this.chatPool.end()
      ]);

      // Wait a moment for connections to close
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Recreate pools
      this.sourcePool = new Pool(this.sourceDbConfig);
      this.chatPool = new Pool(this.chatDbConfig);

      // Re-setup error handlers
      this.setupPoolErrorHandlers();

      // Reset consecutive failures
      this.syncStats.consecutiveFailures = 0;

      this.log('SUCCESS', 'Connection pools reset successfully');
      return true;
    } catch (err) {
      this.log('ERROR', `Failed to reset pools: ${err.message}`);
      return false;
    }
  }

  // Auto-recovery: check health and reset if needed
  async autoRecover() {
    const maxConsecutiveFailures = parseInt(process.env.MAX_CONSECUTIVE_FAILURES) || 10;

    if (this.syncStats.consecutiveFailures >= maxConsecutiveFailures) {
      this.log('WARNING', `Consecutive failures (${this.syncStats.consecutiveFailures}) exceeded threshold (${maxConsecutiveFailures}). Attempting auto-recovery...`);

      const health = await this.checkPoolHealth();

      if (!health.source.healthy || !health.chat.healthy) {
        this.log('WARNING', 'Pool health check failed, resetting pools...');
        await this.resetPools();

        // Re-check health after reset
        const healthAfterReset = await this.checkPoolHealth();
        if (healthAfterReset.source.healthy && healthAfterReset.chat.healthy) {
          this.log('SUCCESS', 'Auto-recovery successful - pools are healthy');
          return true;
        } else {
          this.log('ERROR', 'Auto-recovery failed - pools still unhealthy');
          return false;
        }
      }
    }
    return true;
  }

  // Start periodic pool health check
  startPoolHealthCheck() {
    const healthCheckIntervalMs = parseInt(process.env.POOL_HEALTH_CHECK_INTERVAL) || 60000; // Default: 1 minute

    this.poolHealthCheckInterval = setInterval(async () => {
      const health = await this.checkPoolHealth();

      // Log pool stats
      const sourceStats = this.sourcePool.totalCount !== undefined ? {
        total: this.sourcePool.totalCount,
        idle: this.sourcePool.idleCount,
        waiting: this.sourcePool.waitingCount
      } : 'N/A';

      const chatStats = this.chatPool.totalCount !== undefined ? {
        total: this.chatPool.totalCount,
        idle: this.chatPool.idleCount,
        waiting: this.chatPool.waitingCount
      } : 'N/A';

      if (!health.source.healthy || !health.chat.healthy) {
        this.log('WARNING', `Pool health check: Source=${health.source.healthy ? 'OK' : 'FAIL'}, Chat=${health.chat.healthy ? 'OK' : 'FAIL'}`);
        await this.autoRecover();
      } else {
        // Only log detailed stats every 5 minutes to reduce noise
        if (Date.now() % 300000 < healthCheckIntervalMs) {
          this.log('INFO', `Pool health: Source(${health.source.latency}ms), Chat(${health.chat.latency}ms)`);
        }
      }
    }, healthCheckIntervalMs);

    this.log('INFO', `Pool health check started (interval: ${healthCheckIntervalMs / 1000}s)`);
  }

  stopPoolHealthCheck() {
    if (this.poolHealthCheckInterval) {
      clearInterval(this.poolHealthCheckInterval);
      this.poolHealthCheckInterval = null;
      this.log('INFO', 'Pool health check stopped');
    }
  }

  validateConfig() {
    const requiredVars = [
      'SOURCE_DB_PASSWORD',
      'CHAT_DB_PASSWORD'
    ];

    const missing = requiredVars.filter(varName => !process.env[varName]);

    if (missing.length > 0) {
      console.error('❌ Missing required environment variables:');
      missing.forEach(varName => console.error(`   - ${varName}`));
      console.error('\nPlease check your .env file');
      process.exit(1);
    }

    // Log configuration (without passwords)
    console.log('🔧 Database Configuration:');
    console.log(`   Source: ${this.sourceDbConfig.user}@${this.sourceDbConfig.host}:${this.sourceDbConfig.port}/${this.sourceDbConfig.database} (Pool: ${this.sourceDbConfig.max})`);
    console.log(`   Chat: ${this.chatDbConfig.user}@${this.chatDbConfig.host}:${this.chatDbConfig.port}/${this.chatDbConfig.database} (Pool: ${this.chatDbConfig.max})`);
    const intervalDisplay = this.syncIntervalSeconds < 60
      ? `${this.syncIntervalSeconds} second(s)`
      : `${this.syncIntervalMinutes} minute(s)`;
    const windowDisplay = this.syncIntervalSeconds * this.syncWindowMultiplier < 60
      ? `${this.syncIntervalSeconds * this.syncWindowMultiplier} second(s)`
      : `${this.syncIntervalMinutes * this.syncWindowMultiplier} minute(s)`;
    console.log(`   Sync Interval: ${intervalDisplay}`);
    console.log(`   Sync Window: ${windowDisplay} lookback`);
  }

  // Structured logging helper
  log(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();

    const prefix = {
      'INFO': 'ℹ️',
      'SUCCESS': '✅',
      'WARNING': '⚠️',
      'ERROR': '❌',
      'DEBUG': '🔍'
    }[level] || 'ℹ️';

    console.log(`${prefix} [${timestamp}] ${message}`, metadata.details ? JSON.stringify(metadata.details, null, 2) : '');
  }

  // Error logging with persistence
  async logError(errorType, userId, error, additionalData = {}) {
    const errorRecord = {
      timestamp: new Date(),
      errorType,
      userId,
      errorMessage: error.message || String(error),
      errorStack: error.stack || null,
      ...additionalData
    };

    // Log to console
    this.log('ERROR', `${errorType}: ${errorRecord.errorMessage}`, { userId, ...additionalData });

    // Persist to database
    try {
      await this.chatPool.query(`
        INSERT INTO sync_errors (
          error_type, user_id, error_message, error_stack,
          additional_data, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        errorType,
        userId,
        errorRecord.errorMessage,
        errorRecord.errorStack,
        JSON.stringify(additionalData),
        errorRecord.timestamp
      ]);
    } catch (dbError) {
      // Fallback if error table doesn't exist yet
      console.error('Failed to persist error to database:', dbError.message);
    }

    // Update stats
    this.syncStats.errors++;
    this.syncStats.consecutiveFailures++;
    this.syncStats.lastError = errorRecord;
  }

  // Retry logic with exponential backoff
  async retryWithBackoff(operation, context = '') {
    let lastError;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = Math.min(
            this.retryConfig.initialDelayMs * Math.pow(this.retryConfig.backoffMultiplier, attempt - 1),
            this.retryConfig.maxDelayMs
          );
          this.log('WARNING', `Retry attempt ${attempt}/${this.retryConfig.maxRetries} for ${context} after ${delay}ms`);
          await this.sleep(delay);
        }

        const result = await operation();

        // Reset consecutive failures on success
        if (attempt > 0) {
          this.log('SUCCESS', `${context} succeeded after ${attempt} retry attempts`);
        }
        this.syncStats.consecutiveFailures = 0;

        return result;
      } catch (error) {
        lastError = error;
        this.log('WARNING', `${context} failed (attempt ${attempt + 1}/${this.retryConfig.maxRetries + 1}): ${error.message}`);
      }
    }

    throw lastError;
  }

  // Sleep helper
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Transform source user data to chat user format
  transformUserData(sourceUser) {
    return {
      id: sourceUser.id,
      externalId: sourceUser.id, // Use same ID as external ID
      name: this.buildFullName(sourceUser),
      phone: this.sanitizePhone(sourceUser.phone, sourceUser.id),
      email: sourceUser.email_verified ? sourceUser.email : null, // Only sync verified emails
      role: this.mapRole(sourceUser.role),
      socketId: null, // Chat-specific, will be set by chat server
      isOnline: false, // Chat-specific, will be managed by chat server
      lastSeen: null, // Chat-specific, will be managed by chat server
      avatar: sourceUser.profile_picture,
      metaData: this.buildMetaData(sourceUser),
      createdAt: sourceUser.created_at,
      updatedAt: sourceUser.updated_at,
      firstName: sourceUser.first_name,
      lastName: sourceUser.last_name,
      preferredLanguage: this.normalizeLanguage(sourceUser.preferred_language), // Normalize 'al' to 'sq'
      // Auto-reply settings (synced as separate columns for efficient querying)
      autoReplyEnabled: sourceUser.auto_reply_enabled || false,
      autoReplyMessage: sourceUser.auto_reply_message || null
    };
  }

  // Build full name from first_name and last_name
  buildFullName(user) {
    const firstName = user.first_name?.trim() || '';
    const lastName = user.last_name?.trim() || '';
    
    if (firstName && lastName) {
      return `${firstName} ${lastName}`;
    } else if (firstName) {
      return firstName;
    } else if (lastName) {
      return lastName;
    } else {
      return `User ${user.id.substring(0, 8)}`; // Fallback with partial ID
    }
  }

  // Sanitize phone number - ensure it's never null and unique
  sanitizePhone(phone, userId) {
    if (!phone || phone.trim() === '') {
      // Generate a unique numeric placeholder phone using user ID
      const hexPart = userId.replace(/-/g, '').substring(0, 8);
      const numericPart = parseInt(hexPart, 16).toString().substring(0, 9);
      return `9${numericPart.padStart(9, '0')}`;
    }
    
    // Clean up phone number format - keep only digits
    const cleaned = phone.toString().replace(/[^\d]/g, '');
    
    // If it's empty after cleaning, use unique placeholder
    if (cleaned === '') {
      const hexPart = userId.replace(/-/g, '').substring(0, 8);
      const numericPart = parseInt(hexPart, 16).toString().substring(0, 9);
      return `9${numericPart.padStart(9, '0')}`;
    }
    
    return cleaned;
  }

  // Normalize language code - maps 'al' to 'sq' (both represent Albanian)
  // Mobile app sends 'al', but notification system uses 'sq'
  normalizeLanguage(lang) {
    if (!lang || typeof lang !== 'string') {
      return 'en'; // Default to English
    }
    const lower = lang.trim().toLowerCase();
    if (!lower) {
      return 'en';
    }
    // Map 'al' to 'sq' for Albanian
    return lower === 'al' ? 'sq' : lower;
  }

  // Map source roles to chat roles
  mapRole(sourceRole) {
    const roleMapping = {
      'customer': 'customer',
      'usta': 'usta',  // Direct mapping for 'usta' role
      'service_provider': 'usta',
      'provider': 'usta',
      'admin': 'administrator',
      'administrator': 'administrator',
      'super_admin': 'administrator'
    };

    return roleMapping[sourceRole?.toLowerCase()] || 'customer';
  }

  // Build metadata object from source user fields
  buildMetaData(user) {
    // Parse notification_preference JSON if string
    let notificationPreference = user.notification_preference;
    if (typeof notificationPreference === 'string') {
      try {
        notificationPreference = JSON.parse(notificationPreference);
      } catch (e) {
        notificationPreference = null;
      }
    }

    // Build notification settings - prefer new structure, fallback to legacy
    const notificationSettings = notificationPreference?.channels ? {
      app: notificationPreference.channels.app ?? true,
      email: notificationPreference.channels.email ?? true,
      sms: notificationPreference.channels.sms ?? false
    } : {
      app: user.notification_via_app !== null ? user.notification_via_app : true,
      email: user.notification_via_email !== null ? user.notification_via_email : true,
      sms: user.notification_via_sms !== null ? user.notification_via_sms : false
    };

    // Default notification preference structure (used if none exists)
    const defaultNotificationPreference = {
      channels: notificationSettings,
      categories: {
        jobs: { enabled: true, channels: ['push', 'email'] },
        activity: { enabled: true, channels: ['push', 'email'] },
        contracts: { enabled: true, channels: ['push', 'email'] },
        payments: { enabled: true, channels: ['push', 'email'] },
        security: { enabled: true, channels: ['push', 'email'] },
        reminders: { enabled: true, channels: ['push'] },
        chat: { enabled: true, channels: ['push'] }
      },
      events: {}
    };

    // Parse security_settings JSON if string
    let securitySettings = user.security_settings;
    if (typeof securitySettings === 'string') {
      try {
        securitySettings = JSON.parse(securitySettings);
      } catch (e) {
        securitySettings = null;
      }
    }

    // Parse privacy_settings JSON if string
    let privacySettings = user.privacy_settings;
    if (typeof privacySettings === 'string') {
      try {
        privacySettings = JSON.parse(privacySettings);
      } catch (e) {
        privacySettings = null;
      }
    }

    // Parse preferred_job_types JSON if string
    let preferredJobTypes = user.preferred_job_types;
    if (typeof preferredJobTypes === 'string') {
      try {
        preferredJobTypes = JSON.parse(preferredJobTypes);
      } catch (e) {
        preferredJobTypes = [];
      }
    }

    // Parse job_budget JSON if string
    let jobBudget = user.job_budget;
    if (typeof jobBudget === 'string') {
      try {
        jobBudget = JSON.parse(jobBudget);
      } catch (e) {
        jobBudget = null;
      }
    }

    // Default security settings (including loginAlerts)
    const defaultSecuritySettings = {
      twoFactorEnabled: false,
      twoFactorMethods: { email: false, sms: false },
      loginAlerts: { email: true, push: true, sms: false }
    };

    // Default privacy settings
    const defaultPrivacySettings = {
      showOnlineStatus: true,
      lastSeenVisibility: 'everyone'
    };

    return {
      emailVerified: user.email_verified || false,
      phoneVerified: user.phone_verified || false,
      authProvider: user.auth_provider,
      googleId: user.google_id,
      facebookId: user.facebook_id,
      status: user.status,
      accountStatus: user.account_status || 'active',
      customerPreferences: user.customer_preferences,

      // Legacy field - kept for backward compatibility
      notificationSettings,

      // NEW: Full notification preferences with categories and events
      notificationPreference: notificationPreference || defaultNotificationPreference,

      // Security settings (includes loginAlerts for device login notifications)
      securitySettings: securitySettings || defaultSecuritySettings,

      // Privacy settings (online status visibility)
      privacySettings: privacySettings || defaultPrivacySettings,

      // Job preferences (for USTA matching)
      preferredJobTypes: preferredJobTypes || [],
      jobBudget: jobBudget || { min: 0, max: 500000, currency: 'ALL' },

      termsAccepted: user.terms_and_conditions || false,
      ratings: {
        average: user.average_rating || null,
        total: user.total_ratings || 0,
        totalHires: user.total_hires || 0,
        totalViews: user.total_views || 0,
        lastHiredAt: user.last_hired_at || null
      },
      verification: {
        isVerified: user.is_verified || false,
        isFeatured: user.is_featured || false,
        searchBoost: user.search_boost || 0
      },
      bio: user.bio || null,
      hasPassword: !!user.password,

      // Auto-reply settings (BE_21) - for automated message responses
      autoReply: {
        enabled: user.auto_reply_enabled || false,
        message: user.auto_reply_message || null
      }
    };
  }

  // Sync ALL users from source to chat (complete refresh)
  async syncAllUsers() {
    const startTime = Date.now();
    this.log('INFO', 'Starting complete sync of ALL users...');

    try {
      this.log('INFO', 'Getting total user count...');
      const countResult = await this.sourcePool.query("SELECT COUNT(*) as count FROM users WHERE status IN ('active', 'pending_completion', 'pending_verification')");
      const totalUsers = parseInt(countResult.rows[0].count);

      this.log('INFO', `Found ${totalUsers.toLocaleString()} users to sync (active + pending)`);

      const limit = 1000;
      let offset = 0;
      let totalSynced = 0;
      let totalErrors = 0;

      while (offset < totalUsers) {
        this.log('INFO', `Processing batch ${Math.floor(offset/limit) + 1} (${offset + 1}-${Math.min(offset + limit, totalUsers)} of ${totalUsers})...`);

        const query = `
          SELECT
            id, first_name, last_name, email, phone, email_verified,
            phone_verified, password, auth_provider, google_id, facebook_id,
            role, status, customer_preferences, profile_picture,
            notification_via_app, notification_via_email, notification_via_sms,
            notification_preference, security_settings, privacy_settings,
            account_status, preferred_job_types, job_budget,
            terms_and_conditions, average_rating, total_ratings, total_hires,
            total_views, last_hired_at, is_verified, is_featured, search_boost,
            created_at, updated_at, bio,
            auto_reply_enabled, auto_reply_message, preferred_language
          FROM users
          WHERE status IN ('active', 'pending_completion', 'pending_verification') AND id IS NOT NULL
          ORDER BY id
          LIMIT $1 OFFSET $2
        `;

        const result = await this.sourcePool.query(query, [limit, offset]);
        const users = result.rows;

        let batchSynced = 0;
        let batchErrors = 0;

        for (const user of users) {
          try {
            await this.retryWithBackoff(async () => {
              const transformedUser = this.transformUserData(user);

              await this.chatPool.query(`
                INSERT INTO users (
                  id, "externalId", name, phone, email, role, "socketId",
                  "isOnline", "lastSeen", avatar, "metaData", "createdAt",
                  "updatedAt", "firstName", "lastName", "preferredLanguage",
                  "autoReplyEnabled", "autoReplyMessage"
                ) VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
                )
                ON CONFLICT ("externalId") DO UPDATE SET
                  name = EXCLUDED.name,
                  phone = EXCLUDED.phone,
                  email = EXCLUDED.email,
                  role = EXCLUDED.role,
                  avatar = EXCLUDED.avatar,
                  "metaData" = EXCLUDED."metaData",
                  "updatedAt" = EXCLUDED."updatedAt",
                  "firstName" = EXCLUDED."firstName",
                  "lastName" = EXCLUDED."lastName",
                  "preferredLanguage" = EXCLUDED."preferredLanguage",
                  "autoReplyEnabled" = EXCLUDED."autoReplyEnabled",
                  "autoReplyMessage" = EXCLUDED."autoReplyMessage"
              `, [
                transformedUser.id,
                transformedUser.externalId,
                transformedUser.name,
                transformedUser.phone,
                transformedUser.email,
                transformedUser.role,
                transformedUser.socketId,
                transformedUser.isOnline,
                transformedUser.lastSeen,
                transformedUser.avatar,
                JSON.stringify(transformedUser.metaData),
                transformedUser.createdAt,
                transformedUser.updatedAt,
                transformedUser.firstName,
                transformedUser.lastName,
                transformedUser.preferredLanguage,
                transformedUser.autoReplyEnabled,
                transformedUser.autoReplyMessage
              ]);
            }, `sync user ${user.id}`);

            batchSynced++;
          } catch (error) {
            await this.logError('SYNC_USER_FAILED', user.id, error, {
              userName: `${user.first_name} ${user.last_name}`,
              userEmail: user.email
            });
            batchErrors++;
          }
        }

        totalSynced += batchSynced;
        totalErrors += batchErrors;

        this.log('SUCCESS', `Batch completed: ${batchSynced} synced, ${batchErrors} errors`);
        this.log('INFO', `Progress: ${totalSynced}/${totalUsers} users (${Math.round((totalSynced/totalUsers)*100)}%)`);

        offset += limit;
      }

      this.syncStats.totalSynced += totalSynced;
      this.syncStats.errors += totalErrors;
      this.syncStats.lastSyncTime = new Date();
      this.syncStats.lastSyncDuration = Date.now() - startTime;

      this.log('SUCCESS', `ALL USERS SYNC COMPLETED! Synced: ${totalSynced.toLocaleString()}, Errors: ${totalErrors.toLocaleString()}, Duration: ${Math.round(this.syncStats.lastSyncDuration / 1000)}s`);

      return { synced: totalSynced, errors: totalErrors };

    } catch (error) {
      await this.logError('COMPLETE_SYNC_FAILED', null, error);
      throw error;
    }
  }

  // Upsert single user to chat database (used by real-time sync)
  async upsertUser(userData) {
    try {
      return await this.retryWithBackoff(async () => {
        const transformedUser = this.transformUserData(userData);

        const query = `
          INSERT INTO users (
            id, "externalId", name, phone, email, role, "socketId",
            "isOnline", "lastSeen", avatar, "metaData", "createdAt",
            "updatedAt", "firstName", "lastName", "preferredLanguage",
            "autoReplyEnabled", "autoReplyMessage"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
          )
          ON CONFLICT ("externalId") DO UPDATE SET
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            role = EXCLUDED.role,
            avatar = EXCLUDED.avatar,
            "metaData" = EXCLUDED."metaData",
            "updatedAt" = EXCLUDED."updatedAt",
            "firstName" = EXCLUDED."firstName",
            "lastName" = EXCLUDED."lastName",
            "preferredLanguage" = EXCLUDED."preferredLanguage",
            "autoReplyEnabled" = EXCLUDED."autoReplyEnabled",
            "autoReplyMessage" = EXCLUDED."autoReplyMessage"
          RETURNING id;
        `;

        const values = [
          transformedUser.id,
          transformedUser.externalId,
          transformedUser.name,
          transformedUser.phone,
          transformedUser.email,
          transformedUser.role,
          transformedUser.socketId,
          transformedUser.isOnline,
          transformedUser.lastSeen,
          transformedUser.avatar,
          JSON.stringify(transformedUser.metaData),
          transformedUser.createdAt,
          transformedUser.updatedAt,
          transformedUser.firstName,
          transformedUser.lastName,
          transformedUser.preferredLanguage,
          transformedUser.autoReplyEnabled,
          transformedUser.autoReplyMessage
        ];

        const result = await this.chatPool.query(query, values);

        this.log('SUCCESS', `User synced: ${transformedUser.name} (${transformedUser.id})`);
        this.syncStats.totalSynced++;

        return result.rows[0];
      }, `upsert user ${userData.id}`);

    } catch (error) {
      await this.logError('UPSERT_USER_FAILED', userData.id, error, {
        userName: `${userData.first_name} ${userData.last_name}`,
        userEmail: userData.email,
        userPhone: userData.phone
      });
      throw error;
    }
  }

  // Bulk sync users with pagination
  async bulkSyncUsers(limit = 1000, offset = 0, sinceDate = null) {
    try {
      // Build query with optional date filter - only sync active users with valid data
      let whereClause = "WHERE status IN ('active', 'pending_completion', 'pending_verification') AND id IS NOT NULL";
      const queryParams = [limit, offset];

      if (sinceDate) {
        whereClause += " AND updated_at > $3";
        queryParams.push(sinceDate);
      }

      const query = `
        SELECT
          id, first_name, last_name, email, phone, email_verified,
          phone_verified, password, auth_provider, google_id, facebook_id,
          role, status, customer_preferences, profile_picture,
          notification_via_app, notification_via_email, notification_via_sms,
          notification_preference, security_settings, privacy_settings,
          account_status, preferred_job_types, job_budget,
          terms_and_conditions, average_rating, total_ratings, total_hires,
          total_views, last_hired_at, is_verified, is_featured, search_boost,
          created_at, updated_at, bio,
          auto_reply_enabled, auto_reply_message, preferred_language
        FROM users
        ${whereClause}
        ORDER BY updated_at DESC
        LIMIT $1 OFFSET $2
      `;

      const result = await this.sourcePool.query(query, queryParams);
      const users = result.rows;

      if (users.length === 0) {
        this.log('INFO', 'No users to sync');
        return false;
      }

      this.log('INFO', `Syncing ${users.length} users (offset: ${offset})...`);

      // Batch upsert users
      let successCount = 0;
      let errorCount = 0;

      for (const user of users) {
        try {
          await this.retryWithBackoff(async () => {
            const transformedUser = this.transformUserData(user);

            await this.chatPool.query(`
              INSERT INTO users (
                id, "externalId", name, phone, email, role, "socketId",
                "isOnline", "lastSeen", avatar, "metaData", "createdAt",
                "updatedAt", "firstName", "lastName", "preferredLanguage",
                "autoReplyEnabled", "autoReplyMessage"
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
              )
              ON CONFLICT ("externalId") DO UPDATE SET
                name = EXCLUDED.name,
                phone = EXCLUDED.phone,
                email = EXCLUDED.email,
                role = EXCLUDED.role,
                avatar = EXCLUDED.avatar,
                "metaData" = EXCLUDED."metaData",
                "updatedAt" = EXCLUDED."updatedAt",
                "firstName" = EXCLUDED."firstName",
                "lastName" = EXCLUDED."lastName",
                "preferredLanguage" = EXCLUDED."preferredLanguage",
                "autoReplyEnabled" = EXCLUDED."autoReplyEnabled",
                "autoReplyMessage" = EXCLUDED."autoReplyMessage"
            `, [
              transformedUser.id,
              transformedUser.externalId,
              transformedUser.name,
              transformedUser.phone,
              transformedUser.email,
              transformedUser.role,
              transformedUser.socketId,
              transformedUser.isOnline,
              transformedUser.lastSeen,
              transformedUser.avatar,
              JSON.stringify(transformedUser.metaData),
              transformedUser.createdAt,
              transformedUser.updatedAt,
              transformedUser.firstName,
              transformedUser.lastName,
              transformedUser.preferredLanguage,
              transformedUser.autoReplyEnabled,
              transformedUser.autoReplyMessage
            ]);
          }, `bulk sync user ${user.id}`);

          successCount++;
        } catch (error) {
          await this.logError('BULK_SYNC_USER_FAILED', user.id, error, {
            userName: `${user.first_name} ${user.last_name}`,
            userEmail: user.email
          });
          errorCount++;
        }
      }

      this.log('SUCCESS', `Batch sync completed: ${successCount} success, ${errorCount} errors`);
      this.syncStats.totalSynced += successCount;
      this.syncStats.errors += errorCount;
      this.syncStats.lastSyncTime = new Date();

      return users.length === limit; // Return true if there might be more records

    } catch (error) {
      await this.logError('BULK_SYNC_FAILED', null, error, { limit, offset, sinceDate });
      throw error;
    }
  }

  // Real-time sync using PostgreSQL LISTEN/NOTIFY with auto-reconnection
  async startRealTimeSync() {
    if (this.isListening) {
      this.log('INFO', 'Real-time sync already active');
      return;
    }

    try {
      // Clean up any existing client
      if (this.realtimeClient) {
        try {
          await this.realtimeClient.end();
        } catch (e) {
          // Ignore errors from ending a potentially broken connection
        }
        this.realtimeClient = null;
      }

      // Create dedicated client for LISTEN (not from pool)
      const { Client } = require('pg');
      this.realtimeClient = new Client(this.sourceDbConfig);

      await this.realtimeClient.connect();
      this.log('SUCCESS', 'Real-time sync client connected');

      // Create trigger function if not exists
      await this.realtimeClient.query(`
        CREATE OR REPLACE FUNCTION notify_user_changes()
        RETURNS TRIGGER AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            PERFORM pg_notify('user_changes', json_build_object(
              'operation', TG_OP,
              'id', OLD.id
            )::text);
            RETURN OLD;
          ELSE
            PERFORM pg_notify('user_changes', json_build_object(
              'operation', TG_OP,
              'data', row_to_json(NEW)
            )::text);
            RETURN NEW;
          END IF;
        END;
        $$ LANGUAGE plpgsql;
      `);

      // Create trigger if not exists
      await this.realtimeClient.query(`
        DROP TRIGGER IF EXISTS user_changes_trigger ON users;
        CREATE TRIGGER user_changes_trigger
        AFTER INSERT OR UPDATE OR DELETE ON users
        FOR EACH ROW EXECUTE FUNCTION notify_user_changes();
      `);

      // Listen for notifications
      await this.realtimeClient.query('LISTEN user_changes');

      // Handle notifications
      this.realtimeClient.on('notification', async (msg) => {
        try {
          const payload = JSON.parse(msg.payload);

          if (payload.operation === 'DELETE') {
            // Handle user deletion
            await this.deleteUserFromChat(payload.id);
          } else if (payload.data && payload.data.status === 'active') {
            // Only sync active users
            await this.upsertUser(payload.data);
          }
        } catch (error) {
          await this.logError('REALTIME_NOTIFICATION_FAILED', payload?.data?.id || payload?.id, error);
        }
      });

      // Handle connection errors and reconnect
      this.realtimeClient.on('error', async (err) => {
        this.log('ERROR', 'Real-time sync connection error', { details: err.message });
        this.isListening = false;
        this.syncStats.realtimeSyncActive = false;
        await this.attemptRealtimeReconnection();
      });

      // Handle unexpected disconnections
      this.realtimeClient.on('end', async () => {
        if (this.isListening) {
          this.log('WARNING', 'Real-time sync connection ended unexpectedly');
          this.isListening = false;
          this.syncStats.realtimeSyncActive = false;
          await this.attemptRealtimeReconnection();
        }
      });

      this.isListening = true;
      this.syncStats.realtimeSyncActive = true;
      this.realtimeReconnectAttempts = 0; // Reset on successful connection
      this.log('SUCCESS', 'Real-time sync started - listening for user changes...');

    } catch (error) {
      await this.logError('REALTIME_SYNC_START_FAILED', null, error);
      await this.attemptRealtimeReconnection();
      throw error;
    }
  }

  // Attempt to reconnect real-time sync with exponential backoff
  async attemptRealtimeReconnection() {
    if (this.realtimeReconnectAttempts >= this.maxReconnectAttempts) {
      this.log('ERROR', `Real-time sync reconnection failed after ${this.maxReconnectAttempts} attempts. Manual intervention required.`);
      return;
    }

    this.realtimeReconnectAttempts++;

    const delay = Math.min(
      this.retryConfig.initialDelayMs * Math.pow(this.retryConfig.backoffMultiplier, this.realtimeReconnectAttempts - 1),
      this.retryConfig.maxDelayMs
    );

    this.log('WARNING', `Attempting to reconnect real-time sync (attempt ${this.realtimeReconnectAttempts}/${this.maxReconnectAttempts}) in ${delay}ms...`);

    this.realtimeReconnectTimeout = setTimeout(async () => {
      try {
        await this.startRealTimeSync();
      } catch (error) {
        this.log('ERROR', `Reconnection attempt ${this.realtimeReconnectAttempts} failed: ${error.message}`);
      }
    }, delay);
  }

  // Delete user from chat database
  async deleteUserFromChat(userId) {
    try {
      await this.retryWithBackoff(async () => {
        const result = await this.chatPool.query(`
          DELETE FROM users WHERE "externalId" = $1 RETURNING id
        `, [userId]);

        if (result.rows.length > 0) {
          this.log('SUCCESS', `User deleted from chat: ${userId}`);
        }
      }, `delete user ${userId}`);

    } catch (error) {
      await this.logError('DELETE_USER_FAILED', userId, error);
    }
  }

  // Scheduled incremental sync with mutex to prevent overlapping syncs
  async startScheduledSync(intervalMinutes = null) {
    // Use configured interval if not specified
    intervalMinutes = intervalMinutes || this.syncIntervalMinutes;

    const runScheduledSync = async () => {
      const startTime = Date.now();

      // Check if previous sync is still running
      if (this.isSyncInProgress) {
        this.log('WARNING', 'Previous sync still in progress, skipping this interval. Consider increasing sync interval.');
        this.scheduleNextSync(intervalMinutes);
        return;
      }

      try {
        this.isSyncInProgress = true;
        this.syncStats.scheduledSyncActive = true;

        // Look back 3x the interval to ensure overlap and catch any missed updates
        // Uses seconds-based calculation for near real-time sync support
        const lookbackSeconds = this.syncIntervalSeconds * this.syncWindowMultiplier;
        const since = new Date(Date.now() - lookbackSeconds * 1000);
        const lookbackDisplay = lookbackSeconds < 60 ? `${lookbackSeconds}s` : `${Math.round(lookbackSeconds / 60)}m`;

        this.log('INFO', `Running scheduled sync (looking back ${lookbackDisplay} to ${since.toISOString()})...`);

        let hasMore = true;
        let offset = 0;
        const limit = 500;
        let totalSyncedThisCycle = 0;

        while (hasMore) {
          hasMore = await this.bulkSyncUsers(limit, offset, since);
          offset += limit;

          if (hasMore) {
            totalSyncedThisCycle += limit;
          } else {
            totalSyncedThisCycle += (offset % limit);
          }
        }

        const duration = Date.now() - startTime;
        this.syncStats.lastSyncDuration = duration;

        this.log('SUCCESS', `Scheduled sync completed in ${Math.round(duration / 1000)}s (${totalSyncedThisCycle} users processed)`);

        // Check if sync is taking too long (>80% of interval)
        const intervalMs = this.syncIntervalSeconds * 1000;
        if (duration > intervalMs * 0.8) {
          this.log('WARNING', `Sync duration (${Math.round(duration / 1000)}s) is close to interval (${this.syncIntervalSeconds}s). Consider increasing interval or optimizing sync process.`);
        }

      } catch (error) {
        await this.logError('SCHEDULED_SYNC_FAILED', null, error);
      } finally {
        this.isSyncInProgress = false;
        this.syncStats.scheduledSyncActive = false;

        // Schedule next sync
        this.scheduleNextSync(intervalMinutes);
      }
    };

    const intervalDisplay = this.syncIntervalSeconds < 60 ? `${this.syncIntervalSeconds}s` : `${intervalMinutes}m`;
    const windowDisplay = this.syncIntervalSeconds * this.syncWindowMultiplier < 60
      ? `${this.syncIntervalSeconds * this.syncWindowMultiplier}s`
      : `${Math.round(this.syncIntervalSeconds * this.syncWindowMultiplier / 60)}m`;
    this.log('SUCCESS', `Scheduled sync started (every ${intervalDisplay}, looking back ${windowDisplay})`);

    // Start first sync after the interval
    this.scheduledSyncTimeout = setTimeout(runScheduledSync, intervalMinutes * 60 * 1000);
  }

  // Helper to schedule the next sync iteration
  // Uses syncIntervalSeconds for near real-time sync support
  scheduleNextSync(intervalMinutes) {
    if (this.scheduledSyncTimeout) {
      clearTimeout(this.scheduledSyncTimeout);
    }

    // Use seconds-based interval (more precise for short intervals)
    const intervalMs = this.syncIntervalSeconds * 1000;

    this.scheduledSyncTimeout = setTimeout(async () => {
      await this.runScheduledSyncCycle(intervalMinutes);
    }, intervalMs);
  }

  // Run a single scheduled sync cycle
  async runScheduledSyncCycle(intervalMinutes) {
    const startTime = Date.now();

    // Check if previous sync is still running
    if (this.isSyncInProgress) {
      this.log('WARNING', 'Previous sync still in progress, skipping this interval. Consider increasing sync interval.');
      this.scheduleNextSync(intervalMinutes);
      return;
    }

    try {
      this.isSyncInProgress = true;
      this.syncStats.scheduledSyncActive = true;

      // Look back 3x the interval to ensure overlap and catch any missed updates
      // Uses seconds-based calculation for near real-time sync support
      const lookbackSeconds = this.syncIntervalSeconds * this.syncWindowMultiplier;
      const since = new Date(Date.now() - lookbackSeconds * 1000);

      const lookbackDisplay = lookbackSeconds < 60 ? `${lookbackSeconds}s` : `${Math.round(lookbackSeconds / 60)}m`;
      this.log('INFO', `Running scheduled sync (looking back ${lookbackDisplay} to ${since.toISOString()})...`);

      let hasMore = true;
      let offset = 0;
      const limit = 500;

      while (hasMore) {
        hasMore = await this.bulkSyncUsers(limit, offset, since);
        if (hasMore) {
          offset += limit;
        }
      }

      const duration = Date.now() - startTime;
      this.syncStats.lastSyncDuration = duration;

      this.log('SUCCESS', `Scheduled sync completed in ${Math.round(duration / 1000)}s`);

      // Check if sync is taking too long (>80% of interval)
      if (duration > intervalMinutes * 60 * 1000 * 0.8) {
        this.log('WARNING', `Sync duration (${Math.round(duration / 1000)}s) is close to interval (${intervalMinutes * 60}s). Consider increasing interval or optimizing sync process.`);
      }

    } catch (error) {
      await this.logError('SCHEDULED_SYNC_FAILED', null, error);

      // Attempt auto-recovery if we have too many consecutive failures
      await this.autoRecover();
    } finally {
      this.isSyncInProgress = false;
      this.syncStats.scheduledSyncActive = false;

      // Schedule next sync
      this.scheduleNextSync(intervalMinutes);
    }
  }

  // Get sync statistics with enhanced health information
  getSyncStats() {
    const timeSinceLastSync = this.syncStats.lastSyncTime ?
      Math.round((Date.now() - this.syncStats.lastSyncTime.getTime()) / 1000) : null;

    return {
      ...this.syncStats,
      isRealTimeActive: this.isListening,
      isSyncInProgress: this.isSyncInProgress,
      timeSinceLastSyncSeconds: timeSinceLastSync,
      lastSyncDurationSeconds: this.syncStats.lastSyncDuration ?
        Math.round(this.syncStats.lastSyncDuration / 1000) : null,
      realtimeReconnectAttempts: this.realtimeReconnectAttempts,
      healthStatus: this.getHealthStatus()
    };
  }

  // Health check method
  getHealthStatus() {
    const timeSinceLastSync = this.syncStats.lastSyncTime ?
      (Date.now() - this.syncStats.lastSyncTime.getTime()) / 1000 : null;

    // Consider unhealthy if:
    // 1. No sync in last 10 minutes
    // 2. Consecutive failures > 5
    // 3. Real-time sync is down
    const isHealthy =
      this.syncStats.consecutiveFailures < 5 &&
      (timeSinceLastSync === null || timeSinceLastSync < 600) &&
      this.isListening;

    return {
      status: isHealthy ? 'HEALTHY' : 'UNHEALTHY',
      checks: {
        realtimeSyncActive: this.isListening,
        scheduledSyncActive: this.syncStats.scheduledSyncActive || !this.isSyncInProgress,
        recentSyncSuccess: timeSinceLastSync === null || timeSinceLastSync < 600,
        lowErrorRate: this.syncStats.consecutiveFailures < 5
      },
      recommendations: this.getHealthRecommendations(isHealthy, timeSinceLastSync)
    };
  }

  // Get health recommendations based on status
  getHealthRecommendations(isHealthy, timeSinceLastSync) {
    const recommendations = [];

    if (!this.isListening) {
      recommendations.push('Real-time sync is not active - check database connection and logs');
    }

    if (this.syncStats.consecutiveFailures >= 5) {
      recommendations.push(`High consecutive failure count (${this.syncStats.consecutiveFailures}) - investigate error logs`);
    }

    if (timeSinceLastSync && timeSinceLastSync > 600) {
      recommendations.push(`No successful sync in ${Math.round(timeSinceLastSync / 60)} minutes - check service health`);
    }

    if (this.syncStats.lastSyncDuration && this.syncStats.lastSyncDuration > this.syncIntervalSeconds * 1000 * 0.8) {
      recommendations.push('Sync duration approaching interval time - consider increasing interval or optimizing queries');
    }

    if (isHealthy && recommendations.length === 0) {
      recommendations.push('All systems operational');
    }

    return recommendations;
  }

  // Verify sync status
  async verifySyncStatus() {
    try {
      const [sourceCount, chatCount] = await Promise.all([
        this.sourcePool.query("SELECT COUNT(*) as count FROM users WHERE status IN ('active', 'pending_completion', 'pending_verification')"),
        this.chatPool.query('SELECT COUNT(*) as count FROM users')
      ]);

      const sourceTotal = parseInt(sourceCount.rows[0].count);
      const chatTotal = parseInt(chatCount.rows[0].count);

      this.log('INFO', `Sync Status: Source(${sourceTotal}) -> Chat(${chatTotal})`);

      // Check for recent discrepancies
      const [recentSource, recentChat] = await Promise.all([
        this.sourcePool.query(`
          SELECT COUNT(*) as count
          FROM users
          WHERE status IN ('active', 'pending_completion', 'pending_verification') AND updated_at > NOW() - INTERVAL '1 hour'
        `),
        this.chatPool.query(`
          SELECT COUNT(*) as count
          FROM users
          WHERE "updatedAt" > NOW() - INTERVAL '1 hour'
        `)
      ]);

      const recentDiff = Math.abs(
        parseInt(recentSource.rows[0].count) - parseInt(recentChat.rows[0].count)
      );

      const difference = Math.abs(sourceTotal - chatTotal);
      const consistent = difference <= 5; // Allow small variance

      if (!consistent) {
        this.log('WARNING', `Sync inconsistency detected: ${difference} users difference`);
      }

      return {
        sourceCount: sourceTotal,
        chatCount: chatTotal,
        difference,
        recentDifference: recentDiff,
        consistent,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      await this.logError('VERIFICATION_FAILED', null, error);
      return { error: error.message };
    }
  }

  // HTTP server for health checks and status
  startHttpServer() {
    const port = parseInt(process.env.HTTP_PORT) || 9000;

    this.httpServer = http.createServer((req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/health' || req.url === '/') {
        // Health check endpoint
        const healthStatus = this.getHealthStatus();
        const statusCode = healthStatus.status === 'HEALTHY' ? 200 : 503;

        res.writeHead(statusCode);
        res.end(JSON.stringify({
          status: healthStatus.status,
          timestamp: new Date().toISOString(),
          service: 'user-sync-service',
          version: '1.0.0',
          checks: healthStatus.checks,
          recommendations: healthStatus.recommendations
        }, null, 2));

      } else if (req.url === '/status') {
        // Detailed status endpoint
        const stats = this.getSyncStats();
        res.writeHead(200);
        res.end(JSON.stringify({
          service: 'user-sync-service',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          stats: stats
        }, null, 2));

      } else if (req.url === '/metrics') {
        // Metrics endpoint (Prometheus-like format)
        const stats = this.getSyncStats();
        res.setHeader('Content-Type', 'text/plain');
        res.writeHead(200);
        res.end(`# HELP sync_total_synced Total number of users synced
# TYPE sync_total_synced counter
sync_total_synced ${stats.totalSynced}

# HELP sync_errors Total number of sync errors
# TYPE sync_errors counter
sync_errors ${stats.errors}

# HELP sync_consecutive_failures Consecutive sync failures
# TYPE sync_consecutive_failures gauge
sync_consecutive_failures ${stats.consecutiveFailures}

# HELP sync_realtime_active Real-time sync status (1=active, 0=inactive)
# TYPE sync_realtime_active gauge
sync_realtime_active ${stats.realtimeSyncActive ? 1 : 0}

# HELP sync_scheduled_active Scheduled sync status (1=active, 0=inactive)
# TYPE sync_scheduled_active gauge
sync_scheduled_active ${stats.scheduledSyncActive ? 1 : 0}

# HELP sync_last_duration_seconds Last sync duration in seconds
# TYPE sync_last_duration_seconds gauge
sync_last_duration_seconds ${stats.lastSyncDurationSeconds || 0}
`);

      } else if (req.url === '/telemetry') {
        // Detailed telemetry endpoint for cache reconciliation
        const telemetry = this.getTelemetrySummary();
        res.writeHead(200);
        res.end(JSON.stringify({
          service: 'user-sync-service',
          mode: this.cacheMode ? 'cache' : 'legacy',
          timestamp: new Date().toISOString(),
          telemetry: telemetry
        }, null, 2));

      } else if (req.url === '/telemetry/history') {
        // Full reconciliation history
        res.writeHead(200);
        res.end(JSON.stringify({
          service: 'user-sync-service',
          timestamp: new Date().toISOString(),
          history: this.telemetry.reconciliationHistory
        }, null, 2));

      } else if (req.url === '/telemetry/operations') {
        // Operation-level timing stats
        res.writeHead(200);
        res.end(JSON.stringify({
          service: 'user-sync-service',
          timestamp: new Date().toISOString(),
          operations: this.telemetry.operations
        }, null, 2));

      } else {
        // 404 for unknown endpoints
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'Not Found',
          endpoints: ['/health', '/status', '/metrics', '/telemetry', '/telemetry/history', '/telemetry/operations']
        }, null, 2));
      }
    });

    this.httpServer.listen(port, () => {
      this.log('SUCCESS', `HTTP server listening on port ${port}`);
      this.log('INFO', `  Health check: http://localhost:${port}/health`);
      this.log('INFO', `  Status: http://localhost:${port}/status`);
      this.log('INFO', `  Metrics: http://localhost:${port}/metrics`);
      this.log('INFO', `  Telemetry: http://localhost:${port}/telemetry`);
    });

    this.httpServer.on('error', (err) => {
      this.log('ERROR', `HTTP server error: ${err.message}`);
    });
  }

  // =============================================
  // TELEMETRY HELPERS
  // =============================================

  /**
   * Track operation timing with detailed telemetry
   */
  trackOperation(operationName, durationMs, metadata = {}) {
    const op = this.telemetry.operations[operationName];
    if (op) {
      op.count++;
      op.totalMs += durationMs;
      op.avgMs = Math.round(op.totalMs / op.count * 100) / 100;
      op.minMs = Math.min(op.minMs, durationMs);
      op.maxMs = Math.max(op.maxMs, durationMs);
    }

    // Log with timestamp
    const timestamp = new Date().toISOString();
    const metaStr = Object.keys(metadata).length > 0 ? ` | ${JSON.stringify(metadata)}` : '';
    this.log('DEBUG', `📊 [${operationName}] ${durationMs}ms${metaStr}`);
  }

  /**
   * Time an async operation and track telemetry
   */
  async timeOperation(operationName, asyncFn, metadata = {}) {
    const start = Date.now();
    try {
      const result = await asyncFn();
      const duration = Date.now() - start;
      this.trackOperation(operationName, duration, { ...metadata, success: true });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.trackOperation(operationName, duration, { ...metadata, success: false, error: error.message });
      throw error;
    }
  }

  /**
   * Get telemetry summary for logging/API
   */
  getTelemetrySummary() {
    const ops = this.telemetry.operations;
    return {
      totalReconciliations: this.telemetry.totalReconciliations,
      lastReconciliation: this.telemetry.lastReconciliation,
      avgReconcileTimeMs: this.telemetry.avgReconcileTimeMs,
      operations: Object.entries(ops).reduce((acc, [name, stats]) => {
        if (stats.count > 0) {
          acc[name] = {
            count: stats.count,
            avgMs: stats.avgMs,
            minMs: stats.minMs === Infinity ? 0 : stats.minMs,
            maxMs: stats.maxMs
          };
        }
        return acc;
      }, {}),
      recentHistory: this.telemetry.reconciliationHistory.slice(-10)
    };
  }

  /**
   * Log detailed reconciliation report
   */
  logReconciliationReport(report) {
    const {
      totalUsers, cacheHits, cacheMisses, redisErrors = 0, updated, markedInactive,
      duplicatesDeactivated, sessionsClosed, durationMs, breakdown,
      circuitBreaker = { failures: 0, isOpen: false }, cacheMissCountSize = 0,
      reactivated = 0
    } = report;

    // Determine circuit breaker status display
    const cbStatus = circuitBreaker.isOpen
      ? `🔴 OPEN (${circuitBreaker.failures} failures - reconciliation PAUSED)`
      : `🟢 closed (${circuitBreaker.failures} failures)`;

    console.log('\n' + '='.repeat(80));
    console.log(`📊 CACHE RECONCILIATION REPORT - ${new Date().toISOString()}`);
    console.log('='.repeat(80));
    console.log(`
  📈 SUMMARY
  ─────────────────────────────────────────────────
  Total Users Processed : ${totalUsers}
  Cache Hits            : ${cacheHits} (${totalUsers > 0 ? Math.round(cacheHits/totalUsers*100) : 0}%)
  Cache Misses          : ${cacheMisses} (${totalUsers > 0 ? Math.round(cacheMisses/totalUsers*100) : 0}%)
  Redis Errors          : ${redisErrors}${redisErrors > 0 ? ' ⚠️' : ''}
  Users Updated         : ${updated}
  Users Reactivated     : ${reactivated}${reactivated > 0 ? ' ♻️' : ''}
  Marked Inactive       : ${markedInactive}
  Duplicates Deactivated: ${duplicatesDeactivated}
  Sessions Closed       : ${sessionsClosed}
  Total Duration        : ${durationMs}ms

  🔌 REDIS HEALTH
  ─────────────────────────────────────────────────
  Circuit Breaker       : ${cbStatus}
  Pending Miss Counts   : ${cacheMissCountSize} users being tracked

  ⏱️  TIMING BREAKDOWN
  ─────────────────────────────────────────────────
  Fetch Chat Users      : ${breakdown.fetchChatUsersMs}ms
  Fetch Cached Users    : ${breakdown.fetchCachedUsersMs}ms (total)
  Compare Changes       : ${breakdown.compareChangesMs}ms (total)
  Update Users          : ${breakdown.updateUsersMs}ms (total)
  Mark Inactive         : ${breakdown.markInactiveMs}ms (total)
  Deactivate Duplicates : ${breakdown.deactivateDuplicatesMs}ms (total)
  Close Sessions        : ${breakdown.closeSessionsMs}ms (total)
    `);
    console.log('='.repeat(80) + '\n');

    // Store in history (keep last 100)
    this.telemetry.reconciliationHistory.push({
      timestamp: new Date().toISOString(),
      ...report
    });
    if (this.telemetry.reconciliationHistory.length > 100) {
      this.telemetry.reconciliationHistory.shift();
    }

    this.telemetry.lastReconciliation = report;
    this.telemetry.totalReconciliations++;
    this.telemetry.avgReconcileTimeMs = Math.round(
      this.telemetry.reconciliationHistory.reduce((sum, r) => sum + r.durationMs, 0) /
      this.telemetry.reconciliationHistory.length
    );
  }

  // =============================================
  // CACHE RECONCILIATION MODE (June 2026)
  // Monitors Redis cache and reconciles chat DB
  // =============================================

  /**
   * Initialize Redis connection with Azure TLS support
   */
  async initRedis() {
    if (this.redis) return;

    const useTLS = process.env.REDIS_TLS === 'true';
    const redisHost = process.env.REDIS_HOST || 'localhost';

    const redisOptions = {
      host: redisHost,
      port: parseInt(process.env.REDIS_PORT) || (useTLS ? 6380 : 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB) || 0,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      // Azure Redis requires TLS with servername
      ...(useTLS && {
        tls: {
          servername: redisHost,
          rejectUnauthorized: false
        }
      })
    };

    this.redis = new Redis(redisOptions);

    this.redis.on('error', (err) => {
      this.log('ERROR', `Redis error: ${err.message}`);
      this.syncStats.errors++;
    });

    this.redis.on('connect', () => {
      this.log('SUCCESS', `Redis connected (TLS: ${useTLS ? 'yes' : 'no'})`);
    });

    // Wait for connection
    await new Promise((resolve, reject) => {
      this.redis.once('ready', resolve);
      this.redis.once('error', reject);
      setTimeout(() => reject(new Error('Redis connection timeout')), 10000);
    });
  }

  /**
   * Check if Redis is connected and healthy
   */
  isRedisHealthy() {
    return this.redis && this.redis.status === 'ready';
  }

  /**
   * Get user from Redis cache
   * Returns null if cache miss, throws if Redis is unavailable
   */
  async getCachedUser(userId) {
    // CRITICAL: Check Redis health first to prevent false cache misses
    if (!this.isRedisHealthy()) {
      const error = new Error('Redis connection not ready');
      this.log('ERROR', `[${new Date().toISOString()}] ❌ Redis unavailable, cannot check cache for ${userId.substring(0, 8)}...`);
      throw error; // Throw instead of returning null to distinguish from real cache miss
    }

    try {
      const cacheKey = `${this.userCachePrefix}${userId}`;
      const data = await this.redis.get(cacheKey);
      if (data) {
        try {
          return JSON.parse(data);
        } catch (parseError) {
          // Corrupted cache data - log and delete
          this.log('ERROR', `[${new Date().toISOString()}] ⚠️ Corrupted cache data for ${userId.substring(0, 8)}..., deleting key`);
          await this.redis.del(cacheKey);
          return null;
        }
      }
      return null;
    } catch (error) {
      this.log('ERROR', `[${new Date().toISOString()}] ❌ Failed to get cached user ${userId.substring(0, 8)}...: ${error.message}`);
      throw error; // Re-throw to signal Redis failure
    }
  }

  /**
   * Get all ACTIVE users from chat DB for reconciliation
   * Excludes users already marked as inactive to improve performance
   */
  async getChatDbUsers() {
    const result = await this.chatPool.query(`
      SELECT
        id, "externalId", name, "firstName", "lastName", email, phone,
        avatar, role, "metaData", "preferredLanguage",
        "autoReplyEnabled", "autoReplyMessage", "updatedAt"
      FROM users
      WHERE "externalId" IS NOT NULL
        AND COALESCE(("metaData"->>'isActive')::boolean, true) = true
      ORDER BY "updatedAt" DESC
    `);
    return result.rows;
  }

  /**
   * Check if cached data differs from chat DB data
   */
  /**
   * Check if cached user data differs from chat DB data
   * Also detects re-activation: user marked inactive in chat DB but active in cache
   * @returns {Object} { hasChanges: boolean, isReactivation: boolean }
   */
  hasChanges(chatUser, cachedUser) {
    // Check for re-activation: user was marked inactive but cache shows active
    const chatIsActive = chatUser.metaData?.isActive !== false;
    const cachedIsActive = cachedUser.status === 'active' || !cachedUser.status; // Default to active if no status
    const isReactivation = !chatIsActive && cachedIsActive;

    if (isReactivation) {
      this.log('INFO', `[${new Date().toISOString()}] ♻️ User ${chatUser.externalId?.substring(0, 8)}... RE-ACTIVATION detected (was inactive, now active in cache)`);
      return { hasChanges: true, isReactivation: true };
    }

    const chatName = chatUser.name || '';
    const cachedName = cachedUser.name ||
      `${cachedUser.firstName || ''} ${cachedUser.lastName || ''}`.trim() || '';

    if (chatName !== cachedName) return { hasChanges: true, isReactivation: false };
    if (chatUser.firstName !== cachedUser.firstName) return { hasChanges: true, isReactivation: false };
    if (chatUser.lastName !== cachedUser.lastName) return { hasChanges: true, isReactivation: false };
    if (chatUser.email !== cachedUser.email) return { hasChanges: true, isReactivation: false };
    if (chatUser.phone !== cachedUser.phone) return { hasChanges: true, isReactivation: false };
    if (chatUser.avatar !== cachedUser.avatarUrl) return { hasChanges: true, isReactivation: false };
    if (chatUser.preferredLanguage !== cachedUser.preferredLanguage) return { hasChanges: true, isReactivation: false };
    if (chatUser.autoReplyEnabled !== cachedUser.autoReplyEnabled) return { hasChanges: true, isReactivation: false };
    if (chatUser.autoReplyMessage !== cachedUser.autoReplyMessage) return { hasChanges: true, isReactivation: false };

    return { hasChanges: false, isReactivation: false };
  }

  /**
   * Update user in chat DB with cached data
   */
  async updateChatDbUserFromCache(externalId, cachedUser) {
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
        "preferredLanguage" = $8,
        "autoReplyEnabled" = $9,
        "autoReplyMessage" = $10,
        "metaData" = COALESCE("metaData", '{}'::jsonb) || $11::jsonb,
        "updatedAt" = NOW()
      WHERE "externalId" = $12
    `, [
      name,
      cachedUser.firstName || null,
      cachedUser.lastName || null,
      cachedUser.email || null,
      cachedUser.phone || null,
      cachedUser.avatarUrl || null,
      cachedUser.role || 'customer',
      cachedUser.preferredLanguage || 'en',
      cachedUser.autoReplyEnabled || false,
      cachedUser.autoReplyMessage || null,
      JSON.stringify({
        privacySettings: cachedUser.privacySettings,
        notificationPreference: cachedUser.notificationPreference,
        bio: cachedUser.bio,
        isVerified: cachedUser.isVerified,
        averageRating: cachedUser.averageRating,
        totalRatings: cachedUser.totalRatings,
        lastCacheSync: Date.now(),
        // Re-activate user when found in cache (clears inactive status)
        isActive: true,
        cacheStatus: 'found',
        reactivatedAt: cachedUser.status === 'active' ? new Date().toISOString() : null
      }),
      externalId
    ]);
  }

  /**
   * Mark user as inactive (not in cache for too long)
   * Also closes any active chat sessions for this user
   */
  async markUserInactive(externalId) {
    const timestamp = new Date().toISOString();
    this.log('INFO', `[${timestamp}] 🔄 Marking user ${externalId.substring(0, 8)}... as inactive`);

    await this.chatPool.query(`
      UPDATE users SET
        "metaData" = COALESCE("metaData", '{}'::jsonb) || $1::jsonb,
        "isOnline" = false,
        "socketId" = NULL,
        "updatedAt" = NOW()
      WHERE "externalId" = $2
    `, [
      JSON.stringify({
        cacheStatus: 'not_found',
        markedInactiveAt: timestamp,
        reason: 'User not found in cache for extended period',
        isActive: false
      }),
      externalId
    ]);
    this.log('WARNING', `[${timestamp}] ⚠️ User ${externalId.substring(0, 8)}... marked inactive, sessions closed`);
  }

  /**
   * Deactivate duplicate users with same email AND phone AND role
   * Keeps the one matching externalId active, marks others inactive
   * Uses AND logic to prevent false positives (both email AND phone must match)
   */
  async deactivateDuplicateUsers(externalId, email, phone, role) {
    const timestamp = new Date().toISOString();

    // Skip if no email/phone to match on
    if (!email && !phone) {
      this.log('DEBUG', `[${timestamp}] ⏭️ Skipping duplicate check - no email/phone`);
      return 0;
    }

    this.log('DEBUG', `[${timestamp}] 🔍 Checking for duplicates: email=${email || 'null'}, phone=${phone || 'null'}, role=${role}`);

    // Find users with BOTH same email AND phone AND role but different externalId
    // This is more precise than OR to prevent false positives
    let duplicatesResult;

    if (email && phone) {
      // Both email and phone available - strict matching
      duplicatesResult = await this.chatPool.query(`
        SELECT id, "externalId", name, email, phone, role
        FROM users
        WHERE "externalId" != $1
          AND email = $2
          AND phone = $3
          AND role = $4
          AND COALESCE(("metaData"->>'isActive')::boolean, true) = true
      `, [externalId, email, phone, role]);
    } else if (email) {
      // Only email available
      duplicatesResult = await this.chatPool.query(`
        SELECT id, "externalId", name, email, phone, role
        FROM users
        WHERE "externalId" != $1
          AND email = $2
          AND role = $3
          AND COALESCE(("metaData"->>'isActive')::boolean, true) = true
      `, [externalId, email, role]);
    } else {
      // Only phone available
      duplicatesResult = await this.chatPool.query(`
        SELECT id, "externalId", name, email, phone, role
        FROM users
        WHERE "externalId" != $1
          AND phone = $2
          AND role = $3
          AND COALESCE(("metaData"->>'isActive')::boolean, true) = true
      `, [externalId, phone, role]);
    }

    const duplicates = duplicatesResult.rows;

    if (duplicates.length > 0) {
      this.log('WARNING', `[${timestamp}] 🔄 Found ${duplicates.length} duplicate(s) to deactivate`);

      for (const dup of duplicates) {
        const dupTimestamp = new Date().toISOString();
        this.log('INFO', `[${dupTimestamp}] 🚫 Deactivating duplicate: ${dup.externalId?.substring(0, 8) || dup.id}...`);

        // Mark as inactive and close sessions
        await this.chatPool.query(`
          UPDATE users SET
            "metaData" = COALESCE("metaData", '{}'::jsonb) || $1::jsonb,
            "isOnline" = false,
            "socketId" = NULL,
            "updatedAt" = NOW()
          WHERE id = $2
        `, [
          JSON.stringify({
            isActive: false,
            deactivatedAt: dupTimestamp,
            deactivatedReason: 'duplicate_user',
            replacedByExternalId: externalId
          }),
          dup.id
        ]);
      }
    }

    return duplicates.length;
  }

  /**
   * Close all chat sessions for a user (conversation participants, typing indicators, etc.)
   */
  async closeUserSessions(externalId) {
    const timestamp = new Date().toISOString();
    this.log('INFO', `[${timestamp}] 🔒 Closing sessions for user ${externalId.substring(0, 8)}...`);

    try {
      // Clear socket and online status
      await this.chatPool.query(`
        UPDATE users SET
          "isOnline" = false,
          "socketId" = NULL,
          "lastSeen" = NOW()
        WHERE "externalId" = $1
      `, [externalId]);

      // Optional: Mark typing indicators as stopped
      try {
        await this.chatPool.query(`
          DELETE FROM typing_indicators
          WHERE user_id IN (SELECT id FROM users WHERE "externalId" = $1)
        `, [externalId]);
      } catch (e) {
        // Table might not exist
      }

      this.log('SUCCESS', `[${timestamp}] 🔒 Sessions closed for user ${externalId.substring(0, 8)}...`);
      return true;
    } catch (error) {
      this.log('ERROR', `[${timestamp}] ❌ Failed to close sessions: ${error.message}`);
      return false;
    }
  }

  /**
   * Check if circuit breaker should be reset (after cooldown period)
   */
  checkCircuitBreakerReset() {
    if (!this.redisCircuitBreaker.isOpen) return;

    const timeSinceFailure = Date.now() - this.redisCircuitBreaker.lastFailure;
    if (timeSinceFailure >= this.redisCircuitBreaker.resetAfterMs) {
      this.log('INFO', `[${new Date().toISOString()}] 🔄 Redis circuit breaker RESET - attempting reconnection`);
      this.redisCircuitBreaker.isOpen = false;
      this.redisCircuitBreaker.failures = 0;
    }
  }

  /**
   * Record Redis failure and potentially open circuit breaker
   */
  recordRedisFailure() {
    this.redisCircuitBreaker.failures++;
    this.redisCircuitBreaker.lastFailure = Date.now();

    if (this.redisCircuitBreaker.failures >= this.redisCircuitBreaker.maxFailures) {
      this.redisCircuitBreaker.isOpen = true;
      this.log('ERROR', `[${new Date().toISOString()}] 🔴 Redis circuit breaker OPEN - ${this.redisCircuitBreaker.failures} failures. Will retry after ${this.redisCircuitBreaker.resetAfterMs / 1000}s`);
    }
  }

  /**
   * Clean up cacheMissCount entries for users no longer in chat DB
   */
  cleanupCacheMissCount(chatUserIds) {
    const before = this.cacheMissCount.size;
    for (const [externalId] of this.cacheMissCount) {
      if (!chatUserIds.has(externalId)) {
        this.cacheMissCount.delete(externalId);
      }
    }
    const removed = before - this.cacheMissCount.size;
    if (removed > 0) {
      this.log('DEBUG', `[${new Date().toISOString()}] 🧹 Cleaned up ${removed} stale cacheMissCount entries`);
    }
  }

  /**
   * Main cache reconciliation - runs every N seconds with detailed telemetry
   */
  async reconcileCache() {
    if (this.isSyncInProgress) {
      this.log('WARNING', `[${new Date().toISOString()}] ⏭️ Previous reconciliation still in progress, skipping`);
      return;
    }

    // Check if circuit breaker should be reset
    this.checkCircuitBreakerReset();

    // If circuit breaker is open, skip reconciliation to prevent mass deactivation
    if (this.redisCircuitBreaker.isOpen) {
      this.log('WARNING', `[${new Date().toISOString()}] 🔴 Redis circuit breaker OPEN - skipping reconciliation to prevent mass deactivation`);
      return;
    }

    const reconcileStart = Date.now();
    const reconcileTimestamp = new Date().toISOString();
    this.isSyncInProgress = true;

    // Timing breakdown
    const timing = {
      fetchChatUsersMs: 0,
      fetchCachedUsersMs: 0,
      compareChangesMs: 0,
      updateUsersMs: 0,
      markInactiveMs: 0,
      deactivateDuplicatesMs: 0,
      closeSessionsMs: 0
    };

    // Counters
    let updated = 0;
    let reactivated = 0; // Users re-activated (were inactive, now active in cache)
    let markedInactive = 0;
    let duplicatesDeactivated = 0;
    let sessionsClosed = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    let redisErrors = 0;
    let chatUsers = [];

    console.log('\n' + '─'.repeat(80));
    this.log('INFO', `[${reconcileTimestamp}] 🔄 STARTING CACHE RECONCILIATION`);
    console.log('─'.repeat(80));

    try {
      // Step 1: Fetch all users from chat DB
      const fetchChatStart = Date.now();
      this.log('INFO', `[${new Date().toISOString()}] 📥 Fetching users from chat database...`);
      chatUsers = await this.getChatDbUsers();
      timing.fetchChatUsersMs = Date.now() - fetchChatStart;
      this.trackOperation('fetchChatUsers', timing.fetchChatUsersMs, { count: chatUsers.length });
      this.log('SUCCESS', `[${new Date().toISOString()}] 📥 Fetched ${chatUsers.length} users in ${timing.fetchChatUsersMs}ms`);

      // Step 2: Process each user
      for (let i = 0; i < chatUsers.length; i++) {
        const chatUser = chatUsers[i];
        const externalId = chatUser.externalId;
        const userLog = `User ${i + 1}/${chatUsers.length} [${externalId.substring(0, 8)}...]`;

        // 2a: Fetch from cache (with Redis error handling)
        const fetchCacheStart = Date.now();
        let cachedUser = null;
        let redisError = false;

        try {
          cachedUser = await this.getCachedUser(externalId);
        } catch (error) {
          // Redis error - NOT a cache miss, skip this user to avoid false deactivation
          redisErrors++;
          this.recordRedisFailure();
          this.log('ERROR', `[${new Date().toISOString()}] ⚠️ ${userLog}: Redis error, skipping (${error.message})`);
          redisError = true;

          // If circuit breaker opened, abort entire reconciliation
          if (this.redisCircuitBreaker.isOpen) {
            this.log('ERROR', `[${new Date().toISOString()}] 🔴 Circuit breaker opened mid-reconciliation, aborting to prevent damage`);
            break;
          }
          continue; // Skip to next user
        }

        const fetchCacheTime = Date.now() - fetchCacheStart;
        timing.fetchCachedUsersMs += fetchCacheTime;
        this.trackOperation('fetchCachedUser', fetchCacheTime, { externalId: externalId.substring(0, 8), hit: !!cachedUser, error: redisError });

        // Reset circuit breaker on success
        if (!redisError && this.redisCircuitBreaker.failures > 0) {
          this.redisCircuitBreaker.failures = 0;
        }

        if (cachedUser) {
          cacheHits++;
          this.cacheMissCount.delete(externalId);
          this.log('DEBUG', `[${new Date().toISOString()}] ✅ ${userLog}: Cache HIT (${fetchCacheTime}ms)`);

          // 2b: Compare for changes (returns { hasChanges, isReactivation })
          const compareStart = Date.now();
          const changeResult = this.hasChanges(chatUser, cachedUser);
          const compareTime = Date.now() - compareStart;
          timing.compareChangesMs += compareTime;
          this.trackOperation('compareChanges', compareTime, { externalId: externalId.substring(0, 8), needsUpdate: changeResult.hasChanges, isReactivation: changeResult.isReactivation });

          if (changeResult.hasChanges) {
            // Track reactivations separately
            if (changeResult.isReactivation) {
              reactivated++;
              this.log('INFO', `[${new Date().toISOString()}] ♻️ ${userLog}: Re-activating user (was inactive, now active in cache)`);
            }

            // 2c: Update user from cache
            const updateStart = Date.now();
            this.log('INFO', `[${new Date().toISOString()}] ✏️ ${userLog}: Updating from cache...`);
            await this.updateChatDbUserFromCache(externalId, cachedUser);
            const updateTime = Date.now() - updateStart;
            timing.updateUsersMs += updateTime;
            this.trackOperation('updateUser', updateTime, { externalId: externalId.substring(0, 8) });
            updated++;

            // 2d: Check and deactivate duplicates
            const dupStart = Date.now();
            const dupCount = await this.deactivateDuplicateUsers(
              externalId,
              cachedUser.email,
              cachedUser.phone,
              cachedUser.role || 'customer'
            );
            const dupTime = Date.now() - dupStart;
            timing.deactivateDuplicatesMs += dupTime;
            if (dupCount > 0) {
              this.trackOperation('deactivateDuplicate', dupTime, { externalId: externalId.substring(0, 8), duplicates: dupCount });
              duplicatesDeactivated += dupCount;
              sessionsClosed += dupCount;
            }

            this.log('SUCCESS', `[${new Date().toISOString()}] ✅ ${userLog}: Updated (${updateTime}ms), ${dupCount} duplicates deactivated`);
          }
        } else {
          // Cache MISS - User not in Redis cache
          // This typically means user was deleted from backend (cache was invalidated)
          cacheMisses++;
          const missCount = (this.cacheMissCount.get(externalId) || 0) + 1;
          this.cacheMissCount.set(externalId, missCount);

          const shouldInactivate = this.immediateInactive || (missCount >= this.staleMissThreshold);

          if (this.immediateInactive) {
            this.log('WARNING', `[${new Date().toISOString()}] 🗑️ ${userLog}: Cache MISS (${fetchCacheTime}ms) - IMMEDIATE INACTIVATION (user likely deleted from backend)`);
          } else {
            this.log('DEBUG', `[${new Date().toISOString()}] ❌ ${userLog}: Cache MISS (${fetchCacheTime}ms) - miss count: ${missCount}/${this.staleMissThreshold}`);
          }

          if (shouldInactivate) {
            // Mark as inactive and close sessions - user was deleted from backend
            const inactiveStart = Date.now();
            const reason = this.immediateInactive ? 'User deleted from backend (not in cache)' : `Threshold exceeded after ${missCount} consecutive misses`;
            this.log('WARNING', `[${new Date().toISOString()}] ⚠️ ${userLog}: ${reason}, marking inactive...`);
            await this.markUserInactive(externalId);
            const inactiveTime = Date.now() - inactiveStart;
            timing.markInactiveMs += inactiveTime;
            this.trackOperation('markInactive', inactiveTime, { externalId: externalId.substring(0, 8) });
            markedInactive++;

            // Close sessions
            const closeStart = Date.now();
            const closed = await this.closeUserSessions(externalId);
            const closeTime = Date.now() - closeStart;
            timing.closeSessionsMs += closeTime;
            if (closed) {
              this.trackOperation('closeUserSessions', closeTime, { externalId: externalId.substring(0, 8) });
              sessionsClosed++;
            }

            this.cacheMissCount.delete(externalId);
          }
        }
      }

      const totalDuration = Date.now() - reconcileStart;
      this.syncStats.totalSynced += updated;
      this.syncStats.lastSyncTime = new Date();
      this.syncStats.lastSyncDuration = totalDuration;
      this.syncStats.consecutiveFailures = 0; // Reset on success

      // Cleanup cacheMissCount for users no longer in chat DB
      const chatUserIds = new Set(chatUsers.map(u => u.externalId));
      this.cleanupCacheMissCount(chatUserIds);

      // Generate and log detailed report
      const report = {
        totalUsers: chatUsers.length,
        cacheHits,
        cacheMisses,
        redisErrors,
        updated,
        reactivated,
        markedInactive,
        duplicatesDeactivated,
        sessionsClosed,
        durationMs: totalDuration,
        breakdown: timing,
        circuitBreaker: {
          failures: this.redisCircuitBreaker.failures,
          isOpen: this.redisCircuitBreaker.isOpen
        },
        cacheMissCountSize: this.cacheMissCount.size
      };
      this.logReconciliationReport(report);

    } catch (error) {
      const errorTimestamp = new Date().toISOString();
      this.syncStats.errors++;
      this.syncStats.consecutiveFailures++;
      this.log('ERROR', `[${errorTimestamp}] ❌ Cache reconciliation FAILED: ${error.message}`);
      this.log('ERROR', `[${errorTimestamp}] ❌ Stack: ${error.stack}`);

      // Log partial report if we have data
      if (chatUsers.length > 0) {
        console.log('\n⚠️ PARTIAL RECONCILIATION REPORT (before failure):');
        console.log(`   Users processed: ${cacheHits + cacheMisses}/${chatUsers.length}`);
        console.log(`   Cache hits: ${cacheHits}, misses: ${cacheMisses}`);
        console.log(`   Redis errors: ${redisErrors}`);
        console.log(`   Updated: ${updated}, Inactive: ${markedInactive}`);
        console.log(`   Circuit breaker: ${this.redisCircuitBreaker.isOpen ? 'OPEN' : 'closed'} (${this.redisCircuitBreaker.failures} failures)`);
      }
    } finally {
      this.isSyncInProgress = false;
      this.log('INFO', `[${new Date().toISOString()}] 🏁 Reconciliation cycle complete`);
    }
  }

  /**
   * Start cache reconciliation loop (every 15 seconds by default)
   */
  async startCacheReconciliation() {
    await this.initRedis();
    this.log('SUCCESS', `Starting cache reconciliation (every ${this.syncIntervalSeconds}s)...`);

    // Run immediately
    await this.reconcileCache();

    // Then on interval
    this.scheduledSyncTimeout = setInterval(() => {
      this.reconcileCache();
    }, this.syncIntervalSeconds * 1000);

    this.syncStats.scheduledSyncActive = true;
  }

  // Complete setup method
  async setup() {
    this.log('INFO', '🚀 Setting up User Table Sync Service...');

    // Check if cache mode is enabled (SYNC_MODE=cache)
    const syncMode = process.env.SYNC_MODE || 'legacy';

    if (syncMode === 'cache') {
      this.log('INFO', '📦 CACHE MODE: Reconciling Redis cache → Chat DB');
      this.log('INFO', `   Interval: ${this.syncIntervalSeconds} seconds`);
      this.log('INFO', `   Stale threshold: ${this.staleMissThreshold} misses`);
      this.log('INFO', `   Immediate inactive: ${this.immediateInactive ? 'YES (deleted users marked inactive immediately)' : 'NO (wait for threshold)'}`);
      this.log('INFO', `   Redis host: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`);
      this.log('INFO', `   Redis TLS: ${process.env.REDIS_TLS === 'true' ? 'YES' : 'NO'}`);

      try {
        // Start cache reconciliation
        await this.startCacheReconciliation();

        // Start HTTP server for health checks
        this.startHttpServer();

        // Start pool health check
        this.startPoolHealthCheck();

        // Setup graceful shutdown
        this.setupGracefulShutdown();

        this.log('SUCCESS', '📦 Cache reconciliation service is running!');
        return;
      } catch (error) {
        await this.logError('CACHE_SETUP_FAILED', null, error);
        process.exit(1);
      }
    }

    // LEGACY MODE: DB-to-DB sync
    this.log('INFO', '🔄 LEGACY MODE: Source DB → Chat DB sync');

    try {
      // 1. Initial bulk sync
      this.log('INFO', 'Starting initial bulk sync...');
      let hasMore = true;
      let offset = 0;
      const limit = 1000;

      while (hasMore) {
        hasMore = await this.bulkSyncUsers(limit, offset);
        offset += limit;

        if (hasMore) {
          this.log('INFO', `Progress: ${offset} users processed...`);
        }
      }

      // 2. Start real-time sync
      this.log('INFO', 'Starting real-time sync...');
      await this.startRealTimeSync();

      // 3. Start scheduled backup sync
      this.log('INFO', 'Starting scheduled sync...');
      await this.startScheduledSync();

      // 4. Initial verification
      this.log('INFO', 'Verifying sync status...');
      await this.verifySyncStatus();

      // 5. BE_30: Sync blocked_users (REVERSE: chat -> backend)
      this.log('INFO', '🚫 Starting blocked_users reverse sync...');
      try {
        await this.syncBlockedUsers();
        await this.startBlockedUsersRealTimeSync();
        await this.verifyBlockedUsersSync();
      } catch (blockedSyncError) {
        // Don't fail startup if blocked_users sync fails (table might not exist yet)
        this.log('WARNING', `🚫 Blocked users sync failed (may need migration): ${blockedSyncError.message}`);
      }

      this.log('SUCCESS', 'User Table Sync Service is running!');
      this.log('INFO', `  Real-time sync: ${this.isListening ? 'Active' : 'Inactive'}`);
      const intervalDisplay = this.syncIntervalSeconds < 60 ? `${this.syncIntervalSeconds}s` : `${this.syncIntervalMinutes}m`;
      this.log('INFO', `  Scheduled sync: Every ${intervalDisplay}`);

      // 5. Start HTTP server for health checks
      this.startHttpServer();

      // 6. Start pool health check with auto-recovery
      this.startPoolHealthCheck();

      // Setup graceful shutdown handler
      this.setupGracefulShutdown();

    } catch (error) {
      await this.logError('SETUP_FAILED', null, error);
      process.exit(1);
    }
  }

  // Graceful shutdown handler
  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      this.log('WARNING', `\n${signal} received - shutting down sync service gracefully...`);

      try {
        // 1. Stop accepting new syncs
        if (this.scheduledSyncTimeout) {
          clearTimeout(this.scheduledSyncTimeout);
          this.log('INFO', 'Cleared scheduled sync timeout');
        }

        if (this.realtimeReconnectTimeout) {
          clearTimeout(this.realtimeReconnectTimeout);
          this.log('INFO', 'Cleared reconnection timeout');
        }

        // 2. Wait for in-progress sync to complete (max 30 seconds)
        if (this.isSyncInProgress) {
          this.log('WARNING', 'Waiting for in-progress sync to complete (max 30s)...');
          const maxWait = 30000;
          const startWait = Date.now();

          while (this.isSyncInProgress && (Date.now() - startWait) < maxWait) {
            await this.sleep(1000);
          }

          if (this.isSyncInProgress) {
            this.log('WARNING', 'Sync still in progress after 30s, forcing shutdown');
          } else {
            this.log('SUCCESS', 'In-progress sync completed');
          }
        }

        // 3. Close real-time sync connection
        this.isListening = false;
        if (this.realtimeClient) {
          try {
            await this.realtimeClient.end();
            this.log('SUCCESS', 'Real-time sync connection closed');
          } catch (error) {
            this.log('WARNING', `Error closing real-time client: ${error.message}`);
          }
        }

        // 4. Stop pool health check
        this.stopPoolHealthCheck();

        // 5. Close HTTP server
        if (this.httpServer) {
          await new Promise((resolve) => {
            this.httpServer.close(() => {
              this.log('SUCCESS', 'HTTP server closed');
              resolve();
            });
          });
        }

        // 5. Close connection pools
        await Promise.all([
          this.sourcePool.end(),
          this.chatPool.end()
        ]);
        this.log('SUCCESS', 'Database connection pools closed');

        // 6. Display final stats
        const stats = this.getSyncStats();
        this.log('INFO', 'Final statistics:', { details: stats });

        this.log('SUCCESS', 'Shutdown complete');
        process.exit(0);

      } catch (error) {
        this.log('ERROR', `Error during shutdown: ${error.message}`);
        process.exit(1);
      }
    };

    // Handle different termination signals
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  // =============================================
  // BE_30: BLOCKED USERS REVERSE SYNC
  // Sync blocked_users FROM chat_app_02 TO myusta_backend_02
  // =============================================

  /**
   * Sync all blocked_users from chat DB to backend DB
   * This is the REVERSE direction - chat is the source of truth for blocking
   */
  async syncBlockedUsers() {
    this.log('INFO', '🚫 Starting blocked_users reverse sync (chat -> backend)...');
    const startTime = Date.now();

    try {
      // Get all blocked_users from chat database
      const result = await this.chatPool.query(`
        SELECT id, blocker_id, blocked_id, reason, created_at, updated_at
        FROM blocked_users
        ORDER BY created_at ASC
      `);

      const blockedUsers = result.rows;
      this.log('INFO', `Found ${blockedUsers.length} blocked user records in chat DB`);

      if (blockedUsers.length === 0) {
        this.log('INFO', 'No blocked users to sync');
        return { synced: 0, errors: 0 };
      }

      let synced = 0;
      let errors = 0;

      for (const record of blockedUsers) {
        try {
          await this.upsertBlockedUser(record);
          synced++;
        } catch (error) {
          await this.logError('SYNC_BLOCKED_USER_FAILED', record.id, error, {
            blockerId: record.blocker_id,
            blockedId: record.blocked_id
          });
          errors++;
        }
      }

      const duration = Date.now() - startTime;
      this.log('SUCCESS', `🚫 Blocked users sync completed: ${synced} synced, ${errors} errors in ${Math.round(duration / 1000)}s`);

      return { synced, errors };

    } catch (error) {
      await this.logError('SYNC_BLOCKED_USERS_FAILED', null, error);
      throw error;
    }
  }

  /**
   * Upsert a single blocked_user record to backend database
   */
  async upsertBlockedUser(record) {
    return await this.retryWithBackoff(async () => {
      await this.sourcePool.query(`
        INSERT INTO blocked_users (
          id, blocker_id, blocked_id, reason, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET
          reason = EXCLUDED.reason,
          updated_at = EXCLUDED.updated_at
      `, [
        record.id,
        record.blocker_id,
        record.blocked_id,
        record.reason,
        record.created_at,
        record.updated_at
      ]);

      return record;
    }, `upsert blocked_user ${record.id}`);
  }

  /**
   * Delete a blocked_user record from backend database (for unblock)
   */
  async deleteBlockedUser(blockerId, blockedId) {
    return await this.retryWithBackoff(async () => {
      const result = await this.sourcePool.query(`
        DELETE FROM blocked_users
        WHERE blocker_id = $1 AND blocked_id = $2
        RETURNING id
      `, [blockerId, blockedId]);

      if (result.rows.length > 0) {
        this.log('SUCCESS', `Deleted blocked_user: blocker=${blockerId}, blocked=${blockedId}`);
      }

      return result.rows[0];
    }, `delete blocked_user ${blockerId}->${blockedId}`);
  }

  /**
   * Start real-time sync for blocked_users changes in chat DB
   * Uses PostgreSQL LISTEN/NOTIFY
   */
  async startBlockedUsersRealTimeSync() {
    this.log('INFO', '🚫 Starting real-time sync for blocked_users changes...');

    try {
      // Create a separate client for blocked_users listening
      const { Client } = require('pg');
      this.blockedUsersClient = new Client({
        ...this.chatDbConfig,
        statement_timeout: 0, // No timeout for LISTEN connection
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000
      });

      await this.blockedUsersClient.connect();

      // Create trigger function if not exists
      await this.blockedUsersClient.query(`
        CREATE OR REPLACE FUNCTION notify_blocked_users_changes()
        RETURNS TRIGGER AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            PERFORM pg_notify('blocked_users_changes', json_build_object(
              'operation', TG_OP,
              'blocker_id', OLD.blocker_id,
              'blocked_id', OLD.blocked_id,
              'id', OLD.id
            )::text);
            RETURN OLD;
          ELSE
            PERFORM pg_notify('blocked_users_changes', json_build_object(
              'operation', TG_OP,
              'data', row_to_json(NEW)
            )::text);
            RETURN NEW;
          END IF;
        END;
        $$ LANGUAGE plpgsql;
      `);

      // Create trigger if not exists
      await this.blockedUsersClient.query(`
        DROP TRIGGER IF EXISTS blocked_users_changes_trigger ON blocked_users;
        CREATE TRIGGER blocked_users_changes_trigger
        AFTER INSERT OR UPDATE OR DELETE ON blocked_users
        FOR EACH ROW EXECUTE FUNCTION notify_blocked_users_changes();
      `);

      // Listen for notifications
      await this.blockedUsersClient.query('LISTEN blocked_users_changes');

      // Handle notifications
      this.blockedUsersClient.on('notification', async (msg) => {
        try {
          const payload = JSON.parse(msg.payload);
          this.log('INFO', `🚫 Blocked users change: ${payload.operation}`, {
            details: payload.operation === 'DELETE'
              ? { blockerId: payload.blocker_id, blockedId: payload.blocked_id }
              : { blockerId: payload.data?.blocker_id, blockedId: payload.data?.blocked_id }
          });

          if (payload.operation === 'DELETE') {
            // Handle unblock - delete from backend
            await this.deleteBlockedUser(payload.blocker_id, payload.blocked_id);
          } else {
            // Handle block (INSERT) or update
            await this.upsertBlockedUser(payload.data);
          }
        } catch (error) {
          await this.logError('BLOCKED_USERS_NOTIFICATION_FAILED', null, error, { payload: msg.payload });
        }
      });

      // Handle connection errors
      this.blockedUsersClient.on('error', async (err) => {
        this.log('ERROR', 'Blocked users real-time sync connection error', { details: err.message });
        // Attempt reconnection after delay
        setTimeout(() => this.startBlockedUsersRealTimeSync(), 5000);
      });

      this.log('SUCCESS', '🚫 Real-time sync for blocked_users started - listening for changes...');

    } catch (error) {
      await this.logError('BLOCKED_USERS_REALTIME_START_FAILED', null, error);
      throw error;
    }
  }

  /**
   * Verify blocked_users sync status
   */
  async verifyBlockedUsersSync() {
    try {
      const [chatCount, backendCount] = await Promise.all([
        this.chatPool.query('SELECT COUNT(*) as count FROM blocked_users'),
        this.sourcePool.query('SELECT COUNT(*) as count FROM blocked_users')
      ]);

      const chatTotal = parseInt(chatCount.rows[0].count);
      const backendTotal = parseInt(backendCount.rows[0].count);
      const difference = Math.abs(chatTotal - backendTotal);

      this.log('INFO', `🚫 Blocked Users Sync Status: Chat(${chatTotal}) -> Backend(${backendTotal}), Diff: ${difference}`);

      return {
        chatCount: chatTotal,
        backendCount: backendTotal,
        difference,
        consistent: difference === 0
      };

    } catch (error) {
      // If blocked_users table doesn't exist in backend, that's expected initially
      if (error.message.includes('relation "blocked_users" does not exist')) {
        this.log('WARNING', '🚫 blocked_users table does not exist in backend - run migration first');
        return { error: 'blocked_users table not found in backend' };
      }
      await this.logError('VERIFY_BLOCKED_USERS_FAILED', null, error);
      return { error: error.message };
    }

    // Handle uncaught errors
    process.on('uncaughtException', async (error) => {
      await this.logError('UNCAUGHT_EXCEPTION', null, error);
      await shutdown('UNCAUGHT_EXCEPTION');
    });

    process.on('unhandledRejection', async (reason, promise) => {
      await this.logError('UNHANDLED_REJECTION', null, new Error(String(reason)), { promise: String(promise) });
      await shutdown('UNHANDLED_REJECTION');
    });
  }
}

// Usage examples and main execution
if (require.main === module) {
  const syncService = new UserTableSyncService();
  
  // Get command line arguments
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'setup':
      syncService.setup();
      break;
      
    case 'sync-all':
      console.log('🔄 Starting complete sync of ALL users...');
      syncService.syncAllUsers()
        .then((result) => {
          console.log(`✅ Complete sync finished: ${result.synced} synced, ${result.errors} errors`);
          process.exit(0);
        })
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;
      
    case 'bulk':
      const limit = parseInt(args[1]) || 1000;
      const offset = parseInt(args[2]) || 0;
      syncService.bulkSyncUsers(limit, offset)
        .then(() => process.exit(0))
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;
      
    case 'verify':
      syncService.verifySyncStatus()
        .then(() => process.exit(0))
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;
      
    case 'realtime':
      syncService.startRealTimeSync()
        .then(() => {
          console.log('Real-time sync started. Press Ctrl+C to stop.');
        })
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;

    case 'sync-blocked':
      console.log('🚫 Starting blocked_users reverse sync (chat -> backend)...');
      syncService.syncBlockedUsers()
        .then((result) => {
          console.log(`✅ Blocked users sync finished: ${result.synced} synced, ${result.errors} errors`);
          return syncService.verifyBlockedUsersSync();
        })
        .then(() => process.exit(0))
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;

    case 'verify-blocked':
      syncService.verifyBlockedUsersSync()
        .then((result) => {
          console.log('🚫 Blocked users verification:', result);
          process.exit(0);
        })
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;

    default:
      console.log(`
🔄 User Table Sync Service Commands:

  node userTableSync.js sync-all        - Sync ALL users from main DB to chat DB
  node userTableSync.js setup           - Complete setup with bulk + real-time sync
  node userTableSync.js bulk [limit]    - One-time bulk sync
  node userTableSync.js verify          - Check sync status
  node userTableSync.js realtime        - Start real-time sync only

Examples:
  node userTableSync.js sync-all                                   - Sync all users (recommended)
  node userTableSync.js bulk 500 0                                - Sync 500 users starting from offset 0

Setup:
  1. Install dependencies: npm install pg dotenv
  2. Copy .env.template to .env
  3. Update .env with your database credentials
      `);
      break;
  }
}

module.exports = UserTableSyncService;