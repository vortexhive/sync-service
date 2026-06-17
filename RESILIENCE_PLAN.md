# Cache & Sync Service Resilience Plan

**Date:** June 17, 2026
**Status:** Draft
**Owner:** Sync Service Team

---

## Issues to Address

| # | Issue | Severity | Impact |
|---|-------|----------|--------|
| 1 | Bulk operations don't invalidate cache | HIGH | Stale cache data after bulk updates |
| 2 | Blocking has no cache | HIGH | DB query on every message/typing event |
| 3 | 25 fields not cached | MEDIUM | Missing data for some features |
| 4 | Sync-service deprecation | MEDIUM | Need graceful migration |

---

## 1. Bulk Operations Cache Invalidation

### Problem
`afterBulkUpdate` and `afterBulkDestroy` hooks only log warnings - no cache invalidation.

```javascript
// Current (broken)
afterBulkUpdate: async (options) => {
  console.log('[UserCache] Bulk update detected - cache may be stale');
}
```

### Solution: Query-Based Invalidation

Since Sequelize doesn't provide instances in bulk hooks, we must query for affected users.

```javascript
// myusta-backend/src/models/User.js

afterBulkUpdate: async (options) => {
  const userCache = require('../services/userCache.service');
  const timestamp = new Date().toISOString();

  try {
    // Extract the WHERE clause from options
    const whereClause = options.where;
    if (!whereClause) {
      console.log(`[${timestamp}] [UserCache] Bulk update without WHERE - cannot invalidate`);
      return;
    }

    // Query for affected user IDs
    const { User } = require('../models');
    const affectedUsers = await User.findAll({
      where: whereClause,
      attributes: ['id'],
      raw: true
    });

    if (affectedUsers.length === 0) {
      console.log(`[${timestamp}] [UserCache] Bulk update affected 0 users`);
      return;
    }

    // Invalidate each affected user
    const invalidated = [];
    for (const user of affectedUsers) {
      await userCache.invalidateUser(user.id);
      invalidated.push(user.id.substring(0, 8));
    }

    console.log(`[${timestamp}] [UserCache] Bulk update: invalidated ${invalidated.length} users`);
  } catch (error) {
    console.error(`[${timestamp}] [UserCache] Bulk invalidation failed: ${error.message}`);
    // Don't throw - cache invalidation failure shouldn't break the operation
  }
},

afterBulkDestroy: async (options) => {
  const userCache = require('../services/userCache.service');
  const timestamp = new Date().toISOString();

  try {
    const whereClause = options.where;
    if (!whereClause) {
      console.log(`[${timestamp}] [UserCache] Bulk destroy without WHERE - flushing all user cache`);
      await userCache.flushAll(); // Nuclear option for safety
      return;
    }

    // For destroy, we need to query BEFORE the delete happens
    // This hook runs AFTER, so we need a beforeBulkDestroy hook too
    // OR we can invalidate based on WHERE clause patterns

    // Pattern matching for common bulk deletes
    if (whereClause.id) {
      const ids = Array.isArray(whereClause.id) ? whereClause.id : [whereClause.id];
      for (const id of ids) {
        await userCache.invalidateUser(id);
      }
      console.log(`[${timestamp}] [UserCache] Bulk destroy: invalidated ${ids.length} users`);
    } else if (whereClause.status === 'deleted') {
      // Can't know which users - may need to flush related keys
      console.log(`[${timestamp}] [UserCache] Bulk destroy by status - consider full cache refresh`);
    }
  } catch (error) {
    console.error(`[${timestamp}] [UserCache] Bulk destroy invalidation failed: ${error.message}`);
  }
}
```

### Alternative: Add beforeBulkDestroy Hook

```javascript
// Capture IDs before deletion
beforeBulkDestroy: async (options) => {
  const { User } = require('../models');

  if (options.where) {
    const toDelete = await User.findAll({
      where: options.where,
      attributes: ['id'],
      raw: true
    });
    // Store in options for afterBulkDestroy to use
    options._deletedUserIds = toDelete.map(u => u.id);
  }
},

afterBulkDestroy: async (options) => {
  const userCache = require('../services/userCache.service');
  const ids = options._deletedUserIds || [];

  for (const id of ids) {
    await userCache.invalidateUser(id);
  }
  console.log(`[UserCache] Bulk destroy: invalidated ${ids.length} users`);
}
```

### Testing

