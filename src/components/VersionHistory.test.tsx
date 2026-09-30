/**
 * Rules table H1: a version split out of a packet says so, in words, with the
 * way back to the file the supplier actually sent.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DocumentVersion, PacketCitation } from '../../shared/types';

const downloadPacketSource = vi.fn();
vi.mock('../lib/api', () => ({
  api: { documents: { download: vi.fn(), downloadPacketSource: (...a: unknown[]) => downloadPacketSource(...a) } },
}));

import { PacketCitationLine, packetCitationOf } from './VersionHistory';

const citation: PacketCitation = {
  queue_id: 'q1',
  file_name: 'FDLW 2026 annual packet.pdf',
  received_at: '2026-09-01 08:00:00',
  checksum: null,
  page_count: 36,
  pages: [13, 14],
  part_number: 12,
  part_count: 25,
  part_label: 'Kosher Certificate',
  split_at: '2026-09-20 08:00:00',
  split_by: 'u1',
  split_method: 'index',
};

function version(source_packet: string | null): DocumentVersion {
  return {
    id: 'v1',
    document_id: 'd1',
    version_number: 1,
    file_name: 'part-12.pdf',
    file_size: 10,
    mime_type: 'application/pdf',
    checksum: null,
    change_notes: null,
    uploaded_by: 'u1',
    created_at: '2026-09-20 09:00:00',
    source_packet,
  };
}

describe('PacketCitationLine', () => {
  it('cites the packet, its pages and part, and opens the original', async () => {
    render(<PacketCitationLine documentId="d1" version={version(JSON.stringify(citation))} />);
    const line = screen.getByTestId('packet-citation');
    expect(line.textContent).toContain('FDLW 2026 annual packet.pdf');
    expect(line.textContent).toContain('pages 13-14');
    expect(line.textContent).toContain('part 12 of 25');
    expect(line.textContent).toContain('"Kosher Certificate"');
    await userEvent.click(screen.getByRole('button', { name: /open the original packet/i }));
    expect(downloadPacketSource).toHaveBeenCalledWith('d1', 1);
  });

  it('renders nothing for a version not split from a packet, or an unreadable citation', () => {
    const { container } = render(<PacketCitationLine documentId="d1" version={version(null)} />);
    expect(container.textContent).toBe('');
    expect(packetCitationOf(version('{not json'))).toBeNull();
  });
});
