/**
 * SshHostResolver - Defers host resolution to the system OpenSSH client.
 *
 * Why: `ssh -G <host>` runs the full OpenSSH config pipeline (Host blocks,
 * Match directives, Include files, IdentityAgent, default identity files).
 * Reusing OpenSSH's resolution avoids the "works in terminal, fails in app"
 * class of bugs where our in-process parser drifts from the real client.
 *
 * The result is then fed to `ssh2` for the actual transport.
 */

import { createLogger } from '@shared/utils/logger';
import { execFile } from 'child_process';
import * as os from 'os';

const logger = createLogger('Infrastructure:SshHostResolver');

export interface ResolvedSshHost {
  hostname?: string;
  port?: number;
  user?: string;
  identityFiles: string[];
  identityAgent?: string;
  proxyCommand?: string;
}

const SSH_G_TIMEOUT_MS = 5000;

export class SshHostResolver {
  /**
   * Resolves a host alias or hostname via `ssh -G`. Returns `null` if the
   * `ssh` binary is missing or the call fails — callers should fall back to
   * sensible defaults.
   */
  async resolve(host: string): Promise<ResolvedSshHost | null> {
    try {
      const stdout = await this.runSshG(host);
      return this.parse(stdout);
    } catch (err) {
      logger.warn(`ssh -G failed for "${host}": ${(err as Error).message}`);
      return null;
    }
  }

  private runSshG(host: string): Promise<string> {
    /* eslint-disable sonarjs/no-os-command-from-path --
       We resolve `ssh` via PATH because users routinely override it (Homebrew,
       1Password CLI shims, FIDO-aware builds) and pinning to /usr/bin/ssh would
       miss those. The only argument we pass is the user-supplied host; execFile
       (vs exec) avoids shell interpolation of it. */
    return new Promise((resolve, reject) => {
      execFile(
        'ssh',
        ['-G', host],
        { timeout: SSH_G_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) {
            // ExecException extends Error at runtime, but TS narrows it to a
            // structural shape, so wrap defensively to satisfy lint + types.
            reject(err instanceof Error ? err : new Error(err.message ?? 'ssh -G failed'));
            return;
          }
          resolve(stdout);
        }
      );
    });
    /* eslint-enable sonarjs/no-os-command-from-path -- ssh resolution scope ends here */
  }

  private parse(output: string): ResolvedSshHost {
    const result: ResolvedSshHost = {
      identityFiles: [],
    };

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) continue;
      const key = trimmed.slice(0, spaceIdx).toLowerCase();
      const value = trimmed.slice(spaceIdx + 1).trim();
      if (!value) continue;

      switch (key) {
        case 'hostname':
          result.hostname = value;
          break;
        case 'port': {
          const port = parseInt(value, 10);
          if (!Number.isNaN(port)) result.port = port;
          break;
        }
        case 'user':
          result.user = value;
          break;
        case 'identityfile':
          result.identityFiles.push(expandTilde(value));
          break;
        case 'identityagent':
          if (value.toLowerCase() !== 'none') {
            result.identityAgent = expandTilde(value);
          }
          break;
        case 'proxycommand':
          // "none" disables proxying
          if (value.toLowerCase() !== 'none') {
            result.proxyCommand = value;
          }
          break;
        case 'proxyjump':
          // ProxyJump is syntactic sugar for `ssh -W %h:%p <jump>`. Only set if
          // proxycommand hasn't already been parsed (proxycommand takes priority).
          if (!result.proxyCommand && value.toLowerCase() !== 'none') {
            result.proxyCommand = `ssh -W %h:%p ${value}`;
          }
          break;
      }
    }

    return result;
  }
}

function expandTilde(p: string): string {
  return p.replace(/^~(?=$|\/|\\)/, os.homedir());
}