```javascript
// Test bulk update invalidation
await User.update(
  { status: 'inactive' },
  { where: { lastLoginAt: { [Op.lt]: thirtyDaysAgo } } }
);
// Verify: affected users should be invalidated from cache
```

---

## 2. Blocking Cache Implementation

### Problem
Every message send, typing event, and presence request queries the `blocked_users` table.

```javascript
// Current (slow)
const isBlocked = await BlockedUser.findOne({
  where: { [Op.or]: [...] }
});
```

### Solution: Redis Blocking Cache

**Location:** `chatserver-ai/services/blockingCache.ts`

```typescript
// chatserver-ai/services/blockingCache.ts

import * as redis from './redis';
import logger from '../utils/logger';

const BLOCK_CACHE_PREFIX = 'blocked:';
const BLOCK_CACHE_TTL = 300; // 5 minutes

interface BlockCacheEntry {
  blockedIds: string[];      // Users I have blocked
  blockedByIds: string[];    // Users who blocked me
  cachedAt: number;
}

/**
 * Check if user A has blocked user B (bidirectional)
 */
export const isBlocked = async (userA: string, userB: string): Promise<boolean> => {
  try {
    const cacheA = await getBlockCache(userA);
    const cacheB = await getBlockCache(userB);

    // Check if A blocked B OR B blocked A
    return cacheA.blockedIds.includes(userB) || cacheB.blockedIds.includes(userA);
  } catch (error) {
    logger.error('[BlockingCache] Check failed, falling back to DB', { userA, userB, error });
    return await checkBlockedFromDb(userA, userB);
  }
};

/**
 * Get block cache for a user
 */
const getBlockCache = async (userId: string): Promise<BlockCacheEntry> => {
  const cacheKey = `${BLOCK_CACHE_PREFIX}${userId}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss - fetch from DB and cache
  return await refreshBlockCache(userId);
};

/**
 * Refresh block cache from database
 */
export const refreshBlockCache = async (userId: string): Promise<BlockCacheEntry> => {
  const db = require('../db').default;
  const BlockedUser = db.getModels().BlockedUser;

  // Get users I blocked
  const blocked = await BlockedUser.findAll({
    where: { blockerId: userId },
    attributes: ['blockedId'],
    raw: true
  });

  // Get users who blocked me
  const blockedBy = await BlockedUser.findAll({
    where: { blockedId: userId },
    attributes: ['blockerId'],
    raw: true
  });

  const entry: BlockCacheEntry = {
    blockedIds: blocked.map(b => b.blockedId),
    blockedByIds: blockedBy.map(b => b.blockerId),
    cachedAt: Date.now()
  };

  // Cache it
  const cacheKey = `${BLOCK_CACHE_PREFIX}${userId}`;
  await redis.set(cacheKey, JSON.stringify(entry), BLOCK_CACHE_TTL);

  logger.debug('[BlockingCache] Refreshed cache', {
    userId: userId.substring(0, 8),
    blockedCount: entry.blockedIds.length,
    blockedByCount: entry.blockedByIds.length
  });

  return entry;
};

/**
 * Invalidate block cache when block/unblock happens
 */
export const invalidateBlockCache = async (blockerId: string, blockedId: string): Promise<void> => {
  const keys = [
    `${BLOCK_CACHE_PREFIX}${blockerId}`,
    `${BLOCK_CACHE_PREFIX}${blockedId}`
  ];

  await Promise.all(keys.map(key => redis.del(key)));
  logger.debug('[BlockingCache] Invalidated', { blockerId: blockerId.substring(0, 8), blockedId: blockedId.substring(0, 8) });
};

/**
 * Fallback to DB when cache fails
 */
const checkBlockedFromDb = async (userA: string, userB: string): Promise<boolean> => {
  const db = require('../db').default;
  const BlockedUser = db.getModels().BlockedUser;
  const { Op } = require('sequelize');

  const block = await BlockedUser.findOne({
    where: {
      [Op.or]: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA }
      ]
    }
  });

  return !!block;
};

export default {
  isBlocked,
  refreshBlockCache,
  invalidateBlockCache
};
```

### Add Hooks to BlockedUser Model

```typescript
// chatserver-ai/db/models/blocked-user.ts

import blockingCache from '../../services/blockingCache';

// Add after model definition
BlockedUser.afterCreate(async (instance) => {
  await blockingCache.invalidateBlockCache(instance.blockerId, instance.blockedId);
});

BlockedUser.afterDestroy(async (instance) => {
  await blockingCache.invalidateBlockCache(instance.blockerId, instance.blockedId);
});
```

### Update Message Service to Use Cache

```typescript
// chatserver-ai/services/socket/messageService.ts

