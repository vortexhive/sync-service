# Sync Service Cache Reconciliation - Architecture Review

**Date:** June 17, 2026
**Reviewed By:** Claude Code
**Version:** sync.js v2.0 (Cache Mode)

---

## Executive Summary

The sync-service cache reconciliation mode monitors Redis cache and reconciles the chat database users table. While the core logic is sound, there are several issues, edge cases, and potential improvements identified.

---

## 🔴 Critical Issues

### 1. Redis Connection Not Resilient
**Location:** `initRedis()` (line 1602)

**Problem:** If Redis connection drops during reconciliation, all cache lookups fail silently (return null). This causes ALL users to be marked as "cache miss" and potentially deactivated.

**Impact:** A Redis outage could mark ALL users as inactive within one reconciliation cycle.

**Fix Required:**
```javascript
async getCachedUser(userId) {
  // Check Redis connection health first
  if (!this.redis || this.redis.status !== 'ready') {
    this.log('ERROR', 'Redis not connected, skipping cache check');
    throw new Error('Redis unavailable');
  }
  // ... existing logic
}
```

### 2. No Filtering of Already-Inactive Users
**Location:** `getChatDbUsers()` (line 1663)

**Problem:** The query fetches ALL users including those already marked inactive. This wastes time checking users we've already processed.

**Current Query:**
```sql
SELECT ... FROM users WHERE "externalId" IS NOT NULL
```

**Fix Required:**
```sql
SELECT ... FROM users
WHERE "externalId" IS NOT NULL
  AND COALESCE(("metaData"->>'isActive')::boolean, true) = true
```

### 3. Duplicate Detection Logic Too Broad
**Location:** `deactivateDuplicateUsers()` (line 1775)

**Problem:** The OR condition `(email = $2 OR phone = $3)` is too broad. Two users with same phone but different emails would be incorrectly flagged as duplicates.

**Current Logic:**
```sql
WHERE (email = $2 AND email IS NOT NULL)
   OR (phone = $3 AND phone IS NOT NULL)
```

**Should Be:**
```sql
WHERE email = $2 AND email IS NOT NULL
  AND phone = $3 AND phone IS NOT NULL
  AND role = $4
```

Or use a more precise matching strategy (both email AND phone must match, or have specific dedup rules).

---

## 🟠 Medium Issues

### 4. Memory Leak in cacheMissCount Map
**Location:** Constructor (line 49)

**Problem:** If a user is in chat DB but never reaches the threshold (e.g., service restarts before threshold), entries accumulate forever.

**Fix Required:** Add periodic cleanup of old entries:
```javascript
// In reconcileCache, after processing all users:
// Clean up miss counts for users no longer in chat DB
const chatUserIds = new Set(chatUsers.map(u => u.externalId));
for (const [externalId] of this.cacheMissCount) {
  if (!chatUserIds.has(externalId)) {
    this.cacheMissCount.delete(externalId);
  }
}
```

### 5. No Batch Redis Operations
**Location:** `reconcileCache()` loop

**Problem:** Each user's cache is fetched individually with `this.redis.get()`. For 1000 users, this is 1000 network round-trips.

**Fix Required:** Use Redis pipeline or MGET:
```javascript
// Fetch all cached users at once
const cacheKeys = chatUsers.map(u => `${this.userCachePrefix}${u.externalId}`);
const cachedData = await this.redis.mget(cacheKeys);
```

### 6. Session Closing Incomplete
**Location:** `closeUserSessions()` (line 1822)

**Problem:** Only sets `isOnline=false` in database. Does NOT:
- Notify chatserver-ai to disconnect the socket
- Clear any in-memory presence data in chatserver
- Notify other users that this user is offline

**Impact:** User may appear online in chatserver memory until TTL expires.

**Fix Required:** Send notification to chatserver-ai:
```javascript
async closeUserSessions(externalId) {
  // ... existing DB update

  // Notify chatserver to force disconnect
  try {
    const chatserverUrl = process.env.CHATSERVER_URL || 'http://localhost:5000';
    await fetch(`${chatserverUrl}/api/internal/force-disconnect`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.INTERNAL_API_KEY },
      body: JSON.stringify({ userId: externalId })
    });
  } catch (e) {
    this.log('WARNING', `Failed to notify chatserver: ${e.message}`);
  }
}
```

### 7. Missing Database Index
**Location:** Duplicate detection query

**Problem:** Query filters on `"metaData"->>'isActive'` which is a JSONB field. Without an index, this becomes a full table scan.

**Fix Required:** Add migration:
```sql
CREATE INDEX idx_users_metadata_isactive
ON users ((("metaData"->>'isActive')::boolean));
```

---

## 🟡 Edge Cases

### 8. User Re-activates After Being Marked Inactive
**Scenario:** User is marked inactive, then logs back in to the app. Backend creates new cache entry.

