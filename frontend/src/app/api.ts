import { HttpClient, HttpHeaders } from '@angular/common/http';
import { InjectionToken } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type UserRole = 'USER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'DISABLED';
export type DeliveryStatus = 'PENDING' | 'PROCESSING' | 'SENT' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export interface ApiUser {
  id: string;
  email: string;
  name: string;
  profile_picture: string | null;
  role: UserRole;
  status?: UserStatus;
}

export interface EmailTemplate {
  id: string;
  template_name: string;
  default_subject: string;
  default_body: string;
  updated_at?: string;
}

export interface CampaignRecipient {
  id: string;
  recipient_email: string;
  recipient_name: string | null;
  recipient_company: string | null;
  recipient_role: string | null;
  recipient_job_id: string | null;
  final_subject: string;
  final_body: string;
  sending_status: DeliveryStatus;
  error_message: string | null;
  sent_at: string | null;
}

export interface Campaign {
  id: string;
  campaign_name: string;
  status: 'DRAFT' | 'SENDING' | 'COMPLETED' | 'CANCELLED';
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  recipients?: CampaignRecipient[];
}

export interface CampaignRecipientInput {
  email: string;
  recipient_name: string;
  recipient_company: string;
  recipient_role: string;
  recipient_job_id: string;
  use_custom_subject: boolean;
  custom_subject: string | null;
  final_subject: string;
  final_body: string;
}

export interface CreateCampaignInput {
  campaign_name: string;
  template_id: string | null;
  default_subject: string;
  default_body: string;
  recipients: CampaignRecipientInput[];
}

export interface ResumeAttachment {
  filename: string;
  contentType: string;
  base64: string;
}

export interface GmailAccount {
  id: string;
  email_address: string;
  connection_status: 'CONNECTED' | 'REVOKED' | 'ERROR';
}

export interface AdminUser extends ApiUser {
  status: UserStatus;
  created_at: string;
}

export interface Invitation {
  id: string;
  email: string;
  expires_at: string;
  used_at: string | null;
  link?: string;
}

export interface AdminData {
  registrationMode: 'INVITE_ONLY' | 'PUBLIC';
  counts: { users: number; campaigns: number; invitations: number };
  users: AdminUser[];
  invitations: Invitation[];
}

export interface AppApi {
  readonly mode: 'MOCK' | 'HTTP';
  getMe(): Promise<ApiUser | null>;
  startGoogleSignIn(invite?: string): void;
  signInMock(): Promise<ApiUser>;
  logout(): Promise<void>;
  listTemplates(): Promise<EmailTemplate[]>;
  saveTemplate(template: Omit<EmailTemplate, 'id'> & { id?: string }): Promise<EmailTemplate>;
  deleteTemplate(id: string): Promise<void>;
  createCampaign(input: CreateCampaignInput): Promise<Campaign>;
  listCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign>;
  sendBatch(id: string, attachment: ResumeAttachment | null): Promise<{ processed: number; remaining: number }>;
  cancelCampaign(id: string): Promise<void>;
  retryFailed(id: string): Promise<number>;
  listGmailAccounts(): Promise<GmailAccount[]>;
  connectGmail(): Promise<void>;
  disconnectGmail(id: string): Promise<void>;
  getAdminData(): Promise<AdminData>;
  setRegistrationMode(mode: AdminData['registrationMode']): Promise<void>;
  createInvitation(email: string): Promise<Invitation>;
  setUserStatus(id: string, status: UserStatus): Promise<void>;
}

export const APP_API = new InjectionToken<AppApi>('APP_API');

export class HttpApi implements AppApi {
  readonly mode = 'HTTP' as const;

  constructor(private readonly http: HttpClient) {}

  async getMe(): Promise<ApiUser | null> {
    const response = await this.get<{ user: ApiUser | null }>('/api/auth/me');
    return response.user;
  }

  startGoogleSignIn(invite?: string): void {
    const query = invite ? `?invite=${encodeURIComponent(invite)}` : '';
    window.location.assign(`/api/auth/google/start${query}`);
  }

  async signInMock(): Promise<ApiUser> {
    throw new Error('Mock sign-in is unavailable in HTTP mode');
  }

  async logout(): Promise<void> {
    await this.post('/api/auth/logout', {});
  }

  async listTemplates(): Promise<EmailTemplate[]> {
    return (await this.get<{ templates: EmailTemplate[] }>('/api/templates')).templates;
  }

