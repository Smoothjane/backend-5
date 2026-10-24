import { ConnectionRegistry, msUntilExpiry } from '@/services/connections';

const sock = (id: string) => ({ id, disconnect: jest.fn() });

describe('ConnectionRegistry', () => {
  it('caps sockets per user by closing the oldest', () => {
    const reg = new ConnectionRegistry(2);
    const [a, b, c] = [sock('a'), sock('b'), sock('c')];
    reg.add('u1', a);
    reg.add('u1', b);
    expect(reg.add('u1', c)).toEqual([a]);
    expect(a.disconnect).toHaveBeenCalledWith(true);
    expect(b.disconnect).not.toHaveBeenCalled();
    expect(reg.count('u1')).toBe(2);
  });

  it('keeps users independent', () => {
    const reg = new ConnectionRegistry(1);
    reg.add('u1', sock('a'));
    reg.add('u2', sock('b'));
    expect(reg.count()).toBe(2);
    expect(reg.users()).toBe(2);
  });

  it('forgets users when their last socket disconnects', () => {
    const reg = new ConnectionRegistry(3);
    const a = sock('a');
    const b = sock('b');
    reg.add('u1', a);
    reg.add('u1', b);
    reg.remove('u1', a);
    expect(reg.count('u1')).toBe(1);
    reg.remove('u1', b);
    expect(reg.users()).toBe(0);
    reg.remove('ghost', a);
    expect(reg.count()).toBe(0);
  });
});

describe('msUntilExpiry', () => {
  it('converts a JWT exp to a timeout and never goes negative', () => {
    expect(msUntilExpiry(1_000, 900_000)).toBe(100_000);
    expect(msUntilExpiry(1_000, 2_000_000)).toBe(0);
    expect(msUntilExpiry(undefined)).toBeNull();
  });
});
