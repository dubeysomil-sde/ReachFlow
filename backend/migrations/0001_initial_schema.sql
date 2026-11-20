CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  google_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  profile_picture TEXT,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE connected_email_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('GMAIL')),
  email_address TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  key_version TEXT NOT NULL,
  scopes TEXT NOT NULL,
  connection_status TEXT NOT NULL CHECK (
    connection_status IN ('CONNECTED', 'REVOKED', 'ERROR')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, email_address),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE email_templates (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  template_name TEXT NOT NULL,
  default_subject TEXT NOT NULL,
  default_body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, template_name),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  template_id TEXT,
  campaign_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN ('DRAFT', 'SENDING', 'COMPLETED', 'CANCELLED')
  ),
  total_recipients INTEGER NOT NULL DEFAULT 0 CHECK (total_recipients >= 0),
  sent_count INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  attachment_filename TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES email_templates (id) ON DELETE SET NULL
);

CREATE TABLE campaign_recipients (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  recipient_company TEXT,
  recipient_role TEXT,
  recipient_job_id TEXT,
  use_custom_subject INTEGER NOT NULL DEFAULT 0 CHECK (use_custom_subject IN (0, 1)),
  custom_subject TEXT,
  final_subject TEXT NOT NULL,
  final_body TEXT NOT NULL,
  sending_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    sending_status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED', 'UNKNOWN')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  gmail_message_id TEXT,
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (campaign_id, recipient_email),
  FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  invitation_token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (invited_by) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_campaigns_user_created_at
  ON campaigns (user_id, created_at);

CREATE INDEX idx_campaign_recipients_campaign_sending_status
  ON campaign_recipients (campaign_id, sending_status);

CREATE INDEX idx_email_templates_user
  ON email_templates (user_id);

CREATE INDEX idx_invitations_email
  ON invitations (email);

INSERT INTO app_settings (key, value)
VALUES ('registration_mode', 'INVITE_ONLY');
