import { describe, it, expect } from 'vitest';
import { compareVersions } from '../../src/lib/versionCompare';

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('0.0.0', '0.0.0')).toBe(0);
  });

  it('returns -1 when a < b on patch', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });

  it('returns 1 when a > b on patch', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
  });

  it('compares minor before patch', () => {
    expect(compareVersions('1.2.9', '1.3.0')).toBe(-1);
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1);
  });

  it('compares major before minor', () => {
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });

  it('does not string-compare (10 > 9)', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.9.9', '2.10.0')).toBe(-1);
  });

  it('strips a leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('v2.0.0', 'v1.9.9')).toBe(1);
  });

  it('ignores pre-release suffix after - or +', () => {
    expect(compareVersions('1.2.3-alpha.1', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0);
  });

  it('treats missing segments as 0', () => {
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });

  it('treats non-numeric segments as 0', () => {
    expect(compareVersions('1.x.3', '1.0.3')).toBe(0);
  });
});
