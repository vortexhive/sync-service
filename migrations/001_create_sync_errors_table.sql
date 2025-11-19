-- Migration: Create sync_errors table for error persistence
-- Database: myusta_chatapp
-- Description: Stores sync errors for monitoring, alerting, and retry logic

CREATE TABLE IF NOT EXISTS sync_errors (
  id SERIAL PRIMARY KEY,
  error_type VARCHAR(100) NOT NULL,
  user_id VARCHAR(255),
  error_message TEXT NOT NULL,
  error_stack TEXT,
  additional_data JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMP,
  retry_count INTEGER DEFAULT 0
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_sync_errors_error_type ON sync_errors(error_type);
CREATE INDEX IF NOT EXISTS idx_sync_errors_user_id ON sync_errors(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_errors_created_at ON sync_errors(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_errors_resolved ON sync_errors(resolved) WHERE resolved = FALSE;

-- Add comments for documentation
COMMENT ON TABLE sync_errors IS 'Stores errors encountered during user synchronization for monitoring and troubleshooting';
COMMENT ON COLUMN sync_errors.error_type IS 'Type of error (e.g., SYNC_USER_FAILED, BULK_SYNC_FAILED, REALTIME_SYNC_START_FAILED)';
COMMENT ON COLUMN sync_errors.user_id IS 'ID of the user that failed to sync (if applicable)';
COMMENT ON COLUMN sync_errors.error_message IS 'Error message text';
COMMENT ON COLUMN sync_errors.error_stack IS 'Full error stack trace for debugging';
COMMENT ON COLUMN sync_errors.additional_data IS 'Additional context data (user info, sync parameters, etc.)';
COMMENT ON COLUMN sync_errors.resolved IS 'Whether this error has been resolved/retried successfully';
COMMENT ON COLUMN sync_errors.retry_count IS 'Number of retry attempts for this error';
