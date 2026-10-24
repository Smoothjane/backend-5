import { MemoryQueue } from '@/utils/queue';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function drain(q: { pending: number }, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (q.pending > 0 && Date.now() < end) await settle(5);
}

describe('MemoryQueue', () => {
  it('retries with exponential backoff until the job succeeds', async () => {
    const q = new MemoryQueue<string>('t', { attempts: 5, backoffMs: 10 });
    const times: number[] = [];
    let calls = 0;
    q.process(async () => {
      times.push(Date.now());
      if (++calls < 3) throw new Error('flaky');
    });
    q.add('job');
    await drain(q);
    expect(calls).toBe(3);
    expect(q.dead).toHaveLength(0);
    // Second gap (about 20ms) is longer than the first (about 10ms).
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(times[1] - times[0]);
  });

  it('moves a job to the dead-letter list after its attempts run out', async () => {
    const q = new MemoryQueue<{ id: number }>('t', { attempts: 2, backoffMs: 5 });
    const handler = jest.fn(async () => {
      throw new Error('smtp down');
    });
    q.process(handler);
    q.add({ id: 7 });
    await drain(q);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(q.dead[0]).toMatchObject({ data: { id: 7 }, error: 'smtp down', attempts: 2 });
  });

  it('keeps jobs added before a processor registers', async () => {
    const q = new MemoryQueue<number>('t');
    q.add(1);
    q.add(2);
    expect(q.pending).toBe(2);
    const seen: number[] = [];
    q.process((n) => {
      seen.push(n);
    });
    await drain(q);
    expect(seen).toEqual([1, 2]);
  });

  it('respects per-job attempts and cancels retries on close', async () => {
    const q = new MemoryQueue<string>('t', { attempts: 5, backoffMs: 60_000 });
    const handler = jest.fn(async () => {
      throw new Error('nope');
    });
    q.process(handler);
    q.add('once', { attempts: 1 });
    q.add('later');
    await settle(20);
    expect(q.dead.map((d) => d.data)).toEqual(['once']);
    expect(q.pending).toBe(1); // 'later' is waiting a minute to retry
    q.close();
    expect(q.pending).toBe(0);
  });
});
