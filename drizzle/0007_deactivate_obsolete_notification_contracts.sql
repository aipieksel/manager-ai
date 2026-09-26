UPDATE slack_notification_routes
SET enabled = 0,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE enabled = 1;