  async saveTemplate(template: Omit<EmailTemplate, 'id'> & { id?: string }): Promise<EmailTemplate> {
    if (template.id) {
      await this.put(`/api/templates/${encodeURIComponent(template.id)}`, template);
      return template as EmailTemplate;
    }
    return (await this.post<{ template: EmailTemplate }>('/api/templates', template)).template;
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.delete(`/api/templates/${encodeURIComponent(id)}`);
  }

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    return (await this.post<{ campaign: Campaign }>('/api/campaigns', input)).campaign;
  }

  async listCampaigns(): Promise<Campaign[]> {
    return (await this.get<{ campaigns: Campaign[] }>('/api/campaigns')).campaigns;
  }

  async getCampaign(id: string): Promise<Campaign> {
    const response = await this.get<{ campaign: Campaign; recipients: Campaign['recipients'] }>(
      `/api/campaigns/${encodeURIComponent(id)}`,
    );
    return { ...response.campaign, recipients: response.recipients ?? [] };
  }

  async sendBatch(
    id: string,
    attachment: ResumeAttachment | null,
  ): Promise<{ processed: number; remaining: number }> {
    return this.post(`/api/campaigns/${encodeURIComponent(id)}/send-batch`, {
      batchSize: 8,
      ...(attachment ? { attachment } : {}),
    });
  }

  async cancelCampaign(id: string): Promise<void> {
    await this.post(`/api/campaigns/${encodeURIComponent(id)}/cancel`, {});
  }

  async retryFailed(id: string): Promise<number> {
    return (await this.post<{ retried: number }>(`/api/campaigns/${encodeURIComponent(id)}/retry-failed`, {})).retried;
  }

  async listGmailAccounts(): Promise<GmailAccount[]> {
    return (await this.get<{ accounts: GmailAccount[] }>('/api/auth/gmail')).accounts;
  }

  async connectGmail(): Promise<void> {
    window.location.assign('/api/auth/gmail/connect');
  }

  async disconnectGmail(id: string): Promise<void> {
    await this.post('/api/auth/gmail/disconnect', { accountId: id });
  }

  async getAdminData(): Promise<AdminData> {
    const [settings, users, invitations] = await Promise.all([
      this.get<Pick<AdminData, 'registrationMode' | 'counts'>>('/api/admin/settings'),
      this.get<{ users: AdminUser[] }>('/api/admin/users'),
      this.get<{ invitations: Invitation[] }>('/api/admin/invitations'),
    ]);
    return { ...settings, users: users.users, invitations: invitations.invitations };
  }

  async setRegistrationMode(mode: AdminData['registrationMode']): Promise<void> {
    await this.post('/api/admin/registration-mode', { mode });
  }

  async createInvitation(email: string): Promise<Invitation> {
    const response = await this.post<{ invitation: Invitation }>('/api/admin/invitations', { email });
    return response.invitation;
  }

  async setUserStatus(id: string, status: UserStatus): Promise<void> {
    await this.post(`/api/admin/users/${encodeURIComponent(id)}/status`, { status });
  }

  private get<T>(url: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(url, { withCredentials: true }));
  }

  private async post<T = unknown>(url: string, body: unknown): Promise<T> {
    const csrf = await this.get<{ csrfToken: string }>('/api/auth/csrf');
    return firstValueFrom(this.http.post<T>(url, body, {
      withCredentials: true,
      headers: new HttpHeaders({ 'X-CSRF-Token': csrf.csrfToken }),
    }));
  }

  private async put<T = unknown>(url: string, body: unknown): Promise<T> {
    const csrf = await this.get<{ csrfToken: string }>('/api/auth/csrf');
    return firstValueFrom(this.http.put<T>(url, body, {
      withCredentials: true,
      headers: new HttpHeaders({ 'X-CSRF-Token': csrf.csrfToken }),
    }));
  }

  private async delete<T = unknown>(url: string): Promise<T> {
    const csrf = await this.get<{ csrfToken: string }>('/api/auth/csrf');
    return firstValueFrom(this.http.delete<T>(url, {
      withCredentials: true,
      headers: new HttpHeaders({ 'X-CSRF-Token': csrf.csrfToken }),
    }));
  }
}

