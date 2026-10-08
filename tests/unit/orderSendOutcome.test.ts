/**
 * What a send is CALLED (migration 0138, decision C-068).
 *
 * `order_sends.status` is `sent` / `partial` / `failed` and is not widened.
 * Two truthful outcomes have no status of their own, and are read from the
 * per-email record by one function: a send in which nothing left because
 * everything was withdrawn must never read "sent", and one where some emails
 * went and the rest were withdrawn must not offer a resend that can do nothing.
 */
import { describe, it, expect } from 'vitest';
import { describeSendOutcome } from '../../shared/orderSend';

const went = { ok: true };
const failed = { ok: false };
const withdrawn = { ok: false, withdrawn: true };

describe('describeSendOutcome', () => {
  it('is sent only when every email went', () => {
    expect(describeSendOutcome([went, went])).toEqual({ status: 'sent', outcome: 'sent', retryable: false });
    // A send that only asked QA has no email at all.
    expect(describeSendOutcome([])).toEqual({ status: 'sent', outcome: 'sent', retryable: false });
  });

  it('is partial or failed, and can be resent, while an email that did not go can still be tried', () => {
    expect(describeSendOutcome([went, failed])).toEqual({ status: 'partial', outcome: 'partial', retryable: true });
    expect(describeSendOutcome([failed, failed])).toEqual({ status: 'failed', outcome: 'failed', retryable: true });
    expect(describeSendOutcome([failed, withdrawn])).toEqual({ status: 'failed', outcome: 'failed', retryable: true });
    expect(describeSendOutcome([went, failed, withdrawn])).toEqual({ status: 'partial', outcome: 'partial', retryable: true });
  });

  it('a send whose every email was withdrawn is NOT sent: stored failed, called withdrawn, nothing to resend', () => {
    expect(describeSendOutcome([withdrawn])).toEqual({ status: 'failed', outcome: 'withdrawn', retryable: false });
    expect(describeSendOutcome([withdrawn, withdrawn])).toEqual({ status: 'failed', outcome: 'withdrawn', retryable: false });
  });

  it('some went and the rest were withdrawn: partial, called so, nothing to resend', () => {
    expect(describeSendOutcome([went, withdrawn])).toEqual({
      status: 'partial',
      outcome: 'sent_rest_withdrawn',
      retryable: false,
    });
  });

  it('an email that went is never read as withdrawn, whatever else the record says', () => {
    expect(describeSendOutcome([{ ok: true, withdrawn: true }])).toEqual({ status: 'sent', outcome: 'sent', retryable: false });
  });
});
