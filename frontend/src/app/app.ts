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
  runCampaignBatches,
  statusLabel,
  SAMPLE_SUBJECT,
  SAMPLE_BODY,
} from './api';
import {
  ComposerRecipient,
  createRecipientDraft,
  markDuplicates,
  parseEmailList,
  recipientSendErrors,
  renderDefaultBody,
  finalSubject,
  editSubject,
} from './composer';
import { renderTemplate } from '../../../shared/core/templateRenderer';

type Screen = 'compose' | 'review' | 'templates' | 'history' | 'admin';

const MAX_RESUME_BYTES = 1_572_864;

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
})
export class App {
  protected readonly api: AppApi = inject(APP_API);
  protected readonly user = signal<ApiUser | null>(null);
  protected readonly screen = signal<Screen>('templates');
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
  protected readonly contacted = signal<Record<string, string>>({});
  protected readonly selectedHistory = signal<string[]>([]);
  protected readonly statusLabel = statusLabel;

  protected inviteEmail = '';
  protected recipientInput = '';
  protected role = '';
  protected jobId = '';
  protected campaignName = 'New send';
  protected templateId = '';
  protected templateName = 'Referral introduction';
  protected defaultSubject = SAMPLE_SUBJECT;
  protected defaultBody = SAMPLE_BODY;
  protected mockAccountOpen = false;
  private cancelRequested = false;
  protected inviteToken = new URLSearchParams(window.location.search).get('invite') ?? '';

  constructor() {
    this.api.onUnauthorized = () => {
      this.user.set(null);
      this.recipients.set([]);
      this.attachment.set(null);
      this.gmailAccounts.set([]);
      this.selectedCampaign.set(null);
      this.error.set('Sign in with Google to continue.');
    };
    void this.initialize();
  }

  protected get isMock(): boolean {
    return this.api.mode === 'MOCK';
  }

  protected get isTestMode(): boolean {
    return this.isMock || this.api.emailMode !== 'GMAIL';
  }

  protected get canOpenAdmin(): boolean {
    return this.user()?.role === 'ADMIN';
  }

  protected get hasConnectedGmail(): boolean {
    return this.gmailAccounts().some((account) => account.connection_status === 'CONNECTED');
  }

  protected get senderAddress(): string {
    return (
      this.gmailAccounts().find((account) => account.connection_status === 'CONNECTED')
        ?.email_address ??
      (this.isMock ? (this.user()?.email ?? 'Demo sender') : 'Connect a Gmail account')
    );
  }

  protected get pendingCount(): number {
    return this.recipients().length;
  }

