import { CreateCampaignInput, MockApi } from './api';

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
  it('sends client-driven batches of five and retries only failed rows', async () => {
    let randomCalls = 0;
    const api = new MockApi(memoryStorage(), () => randomCalls++ === 0 ? 0 : 0.5);
    await api.signInMock();
    const campaign = await api.createCampaign(campaignInput(7));

    const first = await api.sendBatch(campaign.id, null);
    expect(first).toEqual({ processed: 5, remaining: 2 });
    const afterFirst = await api.getCampaign(campaign.id);
    expect(afterFirst.recipients?.filter((recipient) => recipient.sending_status === 'SENT')).toHaveLength(4);
    expect(afterFirst.recipients?.filter((recipient) => recipient.sending_status === 'FAILED')).toHaveLength(1);

    const second = await api.sendBatch(campaign.id, null);
    expect(second).toEqual({ processed: 2, remaining: 0 });
    const retried = await api.retryFailed(campaign.id);
    expect(retried).toBe(1);
    const retryBatch = await api.sendBatch(campaign.id, null);
    expect(retryBatch).toEqual({ processed: 1, remaining: 0 });
    const finished = await api.getCampaign(campaign.id);
    expect(finished.recipients?.filter((recipient) => recipient.sending_status === 'SENT')).toHaveLength(7);
    expect(finished.failed_count).toBe(0);
    expect(finished.sent_count).toBe(7);
  });
});
