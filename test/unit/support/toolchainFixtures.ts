// Builders for toolchain snapshots and project roots, and a fake ToolchainService, shared by the
// unit tests of the M1 UI modules (backendRegistry, statusItem, setupInformation,
// notifications, installCommands). The values are made up; where one imitates real output it
// is the Homebrew 0.8.0 build on the development machine (F25, src/toolchain/types.ts).
import type { ToolchainSettings } from '../../../src/core/config';
import { Emitter } from '../../../src/core/event';
import type { IpkgVersionBounds, LooseFile, ProjectRoot } from '../../../src/project/types';
import type {
  Idris2Info,
  LspInfo,
  PackState,
  ProbeRecord,
  RescanReason,
  ToolchainService,
  ToolchainSnapshot,
  ToolLocation,
  ToolState,
} from '../../../src/toolchain/types';

export const SETTINGS: ToolchainSettings = {
  idris2Path: '',
  lspPath: '',
  packPath: '',
  preferPack: false,
  env: {},
  ignoredEnvEntries: [],
};

export function probe(args: string[], stdout: string, exitCode = 0): ProbeRecord {
  return { args, result: { exitCode, signal: null, stdout, stderr: '', timedOut: false, durationMs: 12.4 } };
}

export function location(kind: ToolLocation['kind'], path: string): ToolLocation {
  return { kind, path, source: 'PATH', detail: `PATH entry ${path.slice(0, path.lastIndexOf('/'))}`, inPackDirectory: false };
}

export const IDRIS2_PATH = '/opt/homebrew/bin/idris2';

export function idris2Probed(versionText = '0.8.0'): ToolState<Idris2Info> {
  const [major, minor, patchAndTag] = versionText.split('.');
  const [patch, tag] = patchAndTag.split('-');
  const versionLine = `Idris 2, version ${versionText}`;
  return {
    status: 'probed',
    location: location('idris2', IDRIS2_PATH),
    info: {
      versionLine,
      version: { major: Number(major), minor: Number(minor), patch: Number(patch), tag, text: versionText },
      ttcVersion: '2025081600',
      pathsText: '+ Working Directory      :: "/w"\n',
      packages: [{ name: 'contrib', version: '0.8.0', ttcVersions: ['2025081600'], path: '/opt/homebrew/lib/idris2/contrib-0.8.0' }],
      probes: [
        probe(['--version'], `${versionLine}\n`),
        probe(['--ttc-version'], '2025081600\n'),
        probe(['--paths'], '+ Working Directory      :: "/w"\n'),
        probe(['--list-packages'], 'contrib-0.8.0\n'),
      ],
    },
  };
}

export const LSP_PATH = '/home/u/.local/bin/idris2-lsp';

export function lspProbed(apiText: string): ToolState<LspInfo> {
  const stdout = `Idris2 LSP: 0.1.0\nIdris2 API: ${apiText}\n`;
  return {
    status: 'probed',
    location: location('idris2-lsp', LSP_PATH),
    info: {
      serverVersionLine: 'Idris2 LSP: 0.1.0',
      serverVersion: { major: 0, minor: 1, patch: 0, text: '0.1.0' },
      apiVersionLine: `Idris2 API: ${apiText}`,
      apiVersion: undefined,
      probes: [probe(['--version'], stdout)],
    },
  };
}

export function missing<Info>(reason = 'idris2 was not found on PATH or in the usual places.'): ToolState<Info> {
  return { status: 'missing', searched: ['PATH entry /usr/bin', '/opt/homebrew/bin/idris2'], reason };
}

export const PACK_MISSING: PackState = { status: 'missing', searched: ['/home/u/.local/bin/pack'], reason: 'pack was not found.' };

export function packFound(path = '/home/u/.local/bin/pack'): PackState {
  return {
    status: 'found',
    info: {
      location: { kind: 'pack', path, source: 'pack', detail: 'pack wrapper directory ~/.local/bin', inPackDirectory: true },
      configDir: '/home/u/.config/pack',
      stateDir: '/home/u/.local/state/pack',
      collection: 'nightly-260924',
      collectionBinDir: '/home/u/.local/state/pack/install/nightly-260924/bin',
    },
  };
}

/** A finished trusted scan that found the Homebrew 0.8.0 compiler and nothing else. */
export function snapshot(overrides: Partial<ToolchainSnapshot> = {}): ToolchainSnapshot {
  return {
    generation: 1,
    reason: 'activation',
    trusted: true,
    settings: SETTINGS,
    idris2: idris2Probed(),
    lsp: missing('idris2-lsp was not found.'),
    pack: PACK_MISSING,
    verdict: undefined,
    errors: [],
    finishedAt: Date.UTC(2026, 8, 27, 12, 0, 0),
    ...overrides,
  };
}

/** The bounds of a dependency written without any (`depends = contrib`). */
const ANY_VERSION: IpkgVersionBounds = { lower: undefined, lowerInclusive: true, upper: undefined, upperInclusive: true };

export function projectRoot(overrides: Partial<ProjectRoot> = {}): ProjectRoot {
  return {
    kind: 'project',
    ipkgPath: '/w/simple-ipkg/simple-ipkg.ipkg',
    dir: '/w/simple-ipkg',
    otherIpkgs: [],
    insideWorkspace: true,
    model: {
      status: 'ok',
      source: 'dump-json',
      model: { name: 'simple-ipkg', depends: [{ name: 'contrib', bounds: ANY_VERSION }], modules: ['Foo.A', 'Foo.B'], sourcedir: 'src' },
    },
    ...overrides,
  };
}

export const LOOSE: LooseFile = { kind: 'loose', dir: '/w/loose-file' };

/** A ToolchainService whose state the test sets; `rescan` records its reasons. */
export class FakeToolchain implements ToolchainService {
  current: ToolchainSnapshot | undefined;
  scanning = false;
  readonly rescans: RescanReason[] = [];
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(initial?: ToolchainSnapshot) {
    this.current = initial;
  }

  /** Finishes a scan with `next` (its generation follows the previous one) and fires. */
  publish(next: Omit<Partial<ToolchainSnapshot>, 'generation'> = {}): ToolchainSnapshot {
    this.current = snapshot({ ...next, generation: (this.current?.generation ?? 0) + 1 });
    this.scanning = false;
    this.changed.fire();
    return this.current;
  }

  setScanning(value: boolean): void {
    this.scanning = value;
    this.changed.fire();
  }

  rescan(reason: RescanReason): Promise<ToolchainSnapshot> {
    this.rescans.push(reason);
    return Promise.resolve(this.publish({ reason }));
  }

  dispose(): void {
    this.changed.dispose();
  }
}