  protected async initialize(): Promise<void> {
    try {
      const currentUser = await this.api.getMe();
      this.user.set(currentUser);
      const authError = new URLSearchParams(window.location.search).get('auth_error');
      if (currentUser) {
        await this.loadWorkspace();
      }
      if (authError) this.error.set(this.authErrorMessage(authError));
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
    if (this.sending()) return;
    this.screen.set(screen);
    this.newInvitation.set('');
    this.error.set('');
    if (screen === 'history') void this.loadHistory();
    if (screen === 'admin') void this.loadAdmin();
  }

  protected async signOut(): Promise<void> {
    if (this.sending()) {
      this.error.set('Stop it first');
      return;
    }
    try {
      await this.api.logout();
      this.user.set(null);
      this.screen.set('compose');
      this.recipients.set([]);
      this.attachment.set(null);
      this.selectedCampaign.set(null);
      this.newInvitation.set('');
      this.mockAccountOpen = false;
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected addRecipients(): void {
    const addresses = parseEmailList(this.recipientInput);
    if (!addresses.length) return;
    if (addresses.length + this.recipients().length > 45) {
      this.error.set('Add up to 45 receivers to one send.');
      return;
    }
    this.recipients.set(
      markDuplicates([
        ...this.recipients(),
        ...addresses.map((email) => {
          const recipient = createRecipientDraft(email, this.role, this.jobId);
          const generatedBody = renderDefaultBody(this.defaultBody, recipient);
          return { ...recipient, body: generatedBody, generatedBody };
        }),
      ]),
    );
    this.recipientInput = '';
    this.error.set('');
    void this.loadContactHistory();
  }

  protected removeRecipient(key: string): void {
    this.recipients.set(
      markDuplicates(this.recipients().filter((recipient) => recipient.key !== key)),
    );
  }

  protected setRecipientEmail(key: string, value: string): void {
    const current = this.recipients().find((recipient) => recipient.key === key);
    if (!current) return;
    const parsed = createRecipientDraft(value, current.role, current.jobId);
    const replacement = parsed.valid
      ? {
          ...parsed,
          key: current.key,
          firstName: current.firstName || parsed.firstName,
          company: current.company || parsed.company,
          useCustomSubject: current.useCustomSubject,
          customSubject: current.customSubject,
          body: current.body,
          generatedBody: current.generatedBody,
          bodyEdited: current.bodyEdited,
        }
      : { ...parsed, key: current.key };
    this.recipients.set(
      markDuplicates(
        this.recipients().map((recipient) => (recipient.key === key ? replacement : recipient)),
      ),
    );
  }

  protected recipientPreviewSubject(recipient: ComposerRecipient): string {
    return finalSubject(this.defaultSubject, recipient);
  }

  protected setSubject(recipient: ComposerRecipient, subject: string): void {
    try {
      this.updateRecipient(recipient.key, editSubject(this.defaultSubject, recipient, subject));
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected isSubjectEdited(recipient: ComposerRecipient): boolean {
    return (
      recipient.useCustomSubject &&
      recipient.customSubject !==
        this.recipientPreviewSubject({
          ...recipient,
          useCustomSubject: false,
        })
    );
  }

  protected resetSubject(recipient: ComposerRecipient): void {
    if (
      recipient.useCustomSubject &&
      !window.confirm('Replace your edited subject with the default subject?')
    )
      return;
    this.updateRecipient(recipient.key, { useCustomSubject: false, customSubject: '' });
  }

  protected recipientPreviewBody(recipient: ComposerRecipient): string {
    if (recipient.bodyEdited) return recipient.body;
    return renderDefaultBody(this.defaultBody, recipient);
  }

  protected recipientErrors(recipient: ComposerRecipient): string[] {
    return recipientSendErrors(
      { ...recipient, body: this.recipientPreviewBody(recipient) },
      this.recipientPreviewSubject(recipient),
      this.role,
      this.jobId,
    );
  }

  protected isRecipientReady(recipient: ComposerRecipient): boolean {
    return this.recipientErrors(recipient).length === 0;
  }

  protected get readyRecipients(): ComposerRecipient[] {
    return this.recipients().filter((recipient) => this.isRecipientReady(recipient));
  }

  protected recipientWarnings(recipient: ComposerRecipient): string[] {
    const values = this.templateValues(recipient);
    const warnings: string[] = [];
    if (
      !recipient.useCustomSubject &&
      renderTemplate(this.defaultSubject, values, 'subject').warnings.length
    ) {
      warnings.push('Please check the subject');
    }
    if (!recipient.bodyEdited) {
      for (const sentence of renderTemplate(this.defaultBody, values).warnings) {
        warnings.push(`Please check the message: ${sentence}`);
      }
    }
    return warnings;
  }

  protected setAllRole(value: string): void {
    this.role = value;
    this.recipients.update((receivers) =>
      receivers.map((recipient) => ({ ...recipient, role: value })),
    );
  }

  protected setAllJobId(value: string): void {
    this.jobId = value;
    this.recipients.update((receivers) =>
      receivers.map((recipient) => ({ ...recipient, jobId: value })),
    );
  }

  protected importDefaultBody(recipient: ComposerRecipient): void {
    if (
      recipient.bodyEdited &&
      !window.confirm('Replace your edited message with the default message?')
    )
      return;
    try {
      const generatedBody = renderDefaultBody(this.defaultBody, recipient);
      this.updateRecipient(recipient.key, {
        generatedBody,
        body: generatedBody,
        bodyEdited: false,
      });
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected resetGeneratedBody(recipient: ComposerRecipient): void {
    if (
      recipient.bodyEdited &&
      !window.confirm('Replace your edited message with the default message?')
    )
      return;
    this.importDefaultBody({ ...recipient, bodyEdited: false });
  }

  protected updateRecipient(key: string, patch: Partial<ComposerRecipient>): void {
    this.recipients.set(
      this.recipients().map((recipient) =>
        recipient.key === key ? { ...recipient, ...patch } : recipient,
      ),
    );
  }

  protected proceedToReview(): void {
    if (!this.recipients().length) {
      this.error.set('Add at least one receiver before reviewing.');
      return;
    }
    if (!this.readyRecipients.length) {
      this.error.set('Fill in the missing details for at least one receiver.');
      return;
    }
    if (
      this.api.mode === 'HTTP' &&
      !this.gmailAccounts().some((account) => account.connection_status === 'CONNECTED')
    ) {
      this.error.set('Connect Gmail before sending.');
      return;
    }
    this.error.set('');
    this.screen.set('review');
  }

  protected async saveTemplate(): Promise<void> {
    if (!this.templateName.trim() || !this.defaultSubject.trim() || !this.defaultBody.trim()) {
      this.error.set('Add a name, subject and message.');
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
      this.templates.set([
        saved,
        ...this.templates().filter((template) => template.id !== saved.id),
      ]);
      this.toast.set('Message saved.');
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
    if (
      !this.templateId ||
      !window.confirm('Delete this saved message? This cannot be undone. Your History will stay.')
    )
      return;
    try {
      await this.api.deleteTemplate(this.templateId);
      this.templates.set(this.templates().filter((template) => template.id !== this.templateId));
      this.loadSampleTemplate();
      this.toast.set('Message deleted.');
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
    if (this.sending()) return;
    if (!this.readyRecipients.length) {
      this.error.set('Fill in the missing details for at least one receiver.');
      return;
    }
    if (
      !window.confirm(
        `Send ${this.readyRecipients.length} email${this.readyRecipients.length === 1 ? '' : 's'} from ${this.senderAddress}?`,
      )
    )
      return;
    const input = this.makeCampaignInput();
    this.sending.set(true);
    this.sendProgress.set(0);
    this.sendTotal.set(input.recipients.length);
    this.cancelRequested = false;
    this.error.set('');
    try {
      const campaign = await this.api.createCampaign(input);
      this.selectedCampaign.set(campaign);
      await runCampaignBatches(
        this.api,
        campaign.id,
        this.attachment(),
        () => this.cancelRequested,
        (count) => this.sendProgress.set(count),
      );
      this.selectedCampaign.set(await this.api.getCampaign(campaign.id));
      this.screen.set('history');
      await this.loadHistory();
      this.toast.set(
        this.cancelRequested ? 'Stopped. Emails already sent stay in Gmail.' : 'Send finished.',
      );
    } catch (reason) {
      this.error.set(errorMessage(reason));
      if (errorMessage(reason).includes('Gmail access has expired')) {
        await this.loadGmailAccounts();
        await this.loadHistory();
        this.screen.set('history');
      }
    } finally {
      this.sending.set(false);
    }
  }

  protected requestCancel(): void {
    this.cancelRequested = true;
  }

  protected hasWaiting(campaign: Campaign): boolean {
    return (
      campaign.recipients?.some((recipient) => recipient.sending_status === 'PENDING') ?? false
    );
  }

  protected async continueSending(): Promise<void> {
    const campaign = this.selectedCampaign();
    if (!campaign || this.sending()) return;
    this.sending.set(true);
    this.cancelRequested = false;
    this.error.set('');
    try {
      await runCampaignBatches(
        this.api,
        campaign.id,
        this.attachment(),
        () => this.cancelRequested,
        () => {},
      );
      await this.openCampaign(campaign.id);
      await this.loadHistory();
    } catch (reason) {
      this.error.set(errorMessage(reason));
      await this.loadGmailAccounts();
    } finally {
      this.sending.set(false);
    }
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
        this.toast.set('There are no failed emails to try again.');
        return;
      }
      this.sending.set(true);
      this.cancelRequested = false;
      await runCampaignBatches(
        this.api,
        campaign.id,
        this.attachment(),
        () => this.cancelRequested,
        () => {},
      );
      await this.openCampaign(campaign.id);
      await this.loadHistory();
      this.toast.set(`Tried ${retried} failed email${retried === 1 ? '' : 's'} again.`);
    } catch (reason) {
      this.error.set(errorMessage(reason));
      if (errorMessage(reason).includes('Gmail access has expired')) {
        await this.loadGmailAccounts();
      }
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
      this.toast.set('Waiting emails were stopped.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async connectGmail(): Promise<void> {
    try {
      await this.api.connectGmail();
      if (this.isMock) {
        await this.loadGmailAccounts();
        this.toast.set('Test sender connected. No real email will be sent.');
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
      this.toast.set(mode === 'PUBLIC' ? 'Anyone can now join.' : 'New users need an invite.');
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
      this.toast.set('Invite link copied.');
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

  protected removeAllRecipients(): void {
    if (!window.confirm('Remove all receivers from this send?')) return;
    this.recipients.set([]);
    this.contacted.set({});
  }

  protected toggleHistory(id: string, checked: boolean): void {
    this.selectedHistory.update((ids) =>
      checked ? [...new Set([...ids, id])] : ids.filter((entry) => entry !== id),
    );
  }

  protected async deleteHistory(ids: string[] | 'all'): Promise<void> {
    if (this.sending()) {
      this.error.set('Stop it first');
      return;
    }
    const target =
      ids === 'all'
        ? 'all of History'
        : ids.length > 1
          ? 'these from History'
          : 'this from History';
    if (
      !window.confirm(
        `Delete ${target}? This cannot be undone. Emails already sent stay in your Gmail Sent folder.`,
      )
    )
      return;
    try {
      await this.api.deleteCampaigns(ids);
      this.selectedCampaign.set(null);
      this.selectedHistory.set([]);
      await this.loadHistory();
      await this.loadContactHistory();
      this.toast.set('Deleted from History.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async deleteMyAccount(): Promise<void> {
    if (this.sending()) {
      this.error.set('Stop it first');
      return;
    }
    const confirmation = window.prompt(
      'Delete your account and all your data? This cannot be undone. Emails already sent stay in Gmail. Type DELETE to continue.',
    );
    if (confirmation === null) return;
    if (confirmation !== 'DELETE') {
      this.error.set('Type DELETE to remove your account.');
      return;
    }
    try {
      await this.api.deleteAccount(confirmation);
      this.user.set(null);
      this.recipients.set([]);
      this.history.set([]);
      this.templates.set([]);
      this.gmailAccounts.set([]);
      this.adminData.set(null);
      this.attachment.set(null);
      this.selectedCampaign.set(null);
      this.newInvitation.set('');
      this.mockAccountOpen = false;
      this.screen.set('compose');
      this.toast.set('Your account and data were deleted.');
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async deleteInvite(id: string): Promise<void> {
    if (!window.confirm('Delete this invite? It will no longer work.')) return;
    try {
      await this.api.deleteInvitation(id);
      this.newInvitation.set('');
      await this.loadAdmin();
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async deleteUser(member: AdminUser): Promise<void> {
    if (
      !window.confirm(
        `Remove ${member.email} and all their data? This cannot be undone. Emails already sent stay in Gmail.`,
      )
    )
      return;
    try {
      await this.api.deleteUser(member.id);
      await this.loadAdmin();
    } catch (reason) {
      this.error.set(errorMessage(reason));
    }
  }

  protected async loadContactHistory(): Promise<void> {
    try {
      const contacts = await this.api.contactHistory(
        this.recipients()
          .filter((entry) => entry.valid)
          .map((entry) => entry.email),
      );
      this.contacted.set(Object.fromEntries(contacts.map((entry) => [entry.email, entry.sent_at])));
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
    if (!this.isMock && accounts.some((account) => account.connection_status === 'CONNECTED')) {
      await this.loadHistory();
      const waiting = this.history().find((campaign) => campaign.status === 'SENDING');
      if (waiting) {
        await this.openCampaign(waiting.id);
        this.screen.set('history');
      }
    }
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

  private templateValues(recipient: ComposerRecipient): {
    Name: string;
    Company: string;
    Role: string;
    JobId: string;
  } {
    return {
      Name: recipient.firstName,
      Company: recipient.company,
      Role: recipient.role,
      JobId: recipient.jobId,
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
      campaign_name: this.campaignName.trim() || 'New send',
      template_id: this.templateId || null,
      default_subject: this.defaultSubject,
      default_body: this.defaultBody,
      recipients: this.readyRecipients.map((recipient) => ({
        email: recipient.email,
        recipient_name: recipient.firstName.trim(),
        recipient_company: recipient.company.trim(),
        recipient_role: recipient.role.trim(),
        recipient_job_id: recipient.jobId.trim(),
        use_custom_subject: recipient.useCustomSubject,
        custom_subject: recipient.useCustomSubject ? recipient.customSubject : null,
        final_subject: this.recipientPreviewSubject(recipient),
        final_body: this.recipientPreviewBody(recipient),
      })),
    };
  }

  private authErrorMessage(code: string): string {
    if (code === 'gmail_refresh_token_missing') {
      return 'Google did not return Gmail access for later. Connect Gmail again and allow access.';
    }
    if (code === 'gmail_connect_failed' || code === 'invalid_gmail_oauth_state') {
      return 'Gmail could not be connected. Try connecting again.';
    }
    if (code === 'invitation_required') return 'You need an invite to join. Use your invite link.';
    if (code === 'invalid_invitation')
      return 'That invite has expired, was used, or is for another email address.';
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