interface MockState {
  user: ApiUser | null;
  templates: EmailTemplate[];
  campaigns: Campaign[];
  accounts: GmailAccount[];
  users: AdminUser[];
  invitations: Invitation[];
  registrationMode: AdminData['registrationMode'];
}

const STORAGE_KEY = 'reachflow.mock.v1';
const SAMPLE_SUBJECT = 'A quick introduction about [Role]';
const SAMPLE_BODY =
  'Hi [Name],\n\nI came across your work at [Company] and wanted to share an opportunity for [Role] ([JobId]).\n\nWould you be open to a short conversation?\n\nBest,\nYour name';

export class MockApi implements AppApi {
  readonly mode = 'MOCK' as const;

  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
    private readonly random: () => number = Math.random,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getMe(): Promise<ApiUser | null> {
    return this.state().user;
  }

  startGoogleSignIn(): void {}

  async signInMock(): Promise<ApiUser> {
    const user: ApiUser = {
      id: 'mock-admin',
      email: 'demo@reachflow.local',
      name: 'ReachFlow Demo',
      profile_picture: null,
      role: 'ADMIN',
      status: 'ACTIVE',
    };
    const state = this.state();
    state.user = user;
    if (!state.users.some((entry) => entry.id === user.id)) {
      state.users.push({ ...user, status: 'ACTIVE', created_at: this.now().toISOString() });
    }
    this.save(state);
    return user;
  }

  async logout(): Promise<void> {
    const state = this.state();
    state.user = null;
    this.save(state);
  }

  async listTemplates(): Promise<EmailTemplate[]> {
    return this.state().templates;
  }

  async saveTemplate(input: Omit<EmailTemplate, 'id'> & { id?: string }): Promise<EmailTemplate> {
    const state = this.state();
    const template: EmailTemplate = {
      ...input,
      id: input.id ?? `mock-template-${crypto.randomUUID()}`,
      updated_at: this.now().toISOString(),
    };
    const index = state.templates.findIndex((entry) => entry.id === template.id);
    if (index >= 0) state.templates[index] = template;
    else state.templates.unshift(template);
    this.save(state);
    return template;
  }

  async deleteTemplate(id: string): Promise<void> {
    const state = this.state();
    state.templates = state.templates.filter((template) => template.id !== id);
    this.save(state);
  }

  async createCampaign(input: CreateCampaignInput): Promise<Campaign> {
    const state = this.state();
    const campaign: Campaign = {
      id: `mock-campaign-${crypto.randomUUID()}`,
      campaign_name: input.campaign_name,
      status: 'DRAFT',
      total_recipients: input.recipients.length,
      sent_count: 0,
      failed_count: 0,
      created_at: this.now().toISOString(),
      recipients: input.recipients.map((recipient, index) => ({
        id: `mock-recipient-${index}-${crypto.randomUUID()}`,
        recipient_email: recipient.email,
        recipient_name: recipient.recipient_name,
        recipient_company: recipient.recipient_company,
        recipient_role: recipient.recipient_role,
        recipient_job_id: recipient.recipient_job_id,
        final_subject: recipient.final_subject,
        final_body: recipient.final_body,
        sending_status: 'PENDING',
        error_message: null,
        sent_at: null,
      })),
    };
    state.campaigns.unshift(campaign);
    this.save(state);
    return campaign;
  }

  async listCampaigns(): Promise<Campaign[]> {
    return this.state().campaigns.map(({ recipients: _recipients, ...campaign }) => campaign);
  }

  async getCampaign(id: string): Promise<Campaign> {
    const campaign = this.state().campaigns.find((entry) => entry.id === id);
    if (!campaign) throw new Error('Campaign not found');
    return campaign;
  }

  async sendBatch(id: string, _attachment: ResumeAttachment | null): Promise<{ processed: number; remaining: number }> {
    const state = this.state();
    const campaign = this.findCampaign(state, id);
    const pending = (campaign.recipients ?? []).filter((recipient) => recipient.sending_status === 'PENDING').slice(0, 5);
    for (const recipient of pending) {
      if (this.random() < 0.1) {
        recipient.sending_status = 'FAILED';
        recipient.error_message = 'Simulated delivery failure';
        campaign.failed_count += 1;
      } else {
        recipient.sending_status = 'SENT';
        recipient.sent_at = this.now().toISOString();
        campaign.sent_count += 1;
      }
    }
    const remaining = (campaign.recipients ?? []).filter((recipient) => recipient.sending_status === 'PENDING').length;
    campaign.sent_count = (campaign.recipients ?? []).filter((recipient) => recipient.sending_status === 'SENT').length;
    campaign.failed_count = (campaign.recipients ?? []).filter((recipient) => recipient.sending_status === 'FAILED').length;
    campaign.status = remaining ? 'SENDING' : 'COMPLETED';
    this.save(state);
    return { processed: pending.length, remaining };
  }

