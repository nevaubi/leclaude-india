import { describe, it, expect } from 'vitest';
import { textStatusLabel } from '@/modules/india/corpus/text-status';
import { citatorLimitBytes } from '@/modules/india/citator/build';
describe('truthful corpus labels and shared storage budget', () => {
  it('does not misdescribe unreconciled metadata as PDF-only', () => {
    expect(textStatusLabel('none')).toBe('Text not confirmed');
    expect(textStatusLabel('failed')).toBe('Text unavailable');
  });
  it('separates imported parses, PDF text layers, OCR and incomplete text', () => {
    expect(textStatusLabel('full')).toBe('Parsed text');
    expect(textStatusLabel('full_text')).toBe('PDF text');
    expect(textStatusLabel('ocr')).toBe('OCR text');
    expect(textStatusLabel('partial')).toBe('Partial text');
  });
  it('inherits the configured shared corpus budget instead of a stale 60000 MB default', () => {
    expect(citatorLimitBytes({ OFFICIAL_MAX_DB_MB: '150000' })).toBe(150000 * 1024 * 1024);
    expect(citatorLimitBytes({ CORPUS_MAX_DB_MB: '100000' })).toBe(100000 * 1024 * 1024);
    expect(citatorLimitBytes({ CITATOR_MAX_DB_MB: '50000', OFFICIAL_MAX_DB_MB: '150000' })).toBe(50000 * 1024 * 1024);
    expect(citatorLimitBytes({ CITATOR_MAX_DB_MB: '-1', OFFICIAL_MAX_DB_MB: '150000' })).toBe(150000 * 1024 * 1024);
  });
});
