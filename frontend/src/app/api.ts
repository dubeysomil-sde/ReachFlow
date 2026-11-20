import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
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
  readonly emailMode?: 'MOCK' | 'GMAIL';
  onUnauthorized?: () => void;
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
  sendBatch(
    id: string,
    attachment: ResumeAttachment | null,
  ): Promise<{ processed: number; remaining: number }>;
  cancelCampaign(id: string): Promise<void>;
  retryFailed(id: string): Promise<number>;
  listGmailAccounts(): Promise<GmailAccount[]>;
  connectGmail(): Promise<void>;
  disconnectGmail(id: string): Promise<void>;
  getAdminData(): Promise<AdminData>;
  setRegistrationMode(mode: AdminData['registrationMode']): Promise<void>;
  createInvitation(email: string): Promise<Invitation>;
  setUserStatus(id: string, status: UserStatus): Promise<void>;
  deleteCampaigns(ids: string[] | 'all'): Promise<void>;
  deleteAccount(confirmation: string): Promise<void>;
  deleteInvitation(id: string): Promise<void>;
  deleteUser(id: string): Promise<void>;
  contactHistory(emails: string[]): Promise<{ email: string; sent_at: string }[]>;
}

export const APP_API = new InjectionToken<AppApi>('APP_API');

export class HttpApi implements AppApi {
  readonly mode = 'HTTP' as const;
  emailMode: 'MOCK' | 'GMAIL' = 'MOCK';
  onUnauthorized?: () => void;
  private csrfRequest: Promise<string> | null = null;

  constructor(private readonly http: HttpClient) {}

  async getMe(): Promise<ApiUser | null> {
    const response = await this.get<{ user: ApiUser | null; emailMode: 'MOCK' | 'GMAIL' }>(
      '/api/auth/me',
    );
    this.emailMode = response.emailMode;
    return response.user;
  }

  startGoogleSignIn(invite?: string): void {
    const query = invite ? `?invite=${encodeURIComponent(invite)}` : '';
    window.location.assign(`/api/auth/google/start${query}`);
  }

  async signInMock(): Promise<ApiUser> {
    throw new Error('Use Google to sign in here.');
  }

  async logout(): Promise<void> {
    await this.post('/api/auth/logout', {});
  }

  async listTemplates(): Promise<EmailTemplate[]> {
    return (await this.get<{ templates: EmailTemplate[] }>('/api/templates')).templates;
  }

  async saveTemplate(
    template: Omit<EmailTemplate, 'id'> & { id?: string },
  ): Promise<EmailTemplate> {
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
    return (
      await this.post<{ retried: number }>(
        `/api/campaigns/${encodeURIComponent(id)}/retry-failed`,
        {},
      )
    ).retried;
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
    const response = await this.post<{ invitation: Invitation }>('/api/admin/invitations', {
      email,
    });
    return response.invitation;
  }

  async setUserStatus(id: string, status: UserStatus): Promise<void> {
    await this.post(`/api/admin/users/${encodeURIComponent(id)}/status`, { status });
  }

  async deleteCampaigns(ids: string[] | 'all'): Promise<void> {
    if (ids !== 'all' && ids.length === 1) {
      await this.delete(`/api/campaigns/${encodeURIComponent(ids[0])}`);
    } else {
      await this.delete('/api/campaigns', ids === 'all' ? { all: true } : { ids });
    }
  }

  async deleteAccount(confirmation: string): Promise<void> {
    await this.delete('/api/auth/account', { confirmation });
  }

  async deleteInvitation(id: string): Promise<void> {
    await this.delete(`/api/admin/invitations/${encodeURIComponent(id)}`);
  }

  async deleteUser(id: string): Promise<void> {
    await this.delete(`/api/admin/users/${encodeURIComponent(id)}`);
  }

  async contactHistory(emails: string[]): Promise<{ email: string; sent_at: string }[]> {
    return (
      await this.post<{ contacts: { email: string; sent_at: string }[] }>(
        '/api/campaigns/contact-history',
        {
          emails,
        },
      )
    ).contacts;
  }

  private get<T>(url: string): Promise<T> {
    return this.request(firstValueFrom(this.http.get<T>(url, { withCredentials: true })));
  }

