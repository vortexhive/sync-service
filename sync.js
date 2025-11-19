// userTableSync.js - Complete sync service for source -> chat database
const { Pool } = require('pg');
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

    this.syncIntervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 1;
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
    console.log(`   Sync Interval: ${this.syncIntervalMinutes} minute(s)`);
    console.log(`   Sync Window: ${this.syncIntervalMinutes * this.syncWindowMultiplier} minute(s) lookback`);
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
      lastName: sourceUser.last_name
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

  // Map source roles to chat roles
  mapRole(sourceRole) {
    const roleMapping = {
      'customer': 'customer',
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
    return {
      emailVerified: user.email_verified || false,
      phoneVerified: user.phone_verified || false,
      authProvider: user.auth_provider,
      googleId: user.google_id,
      facebookId: user.facebook_id,
      status: user.status,
      customerPreferences: user.customer_preferences,
      notificationSettings: {
        app: user.notification_via_app !== null ? user.notification_via_app : true,
        email: user.notification_via_email !== null ? user.notification_via_email : true,
        sms: user.notification_via_sms !== null ? user.notification_via_sms : false
      },
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
      hasPassword: !!user.password
    };
  }

  // Sync ALL users from source to chat (complete refresh)
  async syncAllUsers() {
    const startTime = Date.now();
    this.log('INFO', 'Starting complete sync of ALL users...');

    try {
      this.log('INFO', 'Getting total user count...');
      const countResult = await this.sourcePool.query("SELECT COUNT(*) as count FROM users WHERE status = 'active'");
      const totalUsers = parseInt(countResult.rows[0].count);

      this.log('INFO', `Found ${totalUsers.toLocaleString()} active users to sync`);

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
            terms_and_conditions, average_rating, total_ratings, total_hires,
            total_views, last_hired_at, is_verified, is_featured, search_boost,
            created_at, updated_at, bio
          FROM users
          WHERE status = 'active' AND id IS NOT NULL
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
                  "updatedAt", "firstName", "lastName"
                ) VALUES (
                  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
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
                  "lastName" = EXCLUDED."lastName"
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
                transformedUser.lastName
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
            "updatedAt", "firstName", "lastName"
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
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
            "lastName" = EXCLUDED."lastName"
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
          transformedUser.lastName
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
      let whereClause = "WHERE status = 'active' AND id IS NOT NULL";
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
          terms_and_conditions, average_rating, total_ratings, total_hires,
          total_views, last_hired_at, is_verified, is_featured, search_boost,
          created_at, updated_at, bio
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
                "updatedAt", "firstName", "lastName"
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
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
                "lastName" = EXCLUDED."lastName"
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
              transformedUser.lastName
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
        const lookbackMinutes = intervalMinutes * this.syncWindowMultiplier;
        const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);

        this.log('INFO', `Running scheduled sync (looking back ${lookbackMinutes} minutes to ${since.toISOString()})...`);

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

        // Check if sync is taking too long
        if (duration > intervalMinutes * 60 * 1000 * 0.8) {
          this.log('WARNING', `Sync duration (${Math.round(duration / 1000)}s) is close to interval (${intervalMinutes * 60}s). Consider increasing interval or optimizing sync process.`);
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

    this.log('SUCCESS', `Scheduled sync started (every ${intervalMinutes} minute(s), looking back ${intervalMinutes * this.syncWindowMultiplier} minutes)`);

    // Start first sync after the interval
    this.scheduledSyncTimeout = setTimeout(runScheduledSync, intervalMinutes * 60 * 1000);
  }

  // Helper to schedule the next sync iteration
  scheduleNextSync(intervalMinutes) {
    if (this.scheduledSyncTimeout) {
      clearTimeout(this.scheduledSyncTimeout);
    }

    this.scheduledSyncTimeout = setTimeout(async () => {
      await this.runScheduledSyncCycle(intervalMinutes);
    }, intervalMinutes * 60 * 1000);
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
      const lookbackMinutes = intervalMinutes * this.syncWindowMultiplier;
      const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);

      this.log('INFO', `Running scheduled sync (looking back ${lookbackMinutes} minutes to ${since.toISOString()})...`);

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

    if (this.syncStats.lastSyncDuration && this.syncStats.lastSyncDuration > this.syncIntervalMinutes * 60 * 1000 * 0.8) {
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
        this.sourcePool.query("SELECT COUNT(*) as count FROM users WHERE status = 'active'"),
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
          WHERE status = 'active' AND updated_at > NOW() - INTERVAL '1 hour'
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

      } else {
        // 404 for unknown endpoints
        res.writeHead(404);
        res.end(JSON.stringify({
          error: 'Not Found',
          endpoints: ['/health', '/status', '/metrics']
        }, null, 2));
      }
    });

    this.httpServer.listen(port, () => {
      this.log('SUCCESS', `HTTP server listening on port ${port}`);
      this.log('INFO', `  Health check: http://localhost:${port}/health`);
      this.log('INFO', `  Status: http://localhost:${port}/status`);
      this.log('INFO', `  Metrics: http://localhost:${port}/metrics`);
    });

    this.httpServer.on('error', (err) => {
      this.log('ERROR', `HTTP server error: ${err.message}`);
    });
  }

  // Complete setup method
  async setup() {
    this.log('INFO', '🚀 Setting up User Table Sync Service...');

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

      this.log('SUCCESS', 'User Table Sync Service is running!');
      this.log('INFO', `  Real-time sync: ${this.isListening ? 'Active' : 'Inactive'}`);
      this.log('INFO', `  Scheduled sync: Every ${this.syncIntervalMinutes} minute(s)`);

      // 5. Start HTTP server for health checks
      this.startHttpServer();

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

        // 4. Close HTTP server
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