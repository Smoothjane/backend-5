import {
  base32Decode,
  base32Encode,
  codeForStep,
  otpauthUrl,
  stepAt,
  verifyCode,
} from '@/utils/totp';
import { open, seal } from '@/utils/secretBox';

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors (last 6 digits)', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    // T = 59 s -> 94287082; T = 1111111109 -> 07081804; T = 1234567890 -> 89005924
    expect(codeForStep(RFC_SECRET, stepAt(59_000))).toBe('287082');
    expect(codeForStep(RFC_SECRET, stepAt(1_111_111_109_000))).toBe('081804');
    expect(codeForStep(RFC_SECRET, stepAt(1_234_567_890_000))).toBe('005924');
  });

  it('round-trips base32 and tolerates spaces and lowercase', () => {
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString()).toBe(
      '12345678901234567890',
    );
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('accepts one step of clock drift either way, and nothing else', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyCode(RFC_SECRET, codeForStep(RFC_SECRET, step + 2), now)).toBeNull();
    expect(verifyCode(RFC_SECRET, 'abcdef', now)).toBeNull();
  });

  it('builds an otpauth URL authenticator apps can scan', () => {
    const url = new URL(otpauthUrl(RFC_SECRET, 'ada@example.com', "Kofi's Coffee"));
    expect(url.protocol).toBe('otpauth:');
    expect(url.host).toBe('totp');
    expect(decodeURIComponent(url.pathname)).toBe("/Kofi's Coffee:ada@example.com");
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET);
    expect(url.searchParams.get('period')).toBe('30');
  });

  it('seals secrets with authenticated encryption', () => {
    const sealed = seal('SECRET');
    expect(sealed).not.toContain('SECRET');
    expect(open(sealed)).toBe('SECRET');
    const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => open(tampered)).toThrow();
  });
});
