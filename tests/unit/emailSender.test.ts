import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PORTAL_SENDER_ADDRESS,
  bytesToBase64,
  sendEmail,
  sendEmailDetailed,
  viaSenderName,
} from '../../functions/lib/email';

function stubResend(response: () => Response) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return response();
    })
  );
  return bodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('viaSenderName', () => {
  it('names the organization and the portal', () => {
    expect(viaSenderName('Medosweet Farms')).toBe('Medosweet Farms via SupDox');
  });

  it('removes characters that could fake an address or break the quoted name', () => {
    const name = viaSenderName('Acme "Foods" <ceo@acme.com>,\r\nBcc: x@y.z');
    expect(name).not.toMatch(/[\r\n"<>@,;:\\]/);
    expect(name.endsWith(' via SupDox')).toBe(true);
  });

  it('falls back to the portal name when there is nothing usable', () => {
    expect(viaSenderName('')).toBe('SupDox');
    expect(viaSenderName(null)).toBe('SupDox');
    expect(viaSenderName('<>')).toBe('SupDox');
  });
});

describe('bytesToBase64', () => {
  it('matches btoa on a small input', () => {
    expect(bytesToBase64(new TextEncoder().encode('hello, COA'))).toBe(btoa('hello, COA'));
  });

  it('round-trips a buffer larger than one chunk', () => {
    const bytes = new Uint8Array(100_003);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256;
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes.buffer)), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.every((b, i) => b === bytes[i])).toBe(true);
  });
});

describe('sendEmailDetailed', () => {
  it('keeps the portal address and the default name when no fromName is given', async () => {
    const bodies = stubResend(() => new Response('{}', { status: 200 }));
    const result = await sendEmailDetailed('re_test', { to: 'a@b.c', subject: 's', html: '<p>h</p>' });
    expect(result).toEqual({ ok: true, status: 200, error: null });
    expect(bodies[0].from).toBe(`SupDox <${PORTAL_SENDER_ADDRESS}>`);
    expect(bodies[0]).not.toHaveProperty('attachments');
    expect(bodies[0]).not.toHaveProperty('reply_to');
  });

  it('changes only the display name, and passes reply-to and attachments through', async () => {
    const bodies = stubResend(() => new Response('{}', { status: 200 }));
    await sendEmailDetailed('re_test', {
      to: ['a@b.c'],
      subject: 's',
      html: 'h',
      fromName: viaSenderName('Medosweet Farms'),
      replyTo: 'qa@medosweet.example',
      attachments: [{ filename: 'coa.pdf', content: 'AAAA' }],
    });
    expect(bodies[0].from).toBe(`Medosweet Farms via SupDox <${PORTAL_SENDER_ADDRESS}>`);
    expect(bodies[0].reply_to).toBe('qa@medosweet.example');
    expect(bodies[0].attachments).toEqual([{ filename: 'coa.pdf', content: 'AAAA' }]);
  });

  it('reports the provider status and error text on a refusal', async () => {
    stubResend(() => new Response('attachment too large', { status: 413 }));
    const result = await sendEmailDetailed('re_test', { to: 'a@b.c', subject: 's', html: 'h' });
    expect(result).toEqual({ ok: false, status: 413, error: 'attachment too large' });
  });

  it('reports status 0 when the request throws, and sendEmail stays a boolean', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );
    expect(await sendEmailDetailed('re_test', { to: 'a@b.c', subject: 's', html: 'h' })).toEqual({
      ok: false,
      status: 0,
      error: 'network down',
    });
    expect(await sendEmail('re_test', { to: 'a@b.c', subject: 's', html: 'h' })).toBe(false);
  });
});
