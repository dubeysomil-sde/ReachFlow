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
}

export function createRecipientDraft(input: string): ComposerRecipient {
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
  role: string,
  jobId: string,
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
  role: string,
  jobId: string,
): string[] {
  const errors: string[] = [];
  if (!recipient.valid) errors.push('Invalid email address');
  if (recipient.duplicate) errors.push('Duplicate recipient');
  if (recipient.confidence === 'LOW' && (!recipient.firstName.trim() || !recipient.company.trim())) {
    errors.push('Confirm the recipient name and company');
  }
  try {
    assertSendable(subject, recipient.body, [role, jobId]);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Message is not ready to send');
  }
  return errors;
}

export function parseEmailList(value: string): string[] {
  return value.split(/[,\n;]+/).map((email) => email.trim()).filter(Boolean);
}
