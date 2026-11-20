import { CreateCampaignInput, HttpApi, MockApi, runCampaignBatches } from './api';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { vi } from 'vitest';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function campaignInput(count: number): CreateCampaignInput {
  return {
    campaign_name: 'Mock outreach',
    template_id: null,
    default_subject: 'Hello',
    default_body: 'Message',
    recipients: Array.from({ length: count }, (_, index) => ({
      email: `person${index}@example.com`,
      recipient_name: `Person${index}`,
      recipient_company: 'Example',
      recipient_role: 'Engineer',
      recipient_job_id: 'JOB-1',
      use_custom_subject: false,
      custom_subject: null,
      final_subject: 'Hello',
      final_body: 'Message',
    })),
  };
}

describe('MockApi', () => {
  it('does not persist even test sign-in across API instances', async () => {
    const storage = memoryStorage();
    const api = new MockApi(storage);
    await api.signInMock();
    expect(await api.getMe()).not.toBeNull();
    expect(JSON.parse(storage.getItem('reachflow.mock.v1')!).user).toBeNull();
    expect(await new MockApi(storage).getMe()).toBeNull();
  });
  it('keeps daily totals after History is deleted and removes all account data', async () => {
    const api = new MockApi(memoryStorage(), () => 0.5);
    await api.signInMock();
    const send = await api.createCampaign(campaignInput(100));
    for (let batch = 0; batch < 20; batch += 1) await api.sendBatch(send.id, null);
    expect(await api.contactHistory(['person0@example.com'])).toHaveLength(1);
    await api.deleteCampaigns([send.id]);
    expect(await api.contactHistory(['person0@example.com'])).toHaveLength(0);
    const next = await api.createCampaign(campaignInput(1));
    await expect(api.sendBatch(next.id, null)).rejects.toThrow('daily email limit');
    await expect(api.deleteAccount('no')).rejects.toThrow('Type DELETE');
    await api.deleteAccount('DELETE');
    expect(await api.getMe()).toBeNull();
    expect(await api.listCampaigns()).toHaveLength(0);
    expect(await api.listTemplates()).toHaveLength(0);
  });

  describe('HttpApi sessions', () => {
    it('uses cookie credentials for who-am-I and returns 401 to the sign-in handler', async () => {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting()],
      });
      const http = TestBed.inject(HttpTestingController);
      const api = new HttpApi(TestBed.inject(HttpClient));
      const unauthorized = vi.fn();
      api.onUnauthorized = unauthorized;
      const me = api.getMe();
      const request = http.expectOne('/api/auth/me');
      expect(request.request.withCredentials).toBe(true);
      request.flush({ user: { id: 'a' }, emailMode: 'GMAIL' });
      expect((await me)?.id).toBe('a');
      expect(api.emailMode).toBe('GMAIL');
      const templates = api.listTemplates();
      const rejected = expect(templates).rejects.toMatchObject({ status: 401 });
      http
        .expectOne('/api/templates')
        .flush({ error: 'Sign-in required' }, { status: 401, statusText: 'Unauthorized' });
      await rejected;
      expect(unauthorized).toHaveBeenCalledOnce();
      http.verify();
    });

    it('stops the batch loop immediately when Gmail expires', async () => {
      const api = new MockApi(memoryStorage());
      const send = vi
        .spyOn(api, 'sendBatch')
        .mockResolvedValueOnce({ processed: 1, remaining: 3 })
        .mockRejectedValueOnce(
          new Error('Gmail access has expired. Reconnect Gmail, then continue.'),
        );
      await expect(
        runCampaignBatches(
          api,
          'test',
          null,
          () => false,
          () => {},
        ),
      ).rejects.toThrow('Reconnect Gmail');
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  it('blocks deletion until stopped and does not keep an invite link in local data', async () => {
    const api = new MockApi(memoryStorage(), () => 0.5);
    const user = await api.signInMock();
    await expect(api.deleteUser(user.id)).rejects.toThrow('own admin account');
    const invite = await api.createInvitation('new@example.com');
    expect(invite.link).toBeTruthy();
    expect((await api.getAdminData()).invitations[0].link).toBeUndefined();
    await api.deleteInvitation(invite.id);
    expect((await api.getAdminData()).invitations).toHaveLength(0);
    const send = await api.createCampaign(campaignInput(7));
    await api.sendBatch(send.id, null);
    await expect(api.deleteCampaigns('all')).rejects.toThrow('Stop it first');
    await expect(api.deleteAccount('DELETE')).rejects.toThrow('Stop it first');
    await api.cancelCampaign(send.id);
    await api.deleteCampaigns('all');
    expect(await api.listCampaigns()).toHaveLength(0);
  });

  it('sends client-driven batches of five and retries only failed rows', async () => {
    let randomCalls = 0;
    const api = new MockApi(memoryStorage(), () => (randomCalls++ === 0 ? 0 : 0.5));
    await api.signInMock();
    const campaign = await api.createCampaign(campaignInput(7));

    const first = await api.sendBatch(campaign.id, null);
    expect(first).toEqual({ processed: 5, remaining: 2 });
    const afterFirst = await api.getCampaign(campaign.id);
    expect(
      afterFirst.recipients?.filter((recipient) => recipient.sending_status === 'SENT'),
    ).toHaveLength(4);
    expect(
      afterFirst.recipients?.filter((recipient) => recipient.sending_status === 'FAILED'),
    ).toHaveLength(1);

    const second = await api.sendBatch(campaign.id, null);
    expect(second).toEqual({ processed: 2, remaining: 0 });
    const retried = await api.retryFailed(campaign.id);
    expect(retried).toBe(1);
    const retryBatch = await api.sendBatch(campaign.id, null);
    expect(retryBatch).toEqual({ processed: 1, remaining: 0 });
    const finished = await api.getCampaign(campaign.id);
    expect(
      finished.recipients?.filter((recipient) => recipient.sending_status === 'SENT'),
    ).toHaveLength(7);
    expect(finished.failed_count).toBe(0);
    expect(finished.sent_count).toBe(7);
  });
});
