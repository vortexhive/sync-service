// monitor.js - Simple monitoring dashboard for user sync
const { Client } = require('pg');

class SyncMonitor {
  constructor() {
    this.sourceDbConfig = {
      host: 'localhost',
      port: 5432,
      database: 'myusta_backend',
      user: 'postgres',
      password: 'd8P@ssw0rd2025'
    };

    this.chatDbConfig = {
      host: 'localhost',
      port: 5432,
      database: 'myusta_chatapp',
      user: 'postgres',
      password: 'd8P@ssw0rd2025'
    };
  }

  async getDetailedStats() {
    const sourceClient = new Client(this.sourceDbConfig);
    const chatClient = new Client(this.chatDbConfig);
    
    try {
      await sourceClient.connect();
      await chatClient.connect();

      // Get comprehensive statistics
      const [
        sourceTotalResult,
        sourceActiveResult,
        sourceRecentResult,
        chatTotalResult,
        chatRecentResult,
        sourceRoleStatsResult,
        chatRoleStatsResult
      ] = await Promise.all([
        sourceClient.query("SELECT COUNT(*) as count FROM users"),
        sourceClient.query("SELECT COUNT(*) as count FROM users WHERE status = 'active'"),
        sourceClient.query("SELECT COUNT(*) as count FROM users WHERE status = 'active' AND updated_at > NOW() - INTERVAL '24 hours'"),
        chatClient.query('SELECT COUNT(*) as count FROM users'),
        chatClient.query('SELECT COUNT(*) as count FROM users WHERE "updatedAt" > NOW() - INTERVAL \'24 hours\''),
        sourceClient.query(`
          SELECT role, COUNT(*) as count 
          FROM users 
          WHERE status = 'active' 
          GROUP BY role 
          ORDER BY count DESC
        `),
        chatClient.query(`
          SELECT role, COUNT(*) as count 
          FROM users 
          GROUP BY role 
          ORDER BY count DESC
        `)
      ]);

      // Find discrepancies
      const discrepanciesResult = await sourceClient.query(`
        WITH source_users AS (
          SELECT id, updated_at, role
          FROM users 
          WHERE status = 'active'
        ),
        chat_users AS (
          SELECT "externalId" as id, "updatedAt" as updated_at, role
          FROM myusta_chatapp.users
        )
        SELECT 
          s.id,
          s.updated_at as source_updated,
          c.updated_at as chat_updated,
          s.role as source_role,
          c.role as chat_role
        FROM source_users s
        LEFT JOIN chat_users c ON s.id = c.id
        WHERE c.id IS NULL 
           OR s.updated_at > c.updated_at
           OR s.role != c.role
        LIMIT 10
      `);

      return {
        source: {
          total: parseInt(sourceTotalResult.rows[0].count),
          active: parseInt(sourceActiveResult.rows[0].count),
          recent24h: parseInt(sourceRecentResult.rows[0].count),
          roleBreakdown: sourceRoleStatsResult.rows
        },
        chat: {
          total: parseInt(chatTotalResult.rows[0].count),
          recent24h: parseInt(chatRecentResult.rows[0].count),
          roleBreakdown: chatRoleStatsResult.rows
        },
        discrepancies: discrepanciesResult.rows,
        status: {
          consistent: Math.abs(
            parseInt(sourceActiveResult.rows[0].count) - 
            parseInt(chatTotalResult.rows[0].count)
          ) <= 5,
          lastChecked: new Date().toISOString()
        }
      };

    } catch (error) {
      return { error: error.message };
    } finally {
      await sourceClient.end();
      await chatClient.end();
    }
  }

