import {
  createRecipientDraft,
  markDuplicates,
  recipientSendErrors,
  renderDefaultBody,
  finalSubject,
  editSubject,
} from './composer';
import { SAMPLE_BODY, SAMPLE_SUBJECT } from './api';
import { renderTemplate } from '../../../shared/core/templateRenderer';

describe('recipient composer logic', () => {
  it('keeps final subjects in sync until edited and supports reset', () => {
    let person = createRecipientDraft('alex@acme.com', 'Engineer', '42');
    expect(finalSubject('Hi [Name] about [Role]', person)).toBe('Hi Alex about Engineer');
    person = { ...person, ...editSubject('Hi [Name]', person, 'My own subject') };
    expect(person.useCustomSubject).toBe(true);
    expect(finalSubject('Changed [Name]', person)).toBe('My own subject');
    person = { ...person, useCustomSubject: false };
    expect(finalSubject('Changed [Name]', person)).toBe('Changed Alex');
    person = { ...person, ...editSubject('Changed [Name]', person, 'Changed Alex') };
    expect(person.useCustomSubject).toBe(false);
  });

  it('allows cold emails, role only, job only and both without unfinished blanks', () => {
    for (const [role, jobId] of [
      ['', ''],
      ['Engineer', ''],
      ['', '42'],
      ['Engineer', '42'],
    ]) {
      const person = createRecipientDraft('alex@acme.com', role, jobId);
      person.body = renderDefaultBody(SAMPLE_BODY, person);
      const subject = finalSubject(SAMPLE_SUBJECT, person);
      expect(recipientSendErrors(person, subject)).toEqual([]);
      expect(person.body.includes('Role:')).toBe(!!role);
      expect(person.body.includes('Job ID:')).toBe(!!jobId);
      expect(person.body).toContain('I came across your work at Acme.');
      expect(person.body.includes('\n\n\n')).toBe(false);
      expect(subject).toBe(
        role ? 'A quick introduction about Engineer' : 'A quick introduction about',
      );
      expect(renderTemplate(SAMPLE_SUBJECT, { Role: role }, 'subject').warnings.length).toBe(
        role ? 0 : 1,
      );
    }
    const person = createRecipientDraft('alex@acme.com');
    person.firstName = '';
    person.company = '';
    person.body = renderDefaultBody('Hello [Name] at [Company]', person);
    expect(recipientSendErrors(person, 'Hello')).toContain('Fill in the name');
    expect(recipientSendErrors(person, 'Hello')).toContain('Fill in the company');
  });
  it('detects duplicates and invalid addresses', () => {
    const recipients = markDuplicates([
      createRecipientDraft('alex@birdeye.com'),
      createRecipientDraft('ALEX@BIRDEYE.COM'),
      createRecipientDraft('broken-address'),
    ]);

    expect(recipients[0].duplicate).toBe(false);
    expect(recipients[1].duplicate).toBe(true);
    expect(recipients[2].valid).toBe(false);
  });

  it('renders the imported default body with recipient and campaign values', () => {
    const recipient = createRecipientDraft('iqbal.kaur@birdeye.com');
    expect(
      renderDefaultBody(
        'Hi [Name] at [Company], role [Role], job [JobId]',
        recipient,
        'Designer',
        'RF-42',
      ),
    ).toBe('Hi Iqbal at Birdeye, role Designer, job RF-42');
  });

  it('blocks low confidence recipients and unresolved values until corrected', () => {
    const recipient = createRecipientDraft('person@gmail.com');
    recipient.body = 'Hello [Name]';
    expect(recipientSendErrors(recipient, 'Subject', '', '')).toContain('Fill in the company');
    expect(recipientSendErrors(recipient, 'Subject', '', '')).toContain(
      'These blanks are still empty: Name',
    );

    recipient.firstName = 'Sam';
    recipient.company = 'Acme';
    recipient.body = 'Hello Sam at Acme';
    expect(recipientSendErrors(recipient, 'Subject', 'Designer', 'RF-42')).toEqual([]);
  });

  it('blocks unresolved custom subjects so they cannot reach send', () => {
    const recipient = createRecipientDraft('alex@company.com');
    recipient.body = 'Hello there';
    recipient.useCustomSubject = true;
    recipient.customSubject = 'An opportunity for [Role]';
    expect(recipientSendErrors(recipient, recipient.customSubject, 'Engineer', 'JOB-1')).toContain(
      'These blanks are still empty: Role',
    );
  });

  it('keeps mixed sentences, tidies empty brackets, and does not block a corrected receiver', () => {
    const recipient = createRecipientDraft('alex@gmail.com');
    recipient.company = 'Acme';
    const result = renderTemplate(
      'I came across your work at [Company] and wanted to share an opportunity for [Role] ([JobId]).',
      { Company: recipient.company },
    );
    recipient.body = result.text;
    expect(result.text).toContain('I came across your work at Acme');
    expect(result.text).not.toContain('()');
    expect(result.warnings).toEqual([result.text]);
    expect(recipientSendErrors(recipient, 'Hello')).toEqual([]);
    expect(recipientSendErrors(recipient, '')).toContain(
      'Add a subject. You can set a default one in Sender details.',
    );
  });
});
