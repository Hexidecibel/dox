/**
 * The sharing rule on the document page (migration 0137).
 *
 * Everybody sees the rule in plain words; only somebody the server says may
 * change it sees the button; a change needs a reason; and the dialog says,
 * before anything is typed, that unlocking is an administrator's act.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/api', () => {
  const update = vi.fn();
  return { api: { documents: { update } }, __mocks: { update } };
});

import * as apiModule from '../lib/api';
import { DocumentSharingRule } from './DocumentSharingRule';
import type { DocumentSharingInfo } from '../../shared/types';

const update = (apiModule as unknown as { __mocks: { update: ReturnType<typeof vi.fn> } }).__mocks.update;

function info(over: Partial<DocumentSharingInfo> = {}): DocumentSharingInfo {
  return {
    rule: 'qa',
    source: 'type',
    type_rule: 'qa',
    type_source: 'type',
    override: null,
    override_by_name: null,
    override_at: null,
    override_reason: null,
    can_edit: true,
    can_unlock: false,
    ...over,
  };
}

async function choose(optionName: RegExp) {
  await userEvent.click(screen.getByRole('combobox', { name: 'Sharing' }));
  await userEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: optionName }));
}

beforeEach(() => {
  update.mockReset();
  update.mockResolvedValue({});
});

describe('DocumentSharingRule', () => {
  it('says the rule and where it comes from, in plain words', () => {
    render(<DocumentSharingRule documentId="d1" sharing={info({ can_edit: false })} onChanged={() => {}} />);
    const box = screen.getByTestId('document-sharing-rule');
    expect(within(box).getByText('Needs QA approval')).toBeInTheDocument();
    expect(within(box).getByText("this document type's rule")).toBeInTheDocument();
    // Nobody who cannot change it is offered the button.
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
  });

  it('a document with no type reads Locked and says why', () => {
    render(
      <DocumentSharingRule
        documentId="d1"
        sharing={info({ rule: 'locked', source: 'no_type', type_rule: 'locked', type_source: 'no_type', can_edit: false })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText('Locked')).toBeInTheDocument();
    expect(screen.getByText('this document has no type')).toBeInTheDocument();
    // And says who can change that: typing it is an administrator's act now.
    expect(screen.getByTestId('sharing-no-type-hint')).toHaveTextContent('Only an administrator');
  });

  it('shows who set an override, when and why', () => {
    render(
      <DocumentSharingRule
        documentId="d1"
        sharing={info({
          rule: 'free',
          source: 'override',
          override: 'free',
          override_by_name: 'Quality Lead',
          override_at: '2026-10-01T12:00:00.000Z',
          override_reason: 'Customer contract requires it',
        })}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText('Send freely')).toBeInTheDocument();
    expect(screen.getByText(/Set by Quality Lead/)).toHaveTextContent('Customer contract requires it');
  });

  it('renders nothing for a response that carries no rule', () => {
    const { container } = render(<DocumentSharingRule documentId="d1" sharing={undefined} onChanged={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('saving needs a different rule AND a reason, and sends both', async () => {
    const onChanged = vi.fn();
    render(<DocumentSharingRule documentId="d1" sharing={info()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));

    const save = screen.getByRole('button', { name: 'Save' });
    // Nothing changed yet.
    expect(save).toBeDisabled();
    await choose(/^Send freely for this document$/);
    // Changed, but no reason.
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId('document-sharing-reason'), '  Customer contract requires it ');
    expect(save).toBeEnabled();

    await userEvent.click(save);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('d1', {
      sharing_rule_override: 'free',
      sharing_rule_reason: 'Customer contract requires it',
    });
  });

  it('going back to the type\'s rule sends null', async () => {
    render(
      <DocumentSharingRule
        documentId="d1"
        sharing={info({ rule: 'free', source: 'override', override: 'free' })}
        onChanged={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await choose(/Use the document type's rule \(Needs QA approval\)/);
    await userEvent.type(screen.getByTestId('document-sharing-reason'), 'No longer needed');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toEqual({ sharing_rule_override: null, sharing_rule_reason: 'No longer needed' });
  });

  it('tells a QA releaser, before they type, that only an administrator unlocks', async () => {
    render(
      <DocumentSharingRule
        documentId="d1"
        sharing={info({ rule: 'locked', source: 'type', type_rule: 'locked', can_edit: true, can_unlock: false })}
        onChanged={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await choose(/^Send freely for this document$/);
    expect(screen.getByText('This document is locked. Only an administrator can unlock it.')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('document-sharing-reason'), 'please');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('an administrator may unlock', async () => {
    render(
      <DocumentSharingRule
        documentId="d1"
        sharing={info({ rule: 'locked', source: 'type', type_rule: 'locked', can_edit: true, can_unlock: true })}
        onChanged={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await choose(/^Needs QA approval for this document$/);
    await userEvent.type(screen.getByTestId('document-sharing-reason'), 'Reviewed with the supplier');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows the server\'s refusal and keeps the dialog open', async () => {
    update.mockRejectedValue(new Error('Only QA or an administrator can change how a document may be shared.'));
    const onChanged = vi.fn();
    render(<DocumentSharingRule documentId="d1" sharing={info()} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await choose(/^Locked for this document$/);
    await userEvent.type(screen.getByTestId('document-sharing-reason'), 'Wrong lot on it');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Only QA or an administrator/)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
