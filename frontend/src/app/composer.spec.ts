import { createRecipientDraft, markDuplicates, recipientSendErrors, renderDefaultBody } from './composer';

describe('recipient composer logic', () => {
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
    expect(renderDefaultBody(
      'Hi [Name] at [Company], role [Role], job [JobId]',
      recipient,
      'Designer',
      'RF-42',
    )).toBe('Hi Iqbal at Birdeye, role Designer, job RF-42');
  });

  it('blocks low confidence recipients and unresolved values until corrected', () => {
    const recipient = createRecipientDraft('person@gmail.com');
    recipient.body = 'Hello [Name]';
    expect(recipientSendErrors(recipient, 'Subject', '', '')).toContain('Confirm the recipient name and company');
    expect(recipientSendErrors(recipient, 'Subject', '', '')).toContain('Unresolved placeholders: [Name]');

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
      'Unresolved placeholders: [Role]',
    );
  });
});