  async cancelCampaign(id: string): Promise<void> {
    const state = this.state();
    const campaign = this.findCampaign(state, id);
    for (const recipient of campaign.recipients ?? []) {
      if (recipient.sending_status === 'PENDING') recipient.sending_status = 'CANCELLED';
    }
    campaign.status = 'CANCELLED';
    this.save(state);
  }

  async retryFailed(id: string): Promise<number> {
    const state = this.state();
    const campaign = this.findCampaign(state, id);
    let retried = 0;
    for (const recipient of campaign.recipients ?? []) {
      if (recipient.sending_status === 'FAILED') {
        recipient.sending_status = 'PENDING';
        recipient.error_message = null;
        retried += 1;
      }
    }
    if (retried) campaign.status = 'SENDING';
    campaign.failed_count = (campaign.recipients ?? []).filter((recipient) => recipient.sending_status === 'FAILED').length;
    this.save(state);
    return retried;
  }

  async listGmailAccounts(): Promise<GmailAccount[]> {
    return this.state().accounts;
  }

  async connectGmail(): Promise<void> {
    const state = this.state();
    if (!state.accounts.some((account) => account.connection_status === 'CONNECTED')) {
      state.accounts.push({
        id: 'mock-gmail-account',
        email_address: 'demo@gmail.com',
        connection_status: 'CONNECTED',
      });
    }
    this.save(state);
  }

  async disconnectGmail(id: string): Promise<void> {
    const state = this.state();
    state.accounts = state.accounts.map((account) =>
      account.id === id ? { ...account, connection_status: 'REVOKED' } : account,
    );
    this.save(state);
  }

  async getAdminData(): Promise<AdminData> {
    const state = this.state();
    return {
      registrationMode: state.registrationMode,
      counts: {
        users: state.users.length,
        campaigns: state.campaigns.length,
        invitations: state.invitations.length,
      },
      users: state.users,
      invitations: state.invitations,
    };
  }

  async setRegistrationMode(mode: AdminData['registrationMode']): Promise<void> {
    const state = this.state();
    state.registrationMode = mode;
    this.save(state);
  }

  async createInvitation(email: string): Promise<Invitation> {
    const token = crypto.randomUUID().replaceAll('-', '');
    const invitation: Invitation = {
      id: `mock-invitation-${crypto.randomUUID()}`,
      email,
      expires_at: new Date(this.now().getTime() + 7 * 86400_000).toISOString(),
      used_at: null,
      link: `${window.location.origin}/?invite=${token}`,
    };
    const state = this.state();
    state.invitations.unshift(invitation);
    this.save(state);
    return invitation;
  }

  async setUserStatus(id: string, status: UserStatus): Promise<void> {
    const state = this.state();
    state.users = state.users.map((user) => user.id === id ? { ...user, status } : user);
    this.save(state);
  }

  private state(): MockState {
    const stored = this.storage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored) as MockState;
      } catch {
        this.storage.setItem(STORAGE_KEY, '');
      }
    }
    return {
      user: null,
      templates: [{
        id: 'mock-sample',
        template_name: 'Sample referral',
        default_subject: SAMPLE_SUBJECT,
        default_body: SAMPLE_BODY,
      }],
      campaigns: [],
      accounts: [],
      users: [],
      invitations: [],
      registrationMode: 'INVITE_ONLY',
    };
  }

  private save(state: MockState): void {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  private findCampaign(state: MockState, id: string): Campaign {
    const campaign = state.campaigns.find((entry) => entry.id === id);
    if (!campaign) throw new Error('Campaign not found');
    return campaign;
  }
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const payload = (error as { error?: unknown }).error;
    if (typeof payload === 'object' && payload !== null && 'error' in payload) {
      return String((payload as { error: unknown }).error);
    }
    if (typeof payload === 'string') return payload;
  }
  if (error instanceof Error) return error.message;
  return 'The request could not be completed.';
}