import blockingCache from '../blockingCache';

// Replace direct DB query with cache check
const handleSendMessage = async (socket, data) => {
  const { senderId, recipientId } = data;

  // Fast cache check instead of DB query
  if (await blockingCache.isBlocked(senderId, recipientId)) {
    return { error: 'Cannot send message to this user' };
  }

  // ... rest of message handling
};
```

### Performance Impact

| Operation | Before (DB) | After (Cache) | Improvement |
|-----------|-------------|---------------|-------------|
| Block check | ~5-15ms | ~0.5-2ms | 5-10x faster |
| Typing event | ~5-15ms | ~0.5-2ms | 5-10x faster |
| Message send | ~5-15ms | ~0.5-2ms | 5-10x faster |

---

## 3. Cache Missing Fields

### Current Cache Schema (21 fields)
```
id, email, name, firstName, lastName, phone, avatarUrl, role, status,
preferredLanguage, autoReplyEnabled, autoReplyMessage, privacySettings,
notificationPreference, bio, isVerified, averageRating, totalRatings, cachedAt
```

### Recommended Additions (Priority Order)

| Field | Use Case | Priority |
|-------|----------|----------|
| `isOnline` | Presence display | HIGH |
| `lastSeenAt` | "Last seen" feature | HIGH |
| `ustaRatingAverage` | USTA-specific rating | MEDIUM |
| `customerRatingAverage` | Customer-specific rating | MEDIUM |
| `totalJobsCompleted` | Profile display | MEDIUM |
| `memberSince` | Trust indicator | LOW |
| `verificationLevel` | Trust badges | LOW |

### Implementation

```javascript
// myusta-backend/src/services/userCache.service.js

// Expand cache schema
const buildCacheData = (user) => ({
  // Existing fields...
  id: user.id,
  email: user.email,
  // ...

  // NEW: Presence fields (sync-service will update these)
  isOnline: false,  // Updated by chatserver-ai
  lastSeenAt: null, // Updated by chatserver-ai

  // NEW: Bidirectional ratings
  ustaRatingAverage: user.usta_rating_average || null,
  customerRatingAverage: user.customer_rating_average || null,

  // NEW: Activity stats
  totalJobsCompleted: user.total_jobs_completed || 0,
  memberSince: user.created_at,

  // Metadata
  cachedAt: Date.now(),
  cacheVersion: 2  // Increment when schema changes
});
```

---

## 4. Sync-Service Deprecation Strategy

### Current State
- Sync-service runs every 60 seconds
- Syncs users from backend DB to chat DB
- Also handles blocked_users sync

### Migration Plan

#### Phase 1: Dual-Write Mode (Current)
```
Backend → Redis Cache (primary)
Backend → sync-service → Chat DB (secondary, being deprecated)
```

#### Phase 2: Cache-Only Mode
```
Backend → Redis Cache
Chat DB only stores: socketId, isOnline, lastSeenAt, conversationData
```

#### Phase 3: Full Deprecation
1. Stop sync-service PM2 process
2. Remove backend→chat user sync
3. Chat DB schema simplified to presence-only

### Sync-Service Shutdown Checklist

```bash
# 1. Verify UserRepository is working
curl https://chat.myusta.dev/api/v1/health | jq '.cache'

# 2. Monitor cache hit rate for 7 days
# Should be >95% for user data

# 3. Stop sync-service (keep for rollback)
pm2 stop user-sync-service

# 4. Monitor for 3 days
# Watch for: "User not found" errors in chatserver-ai logs

# 5. If stable, delete the process
pm2 delete user-sync-service
```

### Rollback Plan

```bash
# If issues arise, restart sync-service
pm2 start user-sync-service

# Force full sync
cd /root/sync-service
node sync.js sync-all
```

---

## 5. Circuit Breaker Patterns

### Already Implemented (sync-service)
- Redis circuit breaker in reconcileCache
- Auto-reset after 60 seconds
- Prevents mass deactivation on Redis outage

### Need to Add (chatserver-ai)

```typescript
// chatserver-ai/services/circuitBreaker.ts

interface CircuitBreakerState {
  failures: number;
  isOpen: boolean;
  lastFailure: number | null;
  maxFailures: number;
  resetAfterMs: number;
}

const circuits: Map<string, CircuitBreakerState> = new Map();

