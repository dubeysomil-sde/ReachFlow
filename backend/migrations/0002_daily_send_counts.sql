CREATE TABLE daily_send_counts (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  UNIQUE (user_id, day),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

INSERT INTO daily_send_counts (user_id, day, sent_count)
SELECT campaigns.user_id, substr(campaign_recipients.sent_at, 1, 10), COUNT(*)
FROM campaign_recipients
JOIN campaigns ON campaigns.id = campaign_recipients.campaign_id
WHERE campaign_recipients.sending_status = 'SENT' AND campaign_recipients.sent_at IS NOT NULL
GROUP BY campaigns.user_id, substr(campaign_recipients.sent_at, 1, 10);