  private async post<T = unknown>(url: string, body: unknown): Promise<T> {
    const csrfToken = await this.csrfToken();
    return this.request(
      firstValueFrom(
        this.http.post<T>(url, body, {
          withCredentials: true,
          headers: new HttpHeaders({ 'X-CSRF-Token': csrfToken }),
        }),
      ),
    );
  }

  private async put<T = unknown>(url: string, body: unknown): Promise<T> {
    const csrfToken = await this.csrfToken();
    return this.request(
      firstValueFrom(
        this.http.put<T>(url, body, {
          withCredentials: true,
          headers: new HttpHeaders({ 'X-CSRF-Token': csrfToken }),
        }),
      ),
    );
  }

  private async delete<T = unknown>(url: string, body?: unknown): Promise<T> {
    const csrfToken = await this.csrfToken();
    return this.request(
      firstValueFrom(
        this.http.delete<T>(url, {
          withCredentials: true,
          headers: new HttpHeaders({ 'X-CSRF-Token': csrfToken }),
          ...(body === undefined ? {} : { body }),
        }),
      ),
    );
  }

  private async request<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (reason) {
      if (reason instanceof HttpErrorResponse && reason.status === 401) {
        this.csrfRequest = null;
        this.onUnauthorized?.();
      }
      throw reason;
    }
  }

  private csrfToken(): Promise<string> {
    this.csrfRequest ??= this.get<{ csrfToken: string }>('/api/auth/csrf')
      .then((response) => response.csrfToken)
      .catch((reason: unknown) => {
        this.csrfRequest = null;
        throw reason;
      });
    return this.csrfRequest;
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
  dailyCounts?: Record<string, number>;
}

const STORAGE_KEY = 'reachflow.mock.v1';
export const SAMPLE_SUBJECT = 'A quick introduction about [Role]';
export const SAMPLE_BODY =
  'Hi [Name],\n\nI came across your work at [Company].\n\nRole: [Role]\nJob ID: [JobId]\n\nWould you be open to a short conversation?\n\nBest,\nYour name';

