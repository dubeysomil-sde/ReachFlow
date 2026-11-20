import { CommonModule } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  APP_API,
  AdminData,
  AdminUser,
  ApiUser,
  AppApi,
  Campaign,
  CampaignRecipientInput,
  EmailTemplate,
  GmailAccount,
  ResumeAttachment,
  UserStatus,
  errorMessage,
} from './api';
import {
  ComposerRecipient,
  createRecipientDraft,
  markDuplicates,
  parseEmailList,
  recipientSendErrors,
  renderDefaultBody,
} from './composer';
import { renderTemplate } from '../../../shared/core/templateRenderer';

type Screen = 'compose' | 'review' | 'templates' | 'history' | 'admin';

const SAMPLE_SUBJECT = 'A quick introduction about [Role]';
const SAMPLE_BODY =
  'Hi [Name],\n\nI came across your work at [Company] and wanted to share an opportunity for [Role] ([JobId]).\n\nWould you be open to a short conversation?\n\nBest,\nYour name';
const MAX_RESUME_BYTES = 1_572_864;

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
})
export class App {
  protected readonly api: AppApi = inject(APP_API);
  protected readonly user = signal<ApiUser | null>(null);
  protected readonly screen = signal<Screen>('compose');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly toast = signal('');
  protected readonly error = signal('');
  protected readonly templates = signal<EmailTemplate[]>([]);
  protected readonly recipients = signal<ComposerRecipient[]>([]);
  protected readonly gmailAccounts = signal<GmailAccount[]>([]);
  protected readonly adminData = signal<AdminData | null>(null);
  protected readonly history = signal<Campaign[]>([]);
  protected readonly selectedCampaign = signal<Campaign | null>(null);
  protected readonly sending = signal(false);
  protected readonly sendProgress = signal(0);
  protected readonly sendTotal = signal(0);
  protected readonly newInvitation = signal('');
  protected readonly attachment = signal<ResumeAttachment | null>(null);

  protected inviteEmail = '';
  protected recipientInput = '';
  protected role = '';
  protected jobId = '';
  protected campaignName = 'New outreach campaign';
  protected templateId = '';
  protected templateName = 'Referral introduction';
  protected defaultSubject = SAMPLE_SUBJECT;
  protected defaultBody = SAMPLE_BODY;
  protected mockAccountOpen = false;
  private cancelRequested = false;
  protected inviteToken = new URLSearchParams(window.location.search).get('invite') ?? '';

  constructor() {
    void this.initialize();
  }

  protected get isMock(): boolean {
    return this.api.mode === 'MOCK';
  }

  protected get canOpenAdmin(): boolean {
    return this.user()?.role === 'ADMIN';
  }

  protected get hasConnectedGmail(): boolean {
    return this.gmailAccounts().some((account) => account.connection_status === 'CONNECTED');
  }

  protected get senderAddress(): string {
    return this.gmailAccounts().find((account) => account.connection_status === 'CONNECTED')?.email_address
      ?? (this.isMock ? this.user()?.email ?? 'Demo sender' : 'Connect a Gmail account');
  }

  protected get pendingCount(): number {
    return this.recipients().length;
  }

  protected async initialize(): Promise<void> {
    try {
      const currentUser = await this.api.getMe();
      this.user.set(currentUser);
      if (currentUser) {
        await this.loadWorkspace();
      } else {
        const authError = new URLSearchParams(window.location.search).get('auth_error');
        if (authError) this.error.set(this.authErrorMessage(authError));
      }
    } catch (reason) {
      this.error.set(errorMessage(reason));
    } finally {
      this.loading.set(false);
    }
  }

  protected async signIn(): Promise<void> {
    this.error.set('');
    if (!this.isMock) {
      this.api.startGoogleSignIn(this.inviteToken || undefined);
      return;
    }
    try {
      this.busy.set(true);
      this.user.set(await this.api.signInMock());
      await this.loadWorkspace();
      this.inviteToken = '';
    } catch (reason) {
      this.error.set(errorMessage(reason));
    } finally {
      this.busy.set(false);
    }
  }

