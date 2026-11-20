import { TestBed } from '@angular/core/testing';
import { APP_API, ApiUser, MockApi } from './api';
import { App } from './app';
import { vi } from 'vitest';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('App', () => {
  let api: MockApi;

  beforeEach(async () => {
    api = new MockApi(memoryStorage(), () => 0.5);
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: APP_API, useValue: api }],
    }).compileComponents();
  });

  it('shows loading until who-am-I resolves, then opens the app with no login flash', async () => {
    const user = await api.signInMock();
    let resolve!: (value: ApiUser) => void;
    vi.spyOn(api, 'getMe').mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Preparing your workspace');
    expect(root.textContent).not.toContain('Continue with demo account');
    expect(root.querySelector('nav')).toBeNull();
    resolve(user);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(root.querySelector('nav')).not.toBeNull();
    expect(root.textContent).not.toContain('Continue with demo account');
    api.onUnauthorized?.();
    fixture.detectChanges();
    expect(root.textContent).toContain('Sign in to your workspace');
  });

  it('requires a separate Gmail connection for an HTTP session and shows only Google sign-in when signed out', async () => {
    const user = await api.signInMock();
    Object.defineProperty(api, 'mode', { value: 'HTTP' });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Connect your Gmail to send emails');
    expect(root.textContent).not.toContain('Continue with demo account');
    const connect = vi.spyOn(api, 'connectGmail');
    const button = [...root.querySelectorAll<HTMLButtonElement>('main button')].find(
      (item) => item.textContent?.trim() === 'Connect Gmail',
    )!;
    button.click();
    await fixture.whenStable();
    expect(connect).toHaveBeenCalledOnce();
    expect(await api.getMe()).toEqual(user);
    api.onUnauthorized?.();
    fixture.detectChanges();
    expect(root.textContent).toContain('Sign in with Google');
    expect(root.textContent).not.toContain('Continue with demo account');
  });

  it('shows mock mode and signs into the local demo workspace', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('TEST MODE - no real emails are sent');
    expect(compiled.textContent).toContain('Continue with demo account');

    const signIn = [...compiled.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('Continue with demo account'),
    );
    signIn?.click();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(compiled.textContent).toContain('Sender details');
    expect(compiled.textContent).toContain('ReachFlow Demo');
  });

  it('renders the basic campaign, recipient and template workflows after login', async () => {
    await api.signInMock();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('Resume attachment');
    const templatesButton = [...compiled.querySelectorAll<HTMLButtonElement>('nav button')].find(
      (button) => button.textContent?.includes('Receiver details'),
    );
    templatesButton?.click();
    fixture.detectChanges();
    expect(compiled.querySelector('#recipient-list')).toBeTruthy();
    expect(compiled.textContent).toContain('Receiver details');
  });

  it('shows final subjects, Edited and reset; cold emails and per-person optional fields work', async () => {
    await api.signInMock();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const button = async (text: string) => {
      const element = [...root.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === text,
      );
      expect(element, text).toBeTruthy();
      element!.click();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const fill = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      element.value = value;
      element.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await button('Receiver details');
    await fill(root.querySelector('#recipient-list')!, 'alex@gmail.com');
    await button('Add receivers');
    await fixture.whenStable();
    fixture.detectChanges();
    let subject = root.querySelector<HTMLInputElement>('.custom-subject input')!;
    expect(subject.value).toBe('A quick introduction about');
    expect(root.textContent).toContain('Fill in the company');
    await fill(root.querySelectorAll<HTMLInputElement>('.recipient-fields input')[1], 'Acme');
    expect(root.textContent).toContain('Please check the subject');
    const message = root.querySelector<HTMLTextAreaElement>('.message-editor textarea')!;
    expect(message.value).toContain('I came across your work at Acme.');
    expect(message.value).not.toContain('Role:');
    expect(message.value).not.toContain('Job ID:');
    await button('Review →');
    expect(root.textContent).toContain('Review & send');
    expect(root.querySelector('.preview-body')?.textContent).not.toContain('Role:');
    expect(root.textContent?.toLowerCase()).not.toContain('campaign');
    await button('Back to edit');
    subject = root.querySelector<HTMLInputElement>('.custom-subject input')!;
    await fill(subject, 'A personal hello');
    expect(root.textContent).toContain('Edited');
    await button('Sender details');
    const labelInput = (text: string) =>
      [...root.querySelectorAll('label')]
        .find((label) => label.textContent?.trim() === text)
        ?.querySelector('input,textarea') as HTMLInputElement;
    await fill(labelInput('Default subject'), 'Changed for [Name]');
    await button('Receiver details');
    expect(root.querySelector<HTMLInputElement>('.custom-subject input')!.value).toBe(
      'A personal hello',
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await button('Use default subject');
    expect(confirm).toHaveBeenCalled();
    expect(root.querySelector<HTMLInputElement>('.custom-subject input')!.value).toBe(
      'Changed for Alex',
    );
    await button('Sender details');
    await fill(labelInput('Default subject'), 'Updated [Name] for [Role]');
    await button('Receiver details');
    expect(root.querySelector<HTMLInputElement>('.custom-subject input')!.value).toBe(
      'Updated Alex for',
    );
    const inputs = root.querySelectorAll<HTMLInputElement>('.recipient-fields input');
    await fill(inputs[2], 'Engineer');
    await fill(inputs[3], '42');
    expect(root.querySelector<HTMLInputElement>('.custom-subject input')!.value).toBe(
      'Updated Alex for Engineer',
    );
    await button('Review →');
    expect(root.querySelector('.preview-body')?.textContent).toContain('Role: Engineer');
    expect(root.querySelector('.preview-body')?.textContent).toContain('Job ID: 42');
    expect(root.textContent?.toLowerCase()).not.toContain('campaign');
    await button('Back to edit');
    await fill(root.querySelector<HTMLInputElement>('.custom-subject input')!, '');
    expect(root.textContent).toContain(
      'Add a subject. You can set a default one in Sender details.',
    );
    await fill(root.querySelector('#recipient-list')!, 'sam@acme.com');
    await button('Add receivers');
    await button('Review →');
    expect(root.querySelectorAll('.preview-card')).toHaveLength(1);
    expect(root.querySelector('.preview-to')?.textContent).toContain('sam@acme.com');
    expect(root.textContent).toContain('1 receivers need details');
    confirm.mockRestore();
  });

  it('asks before removing people, deleting history, saved messages and accounts', async () => {
    await api.signInMock();
    await api.createCampaign({
      campaign_name: 'Old send',
      template_id: null,
      default_subject: 'Hi',
      default_body: 'Body',
      recipients: [],
    });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const click = async (text: string) => {
      [...root.querySelectorAll<HTMLButtonElement>('button')]
        .find((item) => item.textContent?.trim() === text)!
        .click();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await click('Receiver details');
    const addresses = root.querySelector<HTMLTextAreaElement>('#recipient-list')!;
    addresses.value = 'alex@acme.com';
    addresses.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
    await click('Add receivers');
    await click('Remove all');
    expect(root.querySelectorAll('.recipient-card')).toHaveLength(1);
    confirm.mockReturnValue(true);
    await click('Remove all');
    expect(root.querySelectorAll('.recipient-card')).toHaveLength(0);
    confirm.mockReturnValue(false);
    const deleteHistory = vi.spyOn(api, 'deleteCampaigns');
    await click('History');
    await click('Delete all history');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('This cannot be undone.'));
    expect(deleteHistory).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await click('Delete all history');
    expect(deleteHistory).toHaveBeenCalledWith('all');
    expect(root.textContent).toContain('Nothing sent yet');
    await click('Sender details');
    confirm.mockReturnValue(false);
    const deleteMessage = vi.spyOn(api, 'deleteTemplate');
    await click('Delete');
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(root.textContent?.toLowerCase()).not.toContain('campaign');
    const accountButton = root.querySelector<HTMLButtonElement>('.account-button')!;
    accountButton.click();
    fixture.detectChanges();
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('no');
    const deleteAccount = vi.spyOn(api, 'deleteAccount');
    await click('Delete my account and all my data');
    expect(deleteAccount).not.toHaveBeenCalled();
    prompt.mockReturnValue('DELETE');
    await click('Delete my account and all my data');
    expect(deleteAccount).toHaveBeenCalledWith('DELETE');
    prompt.mockRestore();
    confirm.mockRestore();
  });
});
