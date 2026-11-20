export type RecipientConfidence = 'HIGH' | 'LOW';

export interface ParsedRecipient {
  email: string;
  firstName: string;
  company: string;
  confidence: RecipientConfidence;
  warnings: string[];
}

const ROLE_MAILBOXES = new Set([
  'careers',
  'hr',
  'jobs',
  'info',
  'no-reply',
  'noreply',
  'support',
]);

const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail',
  'googlemail',
  'outlook',
  'hotmail',
  'live',
  'msn',
  'yahoo',
  'icloud',
  'me',
  'mac',
  'proton',
  'protonmail',
  'pm',
  'aol',
  'gmx',
  'yandex',
  'zoho',
]);

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'ac.in',
  'ac.jp',
  'ac.nz',
  'ac.uk',
  'co.in',
  'co.jp',
  'co.nz',
  'co.uk',
  'com.au',
  'com.br',
  'com.cn',
  'com.hk',
  'com.mx',
  'com.sg',
  'com.tr',
  'co.za',
  'net.au',
  'net.in',
  'org.au',
  'org.in',
  'org.uk',
]);

const EMAIL_PATTERN =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : '';
}

function getCompany(domain: string): { company: string; isPublicMail: boolean } {
  const labels = domain.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const suffixLength = MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) ? 2 : 1;
  const companyIndex = labels.length - suffixLength - 1;
  const company = companyIndex >= 0 ? labels[companyIndex] : '';

  return {
    company: capitalize(company),
    isPublicMail: PUBLIC_MAIL_DOMAINS.has(company),
  };
}

export function parseRecipient(input: string): ParsedRecipient {
  const email = input.trim().toLowerCase();
  if (
    /[\r\n]/.test(input) ||
    email.length > 254 ||
    !EMAIL_PATTERN.test(email) ||
    email.slice(0, email.indexOf('@')).length > 64
  ) {
    throw new Error('Invalid email address');
  }

  const [localPart, domain] = email.split('@');
  const localSegments = localPart.split(/[._+-]/);
  const roleMailbox = ROLE_MAILBOXES.has(localPart);
  const firstName = roleMailbox
    ? ''
    : capitalize((localSegments[0] ?? '').replace(/\d/g, ''));
  const { company: detectedCompany, isPublicMail } = getCompany(domain);
  const warnings: string[] = [];
  let company = detectedCompany;
  let confidence: RecipientConfidence = 'HIGH';

  if (isPublicMail || !company) {
    company = '';
    confidence = 'LOW';
    warnings.push('company cannot be detected');
  }

  if (roleMailbox || !firstName) {
    confidence = 'LOW';
    if (!roleMailbox) warnings.push('name cannot be detected');
  }

  return { email, firstName, company, confidence, warnings };
}
