export type UserRole = 'USER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'DISABLED';
export type EmailProvider = 'GMAIL';
export type EmailConnectionStatus = 'CONNECTED' | 'REVOKED' | 'ERROR';
export type CampaignStatus = 'DRAFT' | 'SENDING' | 'COMPLETED' | 'CANCELLED';
export type RecipientSendingStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SENT'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface UserRow {
  id: string;
  google_id: string;
  email: string;
  name: string;
  profile_picture: string | null;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface ConnectedEmailAccountRow {
  id: string;
  user_id: string;
  provider: EmailProvider;
  email_address: string;
  encrypted_refresh_token: string;
  token_iv: string;
  key_version: string;
  scopes: string;
  connection_status: EmailConnectionStatus;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplateRow {
  id: string;
  user_id: string;
  template_name: string;
  default_subject: string;
  default_body: string;
  created_at: string;
  updated_at: string;
}

export interface CampaignRow {
  id: string;
  user_id: string;
  template_id: string | null;
  campaign_name: string;
  status: CampaignStatus;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  attachment_filename: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface CampaignRecipientRow {
  id: string;
  campaign_id: string;
  recipient_email: string;
  recipient_name: string | null;
  recipient_company: string | null;
  recipient_role: string | null;
  recipient_job_id: string | null;
  use_custom_subject: 0 | 1;
  custom_subject: string | null;
  final_subject: string;
  final_body: string;
  sending_status: RecipientSendingStatus;
  attempt_count: number;
  gmail_message_id: string | null;
  error_message: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  invitation_token_hash: string;
  invited_by: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface AppSettingRow {
  key: string;
  value: string;
  updated_at: string;
}
