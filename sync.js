// userTableSync.js - Complete sync service for myusta_backend -> myusta_chatapp
const { Client } = require('pg');

class UserTableSyncService {
  constructor() {
    // Source database config (myusta_backend)
    this.sourceDbConfig = {
      host: 'localhost',
      port: 5432,
      database: 'myusta_backend',
      user: 'postgres',
      password: 'd8P@ssw0rd2025'
    };

    // Destination database config (myusta_chatapp)
    this.chatDbConfig = {
      host: 'localhost',
      port: 5432,
      database: 'myusta_chatapp',
      user: 'postgres',
      password: 'd8P@ssw0rd2025'
    };

    this.isListening = false;
    this.syncStats = {
      totalSynced: 0,
      lastSyncTime: null,
      errors: 0
    };
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
      return 'User'; // Default name
    }
  }

  // Sanitize phone number - ensure it's never null and unique
  sanitizePhone(phone, userId) {
    if (!phone || phone.trim() === '') {
      // Generate a unique numeric placeholder phone using user ID
      // Convert UUID to numeric: take first 8 hex chars and convert to decimal
      const hexPart = userId.replace(/-/g, '').substring(0, 8);
      const numericPart = parseInt(hexPart, 16).toString().substring(0, 9);
      // Ensure it starts with 9 to make it look like a phone number and avoid conflicts
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
        app: user.notification_via_app || true,
        email: user.notification_via_email || true,
        sms: user.notification_via_sms || false
      },
      termsAccepted: user.terms_and_conditions || false,
      ratings: {
        average: user.average_rating,
        total: user.total_ratings,
        totalHires: user.total_hires,
        totalViews: user.total_views,
        lastHiredAt: user.last_hired_at
      },
      verification: {
        isVerified: user.is_verified || false,
        isFeatured: user.is_featured || false,
        searchBoost: user.search_boost || 0
      },
      bio: user.bio
    };
  }

  // Upsert single user to chat database
  async upsertUser(userData) {
    const chatClient = new Client(this.chatDbConfig);
    
    try {
      await chatClient.connect();
      
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

      const result = await chatClient.query(query, values);
      
      console.log(`✅ User synced: ${transformedUser.name} (${transformedUser.id})`);
      this.syncStats.totalSynced++;
      
      return result.rows[0];

    } catch (error) {
      console.error(`❌ Error syncing user ${userData.id}:`, error.message);
      console.error(`   User data: name="${userData.first_name} ${userData.last_name}", phone="${userData.phone}", email="${userData.email}"`);
      this.syncStats.errors++;
      throw error;
    } finally {
      await chatClient.end();
    }
  }

  // Bulk sync users with pagination
  async bulkSyncUsers(limit = 1000, offset = 0, sinceDate = null) {
    const sourceClient = new Client(this.sourceDbConfig);
    const chatClient = new Client(this.chatDbConfig);
    
    try {
      await sourceClient.connect();
      await chatClient.connect();
      
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

      const result = await sourceClient.query(query, queryParams);
      const users = result.rows;

      if (users.length === 0) {
        console.log('📋 No users to sync');
        return false;
      }

      console.log(`🔄 Syncing ${users.length} users (offset: ${offset})...`);

      // Batch upsert users
      let successCount = 0;
      let errorCount = 0;

      for (const user of users) {
        try {
          const transformedUser = this.transformUserData(user);
          
          await chatClient.query(`
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
          
          successCount++;
        } catch (error) {
          console.error(`❌ Error syncing user ${user.id}:`, error.message);
          console.error(`   User data: name="${user.first_name} ${user.last_name}", phone="${user.phone}", email="${user.email}"`);
          errorCount++;
        }
      }

      console.log(`✅ Batch sync completed: ${successCount} success, ${errorCount} errors`);
      this.syncStats.totalSynced += successCount;
      this.syncStats.errors += errorCount;
      this.syncStats.lastSyncTime = new Date();

      return users.length === limit; // Return true if there might be more records

    } catch (error) {
      console.error('❌ Bulk sync error:', error);
      throw error;
    } finally {
      await sourceClient.end();
      await chatClient.end();
    }
  }

  // Real-time sync using PostgreSQL LISTEN/NOTIFY
  async startRealTimeSync() {
    if (this.isListening) return;
    
    const sourceClient = new Client(this.sourceDbConfig);
    
    try {
      await sourceClient.connect();
      
      // Create trigger function if not exists
      await sourceClient.query(`
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
      await sourceClient.query(`
        DROP TRIGGER IF EXISTS user_changes_trigger ON users;
        CREATE TRIGGER user_changes_trigger
        AFTER INSERT OR UPDATE OR DELETE ON users
        FOR EACH ROW EXECUTE FUNCTION notify_user_changes();
      `);

      // Listen for notifications
      await sourceClient.query('LISTEN user_changes');
      
      sourceClient.on('notification', async (msg) => {
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
          console.error('❌ Error processing user change notification:', error);
        }
      });

      this.isListening = true;
      console.log('🔊 Real-time sync started - listening for user changes...');

    } catch (error) {
      console.error('❌ Error setting up real-time sync:', error);
      throw error;
    }
  }

  // Delete user from chat database
  async deleteUserFromChat(userId) {
    const chatClient = new Client(this.chatDbConfig);
    
    try {
      await chatClient.connect();
      
      const result = await chatClient.query(`
        DELETE FROM users WHERE "externalId" = $1 RETURNING id
      `, [userId]);

      if (result.rows.length > 0) {
        console.log(`🗑️ User deleted from chat: ${userId}`);
      }

    } catch (error) {
      console.error(`❌ Error deleting user ${userId}:`, error);
    } finally {
      await chatClient.end();
    }
  }

  // Scheduled incremental sync
  async startScheduledSync(intervalMinutes = 5) {
    const syncInterval = setInterval(async () => {
      try {
        const since = new Date(Date.now() - (intervalMinutes + 1) * 60 * 1000);
        
        console.log(`⏰ Running scheduled sync (since ${since.toISOString()})...`);
        
        let hasMore = true;
        let offset = 0;
        const limit = 500;
        
        while (hasMore) {
          hasMore = await this.bulkSyncUsers(limit, offset, since);
          offset += limit;
        }
        
      } catch (error) {
        console.error('❌ Scheduled sync error:', error);
      }
    }, intervalMinutes * 60 * 1000);

    console.log(`⏰ Scheduled sync started (every ${intervalMinutes} minutes)`);
    return syncInterval;
  }

  // Get sync statistics
  getSyncStats() {
    return {
      ...this.syncStats,
      isRealTimeActive: this.isListening,
      uptime: this.syncStats.lastSyncTime ? 
        Math.round((Date.now() - this.syncStats.lastSyncTime.getTime()) / 1000) : null
    };
  }

  // Verify sync status
  async verifySyncStatus() {
    const sourceClient = new Client(this.sourceDbConfig);
    const chatClient = new Client(this.chatDbConfig);
    
    try {
      await sourceClient.connect();
      await chatClient.connect();

      const [sourceCount, chatCount] = await Promise.all([
        sourceClient.query("SELECT COUNT(*) as count FROM users WHERE status = 'active'"),
        chatClient.query('SELECT COUNT(*) as count FROM users')
      ]);

      const sourceTotal = parseInt(sourceCount.rows[0].count);
      const chatTotal = parseInt(chatCount.rows[0].count);
      
      console.log(`📊 Sync Status: Source(${sourceTotal}) -> Chat(${chatTotal})`);
      
      // Check for recent discrepancies
      const [recentSource, recentChat] = await Promise.all([
        sourceClient.query(`
          SELECT COUNT(*) as count 
          FROM users 
          WHERE status = 'active' AND updated_at > NOW() - INTERVAL '1 hour'
        `),
        chatClient.query(`
          SELECT COUNT(*) as count 
          FROM users 
          WHERE "updatedAt" > NOW() - INTERVAL '1 hour'
        `)
      ]);

      const recentDiff = Math.abs(
        parseInt(recentSource.rows[0].count) - parseInt(recentChat.rows[0].count)
      );

      return {
        sourceCount: sourceTotal,
        chatCount: chatTotal,
        difference: Math.abs(sourceTotal - chatTotal),
        recentDifference: recentDiff,
        consistent: Math.abs(sourceTotal - chatTotal) <= 5 // Allow small variance
      };

    } catch (error) {
      console.error('❌ Verification error:', error);
      return { error: error.message };
    } finally {
      await sourceClient.end();
      await chatClient.end();
    }
  }

  // Complete setup method
  async setup() {
    console.log('🚀 Setting up User Table Sync Service...');
    console.log('   Source: myusta_backend');
    console.log('   Destination: myusta_chatapp');
    
    try {
      // 1. Initial bulk sync
      console.log('\n📦 Starting initial bulk sync...');
      let hasMore = true;
      let offset = 0;
      const limit = 1000;
      
      while (hasMore) {
        hasMore = await this.bulkSyncUsers(limit, offset);
        offset += limit;
        
        if (hasMore) {
          console.log(`   Progress: ${offset} users processed...`);
        }
      }
      
      // 2. Start real-time sync
      console.log('\n🔊 Starting real-time sync...');
      await this.startRealTimeSync();
      
      // 3. Start scheduled backup sync
      console.log('\n⏰ Starting scheduled sync...');
      const syncInterval = await this.startScheduledSync(5);
      
      // 4. Initial verification
      console.log('\n📊 Verifying sync status...');
      await this.verifySyncStatus();
      
      console.log('\n✅ User Table Sync Service is running!');
      console.log('   Real-time sync: Active');
      console.log('   Scheduled sync: Every 5 minutes');
      
      // Graceful shutdown handler
      process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down sync service...');
        clearInterval(syncInterval);
        this.isListening = false;
        
        // Final stats
        const stats = this.getSyncStats();
        console.log('📊 Final stats:', stats);
        
        process.exit(0);
      });
      
    } catch (error) {
      console.error('❌ Setup failed:', error);
      process.exit(1);
    }
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

  node userTableSync.js setup     - Complete setup with bulk + real-time sync
  node userTableSync.js bulk      - One-time bulk sync
  node userTableSync.js verify    - Check sync status
  node userTableSync.js realtime  - Start real-time sync only

Examples:
  node userTableSync.js bulk 500 0    - Sync 500 users starting from offset 0
      `);
      break;
  }
}

module.exports = UserTableSyncService;