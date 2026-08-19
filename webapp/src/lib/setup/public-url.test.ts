import { describe, expect, it } from 'vitest';
import { hostsMatch, requestPublicHost } from './public-url';

describe('requestPublicHost', () => {
  it('reads the Host header, which is what nginx forwards unchanged', () => {
    const h = new Headers({ host: 'garage.makeware.io' });
    expect(requestPublicHost(h)).toBe('garage.makeware.io');
  });

  it('prefers X-Forwarded-Host, set by a proxy that rewrites Host', () => {
    const h = new Headers({
      host: 'internal.svc.cluster.local',
      'x-forwarded-host': 'garage.makeware.io',
    });
    expect(requestPublicHost(h)).toBe('garage.makeware.io');
  });

  it('takes the client-facing hop from a chain of proxies', () => {
    const h = new Headers({
      'x-forwarded-host': 'garage.makeware.io, edge.internal',
    });
    expect(requestPublicHost(h)).toBe('garage.makeware.io');
  });

  it('lowercases, since a Host header is case-insensitive', () => {
    expect(requestPublicHost(new Headers({ host: 'Garage.MakeWare.IO' }))).toBe(
      'garage.makeware.io'
    );
  });

  it('is null when nothing said, so the check stays quiet', () => {
    expect(requestPublicHost(new Headers())).toBeNull();
    expect(requestPublicHost(new Headers({ host: '   ' }))).toBeNull();
  });
});

describe('hostsMatch', () => {
  it('ignores a port implied by its scheme', () => {
    // The browser omits :443; APP_PUBLIC_URL is written with an explicit scheme.
    expect(hostsMatch('garage.makeware.io', 'garage.makeware.io:443')).toBe(
      true
    );
    expect(hostsMatch('localhost:80', 'localhost')).toBe(true);
  });

  it('keeps any other port significant', () => {
    expect(hostsMatch('localhost:8080', 'localhost:3000')).toBe(false);
    expect(hostsMatch('localhost:8080', 'localhost')).toBe(false);
  });

  it('matches an IPv6 literal without eating its address', () => {
    expect(hostsMatch('[::1]:443', '[::1]')).toBe(true);
    expect(hostsMatch('[::1]:8080', '[::1]:3000')).toBe(false);
  });

  it('rejects genuinely different hosts', () => {
    expect(hostsMatch('garage.makeware.io', '0.0.0.0:3000')).toBe(false);
  });
});