  protected navigate(screen: Screen): void {
    this.screen.set(screen);
    this.error.set('');
    if (screen === 'history') void this.loadHistory();
    if (screen === 'admin') void this.loadAdmin();
  }

  protected async signOut(): Promise<void> {
    try {
      await this.api.logout();
      this.user.set(null);
      this.screen.set('compose');
      this.recipients.set([]);
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected addRecipients(): void {
    const addresses = parseEmailList(this.recipientInput);
    if (!addresses.length) return;
    this.recipients.set(markDuplicates([
      ...this.recipients(),
      ...addresses.map((email) => createRecipientDraft(email)),
    ]));
    this.recipientInput = '';
    this.error.set('');
  }

  protected removeRecipient(key: string): void {
    this.recipients.set(markDuplicates(this.recipients().filter((recipient) => recipient.key !== key)));
  }

  protected setRecipientEmail(key: string, value: string): void {
    const current = this.recipients().find((recipient) => recipient.key === key);
    if (!current) return;
    const parsed = createRecipientDraft(value);
    const replacement = parsed.valid
      ? {
          ...parsed,
          firstName: current.firstName || parsed.firstName,
          company: current.company || parsed.company,
          useCustomSubject: current.useCustomSubject,
          customSubject: current.customSubject,
          body: current.body,
          generatedBody: current.generatedBody,
          bodyEdited: current.bodyEdited,
        }
      : { ...parsed, key: current.key };
    this.recipients.set(markDuplicates(this.recipients().map((recipient) =>
      recipient.key === key ? replacement : recipient,
    )));
  }

  protected recipientPreviewSubject(recipient: ComposerRecipient): string {
    const value = recipient.useCustomSubject ? recipient.customSubject : this.defaultSubject;
    return renderTemplate(value, this.templateValues(recipient)).text;
  }

  protected recipientErrors(recipient: ComposerRecipient): string[] {
    return recipientSendErrors(
      recipient,
      this.recipientPreviewSubject(recipient),
      this.role,
      this.jobId,
    );
  }

  protected isRecipientReady(recipient: ComposerRecipient): boolean {
    return this.recipientErrors(recipient).length === 0;
  }

  protected importDefaultBody(recipient: ComposerRecipient): void {
    if (recipient.bodyEdited && !window.confirm('Replace your manual message edits with the generated default body?')) return;
    const generatedBody = renderDefaultBody(this.defaultBody, recipient, this.role, this.jobId);
    this.updateRecipient(recipient.key, { generatedBody, body: generatedBody, bodyEdited: false });
  }

  protected resetGeneratedBody(recipient: ComposerRecipient): void {
    if (recipient.bodyEdited && !window.confirm('Reset this message to the generated default body?')) return;
    this.importDefaultBody({ ...recipient, bodyEdited: false });
  }

  protected updateRecipient(key: string, patch: Partial<ComposerRecipient>): void {
    this.recipients.set(this.recipients().map((recipient) =>
      recipient.key === key ? { ...recipient, ...patch } : recipient,
    ));
  }

  protected proceedToReview(): void {
    if (!this.recipients().length) {
      this.error.set('Add at least one recipient before reviewing.');
      return;
    }
    const invalid = this.recipients().flatMap((recipient) => this.recipientErrors(recipient));
    if (invalid.length) {
      this.error.set('Resolve every recipient warning and message placeholder before sending.');
      return;
    }
    if (this.api.mode === 'HTTP' && !this.gmailAccounts().some((account) => account.connection_status === 'CONNECTED')) {
      this.error.set('Connect a Gmail account before reviewing a real send.');
      return;
    }
    this.error.set('');
    this.screen.set('review');
  }

  protected async saveTemplate(): Promise<void> {
    if (!this.templateName.trim() || !this.defaultSubject.trim() || !this.defaultBody.trim()) {
      this.error.set('Template name, subject and body are required.');
      return;
    }
    try {
      this.busy.set(true);
      const saved = await this.api.saveTemplate({
        ...(this.templateId ? { id: this.templateId } : {}),
        template_name: this.templateName.trim(),
        default_subject: this.defaultSubject,
        default_body: this.defaultBody,
      });
      this.templateId = saved.id;
      this.templates.set([saved, ...this.templates().filter((template) => template.id !== saved.id)]);
      this.toast.set('Template saved.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    } finally {
      this.busy.set(false);
    }
  }

  protected loadSampleTemplate(): void {
    this.templateId = '';
    this.templateName = 'Referral introduction';
    this.defaultSubject = SAMPLE_SUBJECT;
    this.defaultBody = SAMPLE_BODY;
  }

  protected selectTemplate(id: string): void {
    const template = this.templates().find((candidate) => candidate.id === id);
    if (!template) return;
    this.templateId = template.id;
    this.templateName = template.template_name;
    this.defaultSubject = template.default_subject;
    this.defaultBody = template.default_body;
  }

  protected async deleteCurrentTemplate(): Promise<void> {
    if (!this.templateId || !window.confirm('Delete this template?')) return;
    try {
      await this.api.deleteTemplate(this.templateId);
      this.templates.set(this.templates().filter((template) => template.id !== this.templateId));
      this.loadSampleTemplate();
      this.toast.set('Template deleted.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async selectResume(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.attachment.set(null);
    if (!file) return;
    if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) {
      this.error.set('Choose a PDF file.');
      input.value = '';
      return;
    }
    if (file.size > MAX_RESUME_BYTES) {
      this.error.set('The PDF must be 1.5 MB or smaller for a Worker request.');
      input.value = '';
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const base64 = this.toBase64(bytes);
      this.attachment.set({ filename: file.name, contentType: file.type, base64 });
      this.error.set('');
    } catch {
      this.error.set('The selected PDF could not be read.');
    }
  }

  protected removeResume(): void {
    this.attachment.set(null);
  }

  protected async startSending(): Promise<void> {
    if (!window.confirm(`Send ${this.recipients().length} personalized messages to ${this.senderAddress}?`)) return;
    const input = this.makeCampaignInput();
    this.sending.set(true);
    this.sendProgress.set(0);
    this.sendTotal.set(input.recipients.length);
    this.cancelRequested = false;
    this.error.set('');
    try {
      const campaign = await this.api.createCampaign(input);
      let completed = 0;
      let remaining = input.recipients.length;
      do {
        if (this.cancelRequested) break;
        const result = await this.api.sendBatch(campaign.id, this.attachment());
        completed += result.processed;
        remaining = result.remaining;
        this.sendProgress.set(completed);
        if (result.processed === 0) break;
      } while (remaining > 0);
      if (this.cancelRequested) await this.api.cancelCampaign(campaign.id);
      this.selectedCampaign.set(await this.api.getCampaign(campaign.id));
      this.screen.set('history');
      await this.loadHistory();
      this.toast.set(this.cancelRequested ? 'Campaign paused; pending recipients were cancelled.' : 'Campaign run finished.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    } finally {
      this.sending.set(false);
    }
  }

  protected requestCancel(): void {
    this.cancelRequested = true;
  }

  protected async openCampaign(id: string): Promise<void> {
    try {
      this.selectedCampaign.set(await this.api.getCampaign(id));
      this.error.set('');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async retryFailed(): Promise<void> {
    const campaign = this.selectedCampaign();
    if (!campaign) return;
    try {
      const retried = await this.api.retryFailed(campaign.id);
      if (!retried) {
        this.toast.set('There are no failed recipients to retry.');
        return;
      }
      this.sending.set(true);
      this.cancelRequested = false;
      let remaining = retried;
      while (remaining > 0) {
        if (this.cancelRequested) break;
        const result = await this.api.sendBatch(campaign.id, this.attachment());
        remaining = result.remaining;
        if (!result.processed) break;
      }
      if (this.cancelRequested) await this.api.cancelCampaign(campaign.id);
      await this.openCampaign(campaign.id);
      await this.loadHistory();
      this.toast.set(`Retried ${retried} failed recipient${retried === 1 ? '' : 's'}.`);
    } catch (reason) {
      this.error.set(errorMessage(reason));
    } finally {
      this.sending.set(false);
    }
  }

  protected async cancelSelectedCampaign(): Promise<void> {
    const campaign = this.selectedCampaign();
    if (!campaign) return;
    try {
      await this.api.cancelCampaign(campaign.id);
      await this.openCampaign(campaign.id);
      await this.loadHistory();
      this.toast.set('Pending recipients cancelled.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async connectGmail(): Promise<void> {
    try {
      await this.api.connectGmail();
      if (this.isMock) {
        await this.loadGmailAccounts();
        this.toast.set('Mock Gmail account connected. No email will be sent.');
      }
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async disconnectGmail(account: GmailAccount): Promise<void> {
    if (!window.confirm(`Disconnect ${account.email_address}?`)) return;
    try {
      await this.api.disconnectGmail(account.id);
      await this.loadGmailAccounts();
      this.toast.set('Gmail account disconnected.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async loadAdmin(): Promise<void> {
    try {
      this.adminData.set(await this.api.getAdminData());
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async setRegistrationMode(mode: AdminData['registrationMode']): Promise<void> {
    try {
      await this.api.setRegistrationMode(mode);
      await this.loadAdmin();
      this.toast.set(`Registration mode set to ${mode}.`);
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async createInvitation(): Promise<void> {
    try {
      const invitation = await this.api.createInvitation(this.inviteEmail.trim().toLowerCase());
      this.newInvitation.set(invitation.link ?? '');
      this.inviteEmail = '';
      await this.loadAdmin();
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async copyInvitation(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.newInvitation());
      this.toast.set('Invitation link copied.');
    } catch {
      this.error.set('The link could not be copied. Select and copy it manually.');
    }
  }

  protected async toggleUser(user: AdminUser): Promise<void> {
    const status: UserStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    if (!window.confirm(`${status === 'DISABLED' ? 'Disable' : 'Enable'} ${user.email}?`)) return;
    try {
      await this.api.setUserStatus(user.id, status);
      await this.loadAdmin();
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected prettyDate(value: string): string {
    return new Date(value).toLocaleString();
  }

  protected clearMessages(): void {
    this.error.set('');
    this.toast.set('');
  }

  private async loadWorkspace(): Promise<void> {
    const [templates, accounts] = await Promise.all([
      this.api.listTemplates(),
      this.api.listGmailAccounts(),
    ]);
    this.templates.set(templates);
    this.gmailAccounts.set(accounts);
    if (templates.length && !templates.some((template) => template.id === this.templateId)) {
      this.selectTemplate(templates[0].id);
    }
  }

  private async loadGmailAccounts(): Promise<void> {
    this.gmailAccounts.set(await this.api.listGmailAccounts());
  }

  private async loadHistory(): Promise<void> {
    try {
      this.history.set(await this.api.listCampaigns());
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  private templateValues(recipient: ComposerRecipient): { Name: string; Company: string; Role: string; JobId: string } {
    return {
      Name: recipient.firstName,
      Company: recipient.company,
      Role: this.role,
      JobId: this.jobId,
    };
  }

  private makeCampaignInput(): {
    campaign_name: string;
    template_id: string | null;
    default_subject: string;
    default_body: string;
    recipients: CampaignRecipientInput[];
  } {
    return {
      campaign_name: this.campaignName.trim() || 'Outreach campaign',
      template_id: this.templateId || null,
      default_subject: this.defaultSubject,
      default_body: this.defaultBody,
      recipients: this.recipients().map((recipient) => ({
        email: recipient.email,
        recipient_name: recipient.firstName.trim(),
        recipient_company: recipient.company.trim(),
        recipient_role: this.role.trim(),
        recipient_job_id: this.jobId.trim(),
        use_custom_subject: recipient.useCustomSubject,
        custom_subject: recipient.useCustomSubject ? recipient.customSubject : null,
        final_subject: this.recipientPreviewSubject(recipient).trim(),
        final_body: recipient.body.trim(),
      })),
    };
  }

  private authErrorMessage(code: string): string {
    if (code === 'invitation_required') return 'This workspace is invite-only. Use an invitation link to register.';
    if (code === 'invalid_invitation') return 'That invitation is invalid, expired, used or for another email address.';
    return 'Google sign-in could not be completed.';
  }

  private toBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }
}
