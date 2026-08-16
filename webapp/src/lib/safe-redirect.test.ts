import { describe, expect, it } from 'vitest';
import { safeRedirect } from './safe-redirect';

describe('safeRedirect', () => {
  it('keeps same-site paths, including query and hash', () => {
    expect(safeRedirect('/admin/keys')).toBe('/admin/keys');
    expect(safeRedirect('/dashboard?tab=1#x')).toBe('/dashboard?tab=1#x');
  });

  it('decodes the encodeURIComponent form the guards emit', () => {
    expect(safeRedirect('%2Fadmin%2Fkeys')).toBe('/admin/keys');
  });

  it('rejects absolute URLs to another origin', () => {
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect('http://evil.example/x')).toBe('/');
    expect(safeRedirect('%68ttps%3A%2F%2Fevil.example')).toBe('/');
  });

  it('rejects protocol-relative and backslash tricks', () => {
    // Browsers resolve "//host" against the current scheme — still off-site.
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('%2F%2Fevil.example')).toBe('/');
    expect(safeRedirect('/\\evil.example')).toBe('/');
  });

  it('rejects javascript: and data: payloads', () => {
    expect(safeRedirect('javascript:alert(1)')).toBe('/');
    expect(safeRedirect('data:text/html,<script>')).toBe('/');
  });

  it('falls back on empty, missing, or malformed input', () => {
    expect(safeRedirect(null)).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
    expect(safeRedirect('   ')).toBe('/');
    expect(safeRedirect('%E0%A4%A')).toBe('/');
  });

  it('honours a custom fallback', () => {
    expect(safeRedirect('https://evil.example', '/dashboard')).toBe(
      '/dashboard'
    );
  });
});
