import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain CJS module, no types.
import { classifyCommit } from '../../bin/lib/classifyCommit.js';

describe('classifyCommit', () => {
  it('classifies feat: as added', () => {
    expect(classifyCommit({ subject: 'feat: add new endpoint' })).toBe('added');
    expect(classifyCommit({ subject: 'feat(api): expose foo' })).toBe('added');
    expect(classifyCommit({ subject: 'feat!: breaking add' })).toBe('added');
  });

  it('classifies Add ... as added', () => {
    expect(classifyCommit({ subject: 'Add release versioning system' })).toBe('added');
  });

  it('classifies Phase ... as added', () => {
    expect(classifyCommit({ subject: 'Phase 1: stop filename bleed' })).toBe('added');
    expect(classifyCommit({ subject: 'Phase 3a: pre-fill, uncertainty' })).toBe('added');
  });

  it('classifies fix as fixed', () => {
    expect(classifyCommit({ subject: 'fix: null deref in login' })).toBe('fixed');
    expect(classifyCommit({ subject: 'Fix the worker crash' })).toBe('fixed');
    expect(classifyCommit({ subject: 'hotfix: prod outage' })).toBe('fixed');
  });

  it('classifies refactor / chore / test / docs / ci as internal', () => {
    expect(classifyCommit({ subject: 'refactor: split worker' })).toBe('internal');
    expect(classifyCommit({ subject: 'chore: bump deps' })).toBe('internal');
    expect(classifyCommit({ subject: 'cleanup unused exports' })).toBe('internal');
    expect(classifyCommit({ subject: 'test: cover edge case' })).toBe('internal');
    expect(classifyCommit({ subject: 'docs: update README' })).toBe('internal');
    expect(classifyCommit({ subject: 'ci: tighten gate' })).toBe('internal');
    expect(classifyCommit({ subject: 'Internal: rename helper' })).toBe('internal');
  });

  it('skips merge commits', () => {
    expect(classifyCommit({ subject: 'Merge branch master into feature/x' })).toBe('skip');
    expect(classifyCommit({ subject: 'Merge pull request #123' })).toBe('skip');
  });

  it('skips Release v* commits', () => {
    expect(classifyCommit({ subject: 'Release v2.5.0' })).toBe('skip');
    expect(classifyCommit({ subject: 'Release v10.20.30' })).toBe('skip');
  });

  it('skips empty subjects', () => {
    expect(classifyCommit({ subject: '' })).toBe('skip');
    expect(classifyCommit({ subject: '   ' })).toBe('skip');
    expect(classifyCommit({})).toBe('skip');
  });

  it('falls back to changed for everything else', () => {
    expect(classifyCommit({ subject: 'Update tracking files' })).toBe('changed');
    expect(classifyCommit({ subject: 'Stamp 2026-04-17 prod deploy' })).toBe('changed');
    expect(classifyCommit({ subject: 'Wire few-shot extraction examples' })).toBe('changed');
  });

  it('checks fixed before added so "Fix and add" still fixed', () => {
    // "Fix" wins when both could match.
    expect(classifyCommit({ subject: 'Fix and add new logging' })).toBe('fixed');
  });

  it('checks internal before added so "test: add cases" stays internal', () => {
    expect(classifyCommit({ subject: 'test: add cases for compareVersions' })).toBe('internal');
  });
});
