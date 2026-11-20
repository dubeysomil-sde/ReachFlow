import { TestBed } from '@angular/core/testing';
import { APP_API, MockApi } from './api';
import { App } from './app';

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

  it('shows mock mode and signs into the local demo workspace', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.textContent).toContain('MOCK MODE — no real emails are sent');
    expect(compiled.textContent).toContain('Continue with demo account');

    const signIn = [...compiled.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Continue with demo account'));
    signIn?.click();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(compiled.textContent).toContain('Compose your outreach');
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
    expect(compiled.querySelector('#recipient-list')).toBeTruthy();
    expect(compiled.textContent).toContain('Resume attachment');
    const templatesButton = [...compiled.querySelectorAll<HTMLButtonElement>('nav button')]
      .find((button) => button.textContent?.includes('Templates'));
    templatesButton?.click();
    fixture.detectChanges();
    expect(compiled.textContent).toContain('Default body');
    expect(compiled.textContent).toContain('[Name]');
  });
});