export const getCircuit = (name: string): CircuitBreakerState => {
  if (!circuits.has(name)) {
    circuits.set(name, {
      failures: 0,
      isOpen: false,
      lastFailure: null,
      maxFailures: parseInt(process.env.CIRCUIT_MAX_FAILURES || '5'),
      resetAfterMs: parseInt(process.env.CIRCUIT_RESET_MS || '30000')
    });
  }
  return circuits.get(name)!;
};

export const recordFailure = (name: string): boolean => {
  const circuit = getCircuit(name);
  circuit.failures++;
  circuit.lastFailure = Date.now();

  if (circuit.failures >= circuit.maxFailures) {
    circuit.isOpen = true;
    console.log(`[CircuitBreaker] ${name} OPENED after ${circuit.failures} failures`);
    return true; // Circuit opened
  }
  return false;
};

export const checkReset = (name: string): boolean => {
  const circuit = getCircuit(name);
  if (!circuit.isOpen) return false;

  const elapsed = Date.now() - (circuit.lastFailure || 0);
  if (elapsed >= circuit.resetAfterMs) {
    circuit.isOpen = false;
    circuit.failures = 0;
    console.log(`[CircuitBreaker] ${name} RESET`);
    return true;
  }
  return false;
};

export const isOpen = (name: string): boolean => {
  checkReset(name);
  return getCircuit(name).isOpen;
};
```

### Usage

```typescript
import { isOpen, recordFailure } from './circuitBreaker';

const getUserFromCache = async (userId: string) => {
  // Check circuit before making Redis call
  if (isOpen('redis-user-cache')) {
    console.log('[UserRepository] Circuit open, using DB fallback');
    return fetchFromDatabase(userId);
  }

  try {
    const cached = await redis.get(`user:${userId}`);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    recordFailure('redis-user-cache');
    return fetchFromDatabase(userId);
  }
};
```

---

## 6. Monitoring & Alerting

### Key Metrics to Track

| Metric | Threshold | Alert Level |
|--------|-----------|-------------|
| Cache hit rate | < 80% | WARNING |
| Cache hit rate | < 50% | CRITICAL |
| Redis latency | > 50ms | WARNING |
| Redis latency | > 200ms | CRITICAL |
| Circuit breaker open | Any | WARNING |
| Bulk invalidation failures | > 3/hour | WARNING |
| Block cache misses | > 100/min | WARNING |

### Prometheus Metrics

```typescript
// Add to chatserver-ai and sync-service

const metrics = {
  cacheHits: new Counter('cache_hits_total', 'Total cache hits'),
  cacheMisses: new Counter('cache_misses_total', 'Total cache misses'),
  cacheLatency: new Histogram('cache_latency_ms', 'Cache operation latency'),
  circuitBreakerState: new Gauge('circuit_breaker_open', 'Circuit breaker state'),
  blockCacheHits: new Counter('block_cache_hits_total', 'Block cache hits'),
  bulkInvalidations: new Counter('bulk_invalidations_total', 'Bulk invalidation operations')
};
```

---

## Implementation Priority

| # | Task | Effort | Impact | Priority |
|---|------|--------|--------|----------|
| 1 | Blocking cache in chatserver-ai | 2 days | HIGH | P0 |
| 2 | Bulk operation invalidation | 1 day | HIGH | P0 |
| 3 | Circuit breaker in chatserver-ai | 1 day | MEDIUM | P1 |
| 4 | Cache schema expansion | 0.5 days | MEDIUM | P1 |
| 5 | Sync-service deprecation | 1 week | LOW | P2 |
| 6 | Monitoring setup | 1 day | MEDIUM | P1 |

---

## Rollback Procedures

### If Blocking Cache Fails
```bash
# Disable blocking cache
export BLOCKING_CACHE_ENABLED=false
pm2 restart chat-notification-server --update-env
```

### If Bulk Invalidation Breaks
```bash
# Flush entire user cache (nuclear option)
redis-cli KEYS "user:*" | xargs redis-cli DEL

# Or restart cache warmup
curl -X POST http://localhost:3000/api/internal/cache/warmup
```

### If Circuit Breaker Too Aggressive
```bash
# Increase thresholds
export CIRCUIT_MAX_FAILURES=10
export CIRCUIT_RESET_MS=15000
pm2 restart chat-notification-server --update-env
```

---

## Success Criteria

- [ ] Cache hit rate > 95%
- [ ] Block check latency < 5ms (p99)
- [ ] Zero mass deactivations from Redis outages
- [ ] Sync-service safely deprecated
- [ ] No "stale cache" bugs reported