  async checkReplicationHealth() {
    const sourceClient = new Client(this.sourceDbConfig);
    
    try {
      await sourceClient.connect();
      
      // Check if trigger exists
      const triggerResult = await sourceClient.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_trigger 
          WHERE tgname = 'user_changes_trigger'
        ) as trigger_exists
      `);
      
      // Check recent trigger activity (if we had a log table)
      // For now, we'll check recent user updates as a proxy
      const recentActivityResult = await sourceClient.query(`
        SELECT COUNT(*) as recent_changes
        FROM users 
        WHERE updated_at > NOW() - INTERVAL '1 hour'
      `);
      
      return {
        triggerExists: triggerResult.rows[0].trigger_exists,
        recentActivity: parseInt(recentActivityResult.rows[0].recent_changes),
        healthy: triggerResult.rows[0].trigger_exists
      };
      
    } catch (error) {
      return { error: error.message, healthy: false };
    } finally {
      await sourceClient.end();
    }
  }

  formatStats(stats) {
    const timestamp = new Date().toLocaleString();
    
    console.log('\n' + '='.repeat(60));
    console.log(`📊 USER SYNC MONITORING DASHBOARD - ${timestamp}`);
    console.log('='.repeat(60));
    
    if (stats.error) {
      console.log(`❌ Error: ${stats.error}`);
      return;
    }
    
    // Overall status
    const statusIcon = stats.status.consistent ? '✅' : '⚠️ ';
    console.log(`\n🔍 OVERALL STATUS: ${statusIcon} ${stats.status.consistent ? 'HEALTHY' : 'NEEDS ATTENTION'}`);
    
    // Source database stats
    console.log('\n📈 SOURCE DATABASE (myusta_backend):');
    console.log(`   Total Users: ${stats.source.total.toLocaleString()}`);
    console.log(`   Active Users: ${stats.source.active.toLocaleString()}`);
    console.log(`   Updated (24h): ${stats.source.recent24h.toLocaleString()}`);
    
    console.log('\n   👥 Role Breakdown:');
    stats.source.roleBreakdown.forEach(role => {
      console.log(`      ${role.role}: ${parseInt(role.count).toLocaleString()}`);
    });
    
    // Chat database stats
    console.log('\n💬 CHAT DATABASE (myusta_chatapp):');
    console.log(`   Total Users: ${stats.chat.total.toLocaleString()}`);
    console.log(`   Updated (24h): ${stats.chat.recent24h.toLocaleString()}`);
    
    console.log('\n   👥 Role Breakdown:');
    stats.chat.roleBreakdown.forEach(role => {
      console.log(`      ${role.role}: ${parseInt(role.count).toLocaleString()}`);
    });
    
    // Sync analysis
    const difference = Math.abs(stats.source.active - stats.chat.total);
    console.log('\n🔄 SYNC ANALYSIS:');
    console.log(`   Source Active: ${stats.source.active.toLocaleString()}`);
    console.log(`   Chat Total: ${stats.chat.total.toLocaleString()}`);
    console.log(`   Difference: ${difference.toLocaleString()}`);
    
    if (difference === 0) {
      console.log('   Status: 🎯 Perfect sync!');
    } else if (difference <= 5) {
      console.log('   Status: ✅ Acceptable variance');
    } else if (difference <= 50) {
      console.log('   Status: ⚠️  Minor discrepancy');
    } else {
      console.log('   Status: 🚨 Major sync issue!');
    }
    
    // Discrepancies
    if (stats.discrepancies.length > 0) {
      console.log('\n🔍 FOUND DISCREPANCIES:');
      stats.discrepancies.forEach((disc, index) => {
        console.log(`   ${index + 1}. User ${disc.id}:`);
        if (!disc.chat_updated) {
          console.log('      ❌ Missing in chat database');
        } else if (disc.source_updated > disc.chat_updated) {
          console.log(`      ⏰ Outdated: Source(${disc.source_updated}) > Chat(${disc.chat_updated})`);
        } else if (disc.source_role !== disc.chat_role) {
          console.log(`      👤 Role mismatch: ${disc.source_role} != ${disc.chat_role}`);
        }
      });
    } else {
      console.log('\n✅ NO DISCREPANCIES FOUND');
    }
    
    console.log('\n' + '='.repeat(60));
  }

  async formatHealthCheck(health) {
    console.log('\n🏥 REPLICATION HEALTH CHECK:');
    
    if (health.error) {
      console.log(`   ❌ Error: ${health.error}`);
      return;
    }
    
    console.log(`   Trigger Status: ${health.triggerExists ? '✅ Active' : '❌ Missing'}`);
    console.log(`   Recent Activity: ${health.recentActivity} users updated (1h)`);
    console.log(`   Overall Health: ${health.healthy ? '✅ Healthy' : '🚨 Unhealthy'}`);
  }

  async startContinuousMonitoring(intervalSeconds = 30) {
    console.log(`🔄 Starting continuous monitoring (every ${intervalSeconds}s)...`);
    console.log('Press Ctrl+C to stop');
    
    const monitor = async () => {
      try {
        const [stats, health] = await Promise.all([
          this.getDetailedStats(),
          this.checkReplicationHealth()
        ]);
        
        // Clear console for live updating
        console.clear();
        
        this.formatStats(stats);
        await this.formatHealthCheck(health);
        
        // Show next update time
        const nextUpdate = new Date(Date.now() + intervalSeconds * 1000);
        console.log(`\n⏰ Next update: ${nextUpdate.toLocaleTimeString()}`);
        
      } catch (error) {
        console.error('❌ Monitor error:', error);
      }
    };
    
    // Initial check
    await monitor();
    
    // Schedule regular checks
    const interval = setInterval(monitor, intervalSeconds * 1000);
    
    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Stopping monitor...');
      clearInterval(interval);
      process.exit(0);
    });
  }
}

// Command line interface
if (require.main === module) {
  const monitor = new SyncMonitor();
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'stats':
      monitor.getDetailedStats()
        .then(stats => {
          monitor.formatStats(stats);
          process.exit(0);
        })
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;
      
    case 'health':
      monitor.checkReplicationHealth()
        .then(health => {
          monitor.formatHealthCheck(health);
          process.exit(0);
        })
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;
      
    case 'watch':
      const interval = parseInt(args[1]) || 30;
      monitor.startContinuousMonitoring(interval);
      break;
      
    default:
      console.log(`
📊 Sync Monitor Commands:

  node monitor.js stats                 - Show current sync statistics
  node monitor.js health                - Check replication health
  node monitor.js watch [interval]      - Continuous monitoring (default: 30s)

Examples:
  node monitor.js stats                 - One-time stats report
  node monitor.js watch 60              - Live monitoring every 60 seconds
      `);
      break;
  }
}

module.exports = SyncMonitor;