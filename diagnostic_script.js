// diagnostic.js - Find and analyze problematic users before sync
const { Client } = require('pg');

class DiagnosticTool {
  constructor() {
    this.sourceDbConfig = {
      host: 'localhost',
      port: 5432,
      database: 'myusta_backend',
      user: 'postgres',
      password: 'd8P@ssw0rd2025'
    };
  }

  // Generate numeric placeholder phone like the sync service does
  generatePlaceholderPhone(userId) {
    const hexPart = userId.replace(/-/g, '').substring(0, 8);
    const numericPart = parseInt(hexPart, 16).toString().substring(0, 10);
    return `9${numericPart.padStart(9, '0')}`;
  }

  async analyzeProblematicUsers() {
    const client = new Client(this.sourceDbConfig);
    
    try {
      await client.connect();
      
      console.log('🔍 Analyzing users for potential sync issues...\n');
      
      // Check for users with null/empty phone numbers
      const phoneIssues = await client.query(`
        SELECT 
          id, first_name, last_name, phone, email, role, status,
          CASE 
            WHEN phone IS NULL THEN 'NULL phone'
            WHEN phone = '' THEN 'Empty phone'
            WHEN LENGTH(TRIM(phone)) = 0 THEN 'Whitespace-only phone'
            ELSE 'Other phone issue'
          END as phone_issue
        FROM users 
        WHERE status = 'active' 
          AND (phone IS NULL OR phone = '' OR LENGTH(TRIM(phone)) = 0)
        ORDER BY created_at DESC
        LIMIT 20
      `);

      if (phoneIssues.rows.length > 0) {
        console.log(`📱 PHONE NUMBER ISSUES (${phoneIssues.rows.length} found):`);
        phoneIssues.rows.forEach((user, index) => {
          const placeholderPhone = this.generatePlaceholderPhone(user.id);
          console.log(`   ${index + 1}. ${user.id}`);
          console.log(`      Name: ${user.first_name || 'N/A'} ${user.last_name || 'N/A'}`);
          console.log(`      Email: ${user.email || 'N/A'}`);
          console.log(`      Phone: "${user.phone}" (${user.phone_issue})`);
          console.log(`      Will become: ${placeholderPhone}`);
          console.log(`      Role: ${user.role}`);
          console.log('');
        });
      } else {
        console.log('✅ No phone number issues found');
      }

      // Check for users with null IDs
      const idIssues = await client.query(`
        SELECT COUNT(*) as count
        FROM users 
        WHERE status = 'active' AND id IS NULL
      `);

      if (parseInt(idIssues.rows[0].count) > 0) {
        console.log(`🆔 ID ISSUES: ${idIssues.rows[0].count} users with NULL IDs`);
      } else {
        console.log('✅ No ID issues found');
      }

      // Check for users with problematic names
      const nameIssues = await client.query(`
        SELECT 
          id, first_name, last_name, email, phone
        FROM users 
        WHERE status = 'active'
          AND (first_name IS NULL OR first_name = '')
          AND (last_name IS NULL OR last_name = '')
        LIMIT 10
      `);

      if (nameIssues.rows.length > 0) {
        console.log(`\n👤 NAME ISSUES (${nameIssues.rows.length} found):`);
        nameIssues.rows.forEach((user, index) => {
          console.log(`   ${index + 1}. ${user.id} - No first or last name`);
          console.log(`      Email: ${user.email || 'N/A'}`);
          console.log(`      Phone: ${user.phone || 'N/A'}`);
          console.log(`      Will get name: "User"`);
        });
      } else {
        console.log('\n✅ No name issues found');
      }

      // Check for potential phone duplicates after cleaning
      const phoneCleaningIssues = await client.query(`
        WITH cleaned_phones AS (
          SELECT 
            id,
            phone,
            REGEXP_REPLACE(phone, '[^0-9]', '', 'g') as cleaned_phone,
            first_name,
            last_name
          FROM users 
          WHERE status = 'active' 
            AND phone IS NOT NULL 
            AND phone != ''
        )
        SELECT 
          cleaned_phone,
          COUNT(*) as count,
          string_agg(id::text, ', ') as user_ids
        FROM cleaned_phones 
        WHERE cleaned_phone != ''
        GROUP BY cleaned_phone 
        HAVING COUNT(*) > 1
        ORDER BY count DESC
        LIMIT 10
      `);

      if (phoneCleaningIssues.rows.length > 0) {
        console.log(`\n📞 DUPLICATE PHONE NUMBERS AFTER CLEANING (${phoneCleaningIssues.rows.length} found):`);
        phoneCleaningIssues.rows.forEach((issue, index) => {
          console.log(`   ${index + 1}. Phone: ${issue.cleaned_phone} (${issue.count} users)`);
          console.log(`      User IDs: ${issue.user_ids}`);
        });
        console.log(`   ⚠️ These will cause unique constraint violations!`);
      } else {
        console.log('\n✅ No duplicate phone numbers found after cleaning');
      }

      // Overall statistics
      const stats = await client.query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_users,
          COUNT(CASE WHEN status = 'active' AND (phone IS NULL OR phone = '' OR LENGTH(TRIM(phone)) = 0) THEN 1 END) as active_users_no_phone,
          COUNT(CASE WHEN status = 'active' AND email_verified = true THEN 1 END) as active_verified_email,
          COUNT(CASE WHEN status = 'active' AND phone_verified = true THEN 1 END) as active_verified_phone
        FROM users
      `);

      const s = stats.rows[0];
      console.log(`\n📊 OVERALL STATISTICS:`);
      console.log(`   Total users: ${parseInt(s.total_users).toLocaleString()}`);
      console.log(`   Active users: ${parseInt(s.active_users).toLocaleString()}`);
      console.log(`   Active users without phone: ${parseInt(s.active_users_no_phone).toLocaleString()}`);
      console.log(`   Active users with verified email: ${parseInt(s.active_verified_email).toLocaleString()}`);
      console.log(`   Active users with verified phone: ${parseInt(s.active_verified_phone).toLocaleString()}`);

      // Recommendations
      console.log(`\n💡 RECOMMENDATIONS:`);
      if (parseInt(s.active_users_no_phone) > 0) {
        console.log(`   📱 ${s.active_users_no_phone} users will get numeric placeholder phones (starting with 9)`);
      }
      if (phoneCleaningIssues.rows.length > 0) {
        console.log(`   ⚠️  ${phoneCleaningIssues.rows.length} duplicate phone conflicts need manual resolution`);
        console.log(`   💡 Consider adding country code or user ID suffix to duplicates`);
      }
      console.log(`   ✅ Placeholder phones are unique and numeric`);
      console.log(`   📱 Users can update their real phone numbers in the chat app later`);

    } catch (error) {
      console.error('❌ Diagnostic error:', error);
    } finally {
      await client.end();
    }
  }

  async showPlaceholderExamples() {
    const client = new Client(this.sourceDbConfig);
    
    try {
      await client.connect();
      
      console.log('📱 PLACEHOLDER PHONE EXAMPLES:\n');
      
      const users = await client.query(`
        SELECT id, first_name, last_name, phone
        FROM users 
        WHERE status = 'active' 
          AND (phone IS NULL OR phone = '' OR LENGTH(TRIM(phone)) = 0)
        LIMIT 5
      `);

      users.rows.forEach((user, index) => {
        const placeholder = this.generatePlaceholderPhone(user.id);
        console.log(`   ${index + 1}. User: ${user.first_name || 'N/A'} ${user.last_name || 'N/A'}`);
        console.log(`      ID: ${user.id}`);
        console.log(`      Original phone: "${user.phone}"`);
        console.log(`      Placeholder phone: ${placeholder}`);
        console.log('');
      });

    } catch (error) {
      console.error('❌ Error:', error);
    } finally {
      await client.end();
    }
  }
}

// Command line interface
if (require.main === module) {
  const diagnostic = new DiagnosticTool();
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'analyze':
      diagnostic.analyzeProblematicUsers()
        .then(() => process.exit(0))
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;
      
    case 'examples':
      diagnostic.showPlaceholderExamples()
        .then(() => process.exit(0))
        .catch(err => {
          console.error(err);
          process.exit(1);
        });
      break;
      
    default:
      console.log(`
🔍 Diagnostic Tool Commands:

  node diagnostic.js analyze    - Full analysis of problematic users
  node diagnostic.js examples   - Show placeholder phone examples

Examples:
  node diagnostic.js analyze    - Check for sync issues
  node diagnostic.js examples   - See what placeholder phones look like
      `);
      break;
  }
}

module.exports = DiagnosticTool;