export class MockApi implements AppApi {
  readonly mode = 'MOCK' as const;
  onUnauthorized?: () => void;
  private mockUser: ApiUser | null = null;

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
    if (!campaign) throw new Error('Send not found.');
    return campaign;
  }

  async sendBatch(
    id: string,
    _attachment: ResumeAttachment | null,
  ): Promise<{ processed: number; remaining: number }> {
    const state = this.state();
    const campaign = this.findCampaign(state, id);
    const day = this.now().toISOString().slice(0, 10);
    state.dailyCounts ??= {};
    const available = 100 - (state.dailyCounts[day] ?? 0);
    if (available <= 0) throw new Error('You reached the daily email limit. Try tomorrow.');
    const pending = (campaign.recipients ?? [])
      .filter((recipient) => recipient.sending_status === 'PENDING')
      .slice(0, Math.min(5, available));
    for (const recipient of pending) {
      if (this.random() < 0.1) {
        recipient.sending_status = 'FAILED';
        recipient.error_message = 'Simulated delivery failure';
        campaign.failed_count += 1;
      } else {
        recipient.sending_status = 'SENT';
        recipient.sent_at = this.now().toISOString();
        campaign.sent_count += 1;
        state.dailyCounts[day] = (state.dailyCounts[day] ?? 0) + 1;
      }
    }
    const remaining = (campaign.recipients ?? []).filter(
      (recipient) => recipient.sending_status === 'PENDING',
    ).length;
    campaign.sent_count = (campaign.recipients ?? []).filter(
      (recipient) => recipient.sending_status === 'SENT',
    ).length;
    campaign.failed_count = (campaign.recipients ?? []).filter(
      (recipient) => recipient.sending_status === 'FAILED',
    ).length;
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
    campaign.failed_count = (campaign.recipients ?? []).filter(
      (recipient) => recipient.sending_status === 'FAILED',
    ).length;
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
    const { link: _link, ...saved } = invitation;
    state.invitations.unshift(saved);
    this.save(state);
    return invitation;
  }

  async setUserStatus(id: string, status: UserStatus): Promise<void> {
    const state = this.state();
    state.users = state.users.map((user) => (user.id === id ? { ...user, status } : user));
    this.save(state);
  }

  async deleteCampaigns(ids: string[] | 'all'): Promise<void> {
    const state = this.state();
    const selected = state.campaigns.filter((entry) => ids === 'all' || ids.includes(entry.id));
    if (
      selected.some(
        (entry) =>
          entry.status === 'SENDING' ||
          entry.recipients?.some((person) => person.sending_status === 'PROCESSING'),
      )
    ) {
      throw new Error('Stop it first');
    }
    state.campaigns = state.campaigns.filter((entry) => !selected.includes(entry));
    this.save(state);
  }

  async deleteAccount(confirmation: string): Promise<void> {
    if (confirmation !== 'DELETE') throw new Error('Type DELETE to remove your account.');
    const state = this.state();
    if (state.campaigns.some((entry) => entry.status === 'SENDING'))
      throw new Error('Stop it first');
    this.save({
      user: null,
      templates: [],
      campaigns: [],
      accounts: [],
      users: [],
      invitations: [],
      registrationMode: 'INVITE_ONLY',
      dailyCounts: {},
    });
  }

  async deleteInvitation(id: string): Promise<void> {
    const state = this.state();
    state.invitations = state.invitations.filter((entry) => entry.id !== id);
    this.save(state);
  }

  async deleteUser(id: string): Promise<void> {
    const state = this.state();
    if (state.user?.id === id) throw new Error('You cannot remove your own admin account here.');
    state.users = state.users.filter((entry) => entry.id !== id);
    this.save(state);
  }

  async contactHistory(emails: string[]): Promise<{ email: string; sent_at: string }[]> {
    const contacts = new Map<string, string>();
    for (const send of this.state().campaigns) {
      for (const person of send.recipients ?? []) {
        if (
          person.sending_status === 'SENT' &&
          person.sent_at &&
          emails.includes(person.recipient_email)
        ) {
          const previous = contacts.get(person.recipient_email);
          if (!previous || previous < person.sent_at)
            contacts.set(person.recipient_email, person.sent_at);
        }
      }
    }
    return [...contacts].map(([email, sent_at]) => ({ email, sent_at }));
  }

  private state(): MockState {
    const stored = this.storage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const state = JSON.parse(stored) as MockState;
        state.user = this.mockUser;
        if (!state.dailyCounts) {
          state.dailyCounts = {};
          for (const send of state.campaigns) {
            for (const person of send.recipients ?? []) {
              if (person.sending_status === 'SENT' && person.sent_at) {
                const day = person.sent_at.slice(0, 10);
                state.dailyCounts[day] = (state.dailyCounts[day] ?? 0) + 1;
              }
            }
          }
        }
        return state;
      } catch {
        this.storage.setItem(STORAGE_KEY, '');
      }
    }
    return {
      user: this.mockUser,
      templates: [
        {
          id: 'mock-sample',
          template_name: 'Sample message',
          default_subject: SAMPLE_SUBJECT,
          default_body: SAMPLE_BODY,
        },
      ],
      campaigns: [],
      accounts: [],
      users: [],
      invitations: [],
      registrationMode: 'INVITE_ONLY',
    };
  }

  private save(state: MockState): void {
    this.mockUser = state.user;
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ ...state, user: null }));
  }

  private findCampaign(state: MockState, id: string): Campaign {
    const campaign = state.campaigns.find((entry) => entry.id === id);
    if (!campaign) throw new Error('Send not found.');
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

export async function runCampaignBatches(
  api: AppApi,
  id: string,
  attachment: ResumeAttachment | null,
  stopped: () => boolean,
  progress: (processed: number) => void,
): Promise<void> {
  let processed = 0;
  while (!stopped()) {
    const result = await api.sendBatch(id, attachment);
    processed += result.processed;
    progress(processed);
    if (!result.remaining || !result.processed) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await api.cancelCampaign(id);
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    DRAFT: 'Waiting',
    PENDING: 'Waiting',
    PROCESSING: 'Sending',
    SENDING: 'Sending',
    SENT: 'Sent',
    COMPLETED: 'Done',
    FAILED: 'Failed',
    CANCELLED: 'Stopped',
    UNKNOWN: 'Not sure - please check your Gmail Sent folder',
    ACTIVE: 'Active',
    DISABLED: 'Disabled',
  };
  return labels[status] ?? status;
}