**Current Behavior:** Next reconciliation cycle will see cache hit, but user's `metaData.isActive = false` in chat DB. The `hasChanges()` function doesn't check this.

**Impact:** User stays marked as inactive in chat DB even though they're active.

**Fix Required:**
```javascript
hasChanges(chatUser, cachedUser) {
  // Check if user was marked inactive but cache shows active
  const chatIsActive = chatUser.metaData?.isActive !== false;
  const cachedIsActive = cachedUser.status === 'active';
  if (!chatIsActive && cachedIsActive) return true;

  // ... existing comparisons
}
```

### 9. Concurrent Reconciliation with Service Restart
**Scenario:** Service restarts mid-reconciliation. `cacheMissCount` is lost.

**Impact:** Users who had 3/4 misses are reset to 0/4, delaying their inactivation.

**Acceptable:** This is by design (conservative approach), but should be documented.

### 10. Very Large User Base Performance
**Scenario:** 100,000+ users in chat DB

**Impact:** Each reconciliation cycle processes ALL users sequentially. At 10ms per user, this takes 1000+ seconds.

**Fix Required:** Add pagination or parallel processing:
```javascript
const BATCH_SIZE = 500;
const userBatches = [];
for (let i = 0; i < chatUsers.length; i += BATCH_SIZE) {
  userBatches.push(chatUsers.slice(i, i + BATCH_SIZE));
}

for (const batch of userBatches) {
  // Process batch in parallel
  await Promise.all(batch.map(user => this.processUser(user)));
}
```

### 11. Race Condition: Same User Processed Twice
**Scenario:** Reconciliation takes longer than interval (15s). Next cycle starts while previous is running.

**Current Mitigation:** `isSyncInProgress` flag prevents this.

**OK:** This is handled correctly.

---

## 🔵 Minor Improvements

### 12. No Validation of Cached Data
**Problem:** `JSON.parse(data)` could fail if cache data is corrupted.

**Current:** Error is caught, returns null (treated as cache miss).

**Improvement:** Log the corruption and potentially alert:
```javascript
catch (error) {
  if (error instanceof SyntaxError) {
    this.log('ERROR', `Corrupted cache data for ${userId}`);
    // Optionally: delete corrupted key
    await this.redis.del(cacheKey);
  }
  return null;
}
```

### 13. Logging Every User in DEBUG Mode
**Problem:** With thousands of users, DEBUG logs can be overwhelming.

**Improvement:** Add sampling or summary logs:
```javascript
// Log every 100th user instead of every user
if (i % 100 === 0) {
  this.log('DEBUG', `Progress: ${i}/${chatUsers.length} users processed`);
}
```

### 14. No Circuit Breaker for Redis
**Problem:** If Redis keeps failing, service keeps trying every 15 seconds.

**Improvement:** Add circuit breaker pattern:
```javascript
if (this.redisFailureCount > 5) {
  this.log('ERROR', 'Redis circuit breaker OPEN - too many failures');
  // Skip cache checks, don't mark users inactive
  return;
}
```

---

## Configuration Recommendations

### Environment Variables to Add
```bash
# Performance tuning
BATCH_SIZE=500                    # Users per batch
PARALLEL_FACTOR=5                 # Concurrent operations

# Circuit breakers
REDIS_MAX_FAILURES=5              # Failures before circuit opens
REDIS_CIRCUIT_RESET_MS=60000      # Time before retry

# Chatserver integration
CHATSERVER_URL=http://localhost:5000
INTERNAL_API_KEY=your-key-here

# Feature flags
NOTIFY_CHATSERVER_ON_INACTIVE=true
ENABLE_BATCH_REDIS=true
```

---

## Migration Required

### Add Index for Duplicate Detection
```sql
-- Migration: add_users_metadata_indexes.sql
CREATE INDEX CONCURRENTLY idx_users_metadata_isactive
ON users ((("metaData"->>'isActive')::boolean))
WHERE "metaData" IS NOT NULL;

CREATE INDEX CONCURRENTLY idx_users_email_phone_role
ON users (email, phone, role)
WHERE email IS NOT NULL OR phone IS NOT NULL;
```

---

## Summary

| Category | Count | Priority |
|----------|-------|----------|
| 🔴 Critical | 3 | Fix immediately |
| 🟠 Medium | 4 | Fix soon |
| 🟡 Edge Cases | 4 | Document/monitor |
| 🔵 Minor | 3 | Nice to have |

**Recommended Action:**
1. Fix Critical #1 (Redis resilience) - prevents mass deactivation on Redis outage
2. Fix Critical #2 (inactive filter) - improves performance significantly
3. Fix Critical #3 (duplicate logic) - prevents incorrect deactivations
4. Add database indexes (Migration Required)
5. Implement batch Redis operations (Medium #5)
