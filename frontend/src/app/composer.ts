import { ParsedRecipient, parseRecipient } from '../../../shared/core/recipientParser';
import { assertSendable, renderTemplate } from '../../../shared/core/templateRenderer';

export interface ComposerRecipient extends ParsedRecipient {
  key: string;
  valid: boolean;
  duplicate: boolean;
  useCustomSubject: boolean;
  customSubject: string;
  body: string;
  generatedBody: string;
  bodyEdited: boolean;
  role: string;
  jobId: string;
}

export function createRecipientDraft(input: string, role = '', jobId = ''): ComposerRecipient {
  try {
    const parsed = parseRecipient(input);
    return {
      ...parsed,
      key: `${parsed.email}-${crypto.randomUUID()}`,
      valid: true,
      duplicate: false,
      useCustomSubject: false,
      customSubject: '',
      body: '',
      generatedBody: '',
      bodyEdited: false,
      role,
      jobId,
    };
  } catch {
    const email = input.trim().toLowerCase();
    return {
      email,
      firstName: '',
      company: '',
      confidence: 'LOW',
      warnings: ['Invalid email address'],
      key: `${email || 'invalid'}-${crypto.randomUUID()}`,
      valid: false,
      duplicate: false,
      useCustomSubject: false,
      customSubject: '',
      body: '',
      generatedBody: '',
      bodyEdited: false,
      role,
      jobId,
    };
  }
}

export function markDuplicates(recipients: ComposerRecipient[]): ComposerRecipient[] {
  const seen = new Set<string>();
  return recipients.map((recipient) => {
    const duplicate = seen.has(recipient.email);
    seen.add(recipient.email);
    return { ...recipient, duplicate };
  });
}

export function renderDefaultBody(
  template: string,
  recipient: ComposerRecipient,
  role = recipient.role,
  jobId = recipient.jobId,
): string {
  return renderTemplate(template, {
    Name: recipient.firstName,
    Company: recipient.company,
    Role: role,
    JobId: jobId,
  }).text;
}

export function recipientSendErrors(
  recipient: ComposerRecipient,
  subject: string,
  role = recipient.role,
  jobId = recipient.jobId,
): string[] {
  const errors: string[] = [];
  if (!recipient.valid) errors.push('Check the email address.');
  if (recipient.duplicate) errors.push('This email is listed twice.');
  if (!recipient.firstName.trim()) errors.push('Fill in the name');
  if (!recipient.company.trim()) errors.push('Fill in the company');
  try {
    assertSendable(subject, recipient.body);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Message is not ready to send');
  }
  return errors;
}

export function defaultSubject(template: string, recipient: ComposerRecipient): string {
  return renderTemplate(
    template,
    {
      Name: recipient.firstName,
      Company: recipient.company,
      Role: recipient.role,
      JobId: recipient.jobId,
    },
    'subject',
  ).text;
}

export function finalSubject(template: string, recipient: ComposerRecipient): string {
  return recipient.useCustomSubject ? recipient.customSubject : defaultSubject(template, recipient);
}

export function editSubject(
  template: string,
  recipient: ComposerRecipient,
  subject: string,
): Partial<ComposerRecipient> {
  return {
    customSubject: subject,
    useCustomSubject: subject !== defaultSubject(template, recipient),
  };
}

export function parseEmailList(value: string): string[] {
  return value
    .split(/[,\n;]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}
