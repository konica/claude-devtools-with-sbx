import { describe, expect, it, vi } from 'vitest';

import { SshFileSystemProvider } from '../../../../src/main/services/infrastructure/SshFileSystemProvider';

import type { SFTPWrapper } from 'ssh2';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * Regression test for the Windows-path bug: services build remote paths with
 * Node's `path` module, which on Windows emits backslash separators. A POSIX
 * SFTP server cannot resolve those (a `\`-leading path isn't absolute, so the
 * server resolves it relative to the SFTP home, producing doubled/mangled
 * paths). SshFileSystemProvider must coerce every path to POSIX before it
 * reaches the SFTP layer.
 */
describe('SshFileSystemProvider POSIX path normalization', () => {
  const dirAttrs = { mode: 0o040000, size: 0, mtime: 0 };
  const fileAttrs = { mode: 0o100000, size: 10, mtime: 0 };

  function makeSftp() {
    const seenPaths: Record<string, string> = {};
    const sftp = {
      readdir: vi.fn((p: string, cb: (e: Error | null, list: unknown[]) => void) => {
        seenPaths.readdir = p;
        cb(null, [{ filename: 'a.jsonl', attrs: fileAttrs }]);
      }),
      stat: vi.fn((p: string, cb: (e: Error | null, s: unknown) => void) => {
        seenPaths.stat = p;
        cb(null, dirAttrs);
      }),
      readFile: vi.fn(
        (p: string, _opts: unknown, cb: (e: Error | null, d: string) => void) => {
          seenPaths.readFile = p;
          cb(null, 'contents');
        }
      ),
      createReadStream: vi.fn((p: string) => {
        seenPaths.createReadStream = p;
        return { pipe: vi.fn(), on: vi.fn() };
      }),
      end: vi.fn(),
    } as unknown as SFTPWrapper;
    return { sftp, seenPaths };
  }

  const WINDOWS_PATH = '\\home\\agent\\.claude\\projects\\-c-Data-X';
  const POSIX_PATH = '/home/agent/.claude/projects/-c-Data-X';

  it('normalizes backslash paths to POSIX for readdir', async () => {
    const { sftp, seenPaths } = makeSftp();
    const provider = new SshFileSystemProvider(sftp);
    await provider.readdir(WINDOWS_PATH);
    expect(seenPaths.readdir).toBe(POSIX_PATH);
  });

  it('normalizes backslash paths to POSIX for stat', async () => {
    const { sftp, seenPaths } = makeSftp();
    const provider = new SshFileSystemProvider(sftp);
    await provider.stat(WINDOWS_PATH);
    expect(seenPaths.stat).toBe(POSIX_PATH);
  });

  it('normalizes backslash paths to POSIX for readFile', async () => {
    const { sftp, seenPaths } = makeSftp();
    const provider = new SshFileSystemProvider(sftp);
    await provider.readFile(WINDOWS_PATH);
    expect(seenPaths.readFile).toBe(POSIX_PATH);
  });

  it('normalizes backslash paths to POSIX for createReadStream', () => {
    const { sftp, seenPaths } = makeSftp();
    const provider = new SshFileSystemProvider(sftp);
    provider.createReadStream(WINDOWS_PATH);
    expect(seenPaths.createReadStream).toBe(POSIX_PATH);
  });

  it('leaves already-POSIX paths unchanged (no-op on POSIX hosts)', async () => {
    const { sftp, seenPaths } = makeSftp();
    const provider = new SshFileSystemProvider(sftp);
    await provider.readdir(POSIX_PATH);
    expect(seenPaths.readdir).toBe(POSIX_PATH);
  });
});
