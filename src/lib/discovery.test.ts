import { afterEach, describe, expect, it, vi } from 'vitest';

const discoverPrm = vi.fn();
const discoverAs = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({
  discoverOAuthProtectedResourceMetadata: (...a: unknown[]) => discoverPrm(...a),
  discoverAuthorizationServerMetadata: (...a: unknown[]) => discoverAs(...a),
}));

const { authorizationServerFor, authorizationServerMetadata, clearDiscoveryCache, resourceInfo } = await import('./discovery');

const URL_ = 'https://gw.example.com/mcp/servers/demo';

afterEach(() => {
  clearDiscoveryCache();
  vi.clearAllMocks();
});

describe('resourceInfo', () => {
  it('reads the Protected Resource Metadata of the MCP server, once', async () => {
    discoverPrm.mockResolvedValue({ resource: URL_, authorization_servers: ['https://as'] });
    expect(await resourceInfo(URL_)).toEqual({ resource: URL_, authorizationServers: ['https://as'] });
    await resourceInfo(URL_);
    expect(discoverPrm).toHaveBeenCalledTimes(1);
    expect(discoverPrm).toHaveBeenCalledWith(URL_);
  });

  it('accepts metadata for a parent resource of the same origin', async () => {
    discoverPrm.mockResolvedValue({ resource: 'https://gw.example.com/' });
    expect(await resourceInfo(URL_)).toEqual({ resource: 'https://gw.example.com/', authorizationServers: [] });
  });

  it('rejects metadata that describes another resource, and retries next time', async () => {
    discoverPrm.mockResolvedValue({ resource: 'https://evil.example.com/mcp', authorization_servers: ['https://as'] });
    await expect(resourceInfo(URL_)).rejects.toThrow(/does not match/);
    discoverPrm.mockResolvedValue({ resource: URL_, authorization_servers: [] });
    await expect(resourceInfo(URL_)).resolves.toMatchObject({ resource: URL_ });
  });
});

describe('authorizationServerFor', () => {
  it('uses the first listed authorization server by default', async () => {
    discoverPrm.mockResolvedValue({ resource: URL_, authorization_servers: ['https://as1', 'https://as2'] });
    expect(await authorizationServerFor(URL_)).toBe('https://as1');
  });

  it('uses the configured one only when the metadata lists it', async () => {
    discoverPrm.mockResolvedValue({ resource: URL_, authorization_servers: ['https://as1', 'https://as2'] });
    expect(await authorizationServerFor(URL_, 'https://as2')).toBe('https://as2');
    await expect(authorizationServerFor(URL_, 'https://other')).rejects.toThrow(/is not listed/);
  });

  it('fails when no authorization server is listed', async () => {
    discoverPrm.mockResolvedValue({ resource: URL_ });
    await expect(authorizationServerFor(URL_)).rejects.toThrow(/No authorization server/);
  });
});

describe('authorizationServerMetadata', () => {
  it('returns the metadata, and fails when there is none', async () => {
    discoverAs.mockResolvedValueOnce({ issuer: 'https://as' }).mockResolvedValueOnce(undefined);
    expect(await authorizationServerMetadata('https://as')).toEqual({ issuer: 'https://as' });
    await expect(authorizationServerMetadata('https://none')).rejects.toThrow(/No authorization server metadata/);
  });
});
