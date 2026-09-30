/**
 * The file-system questions the toolchain search asks (`discover.ts`, `pack.ts`), behind an
 * interface so that the search itself is a pure function of its inputs: unit tests answer
 * from an in-memory table (including Windows layouts on any OS), the service passes
 * `nodeFileSystem`. None of these calls throws; an unreadable path is treated as absent.
 *
 * `readRegularTextFile` is the one way the extension reads a text file it did not write: the
 * search reads pack's `pack.toml` with it, `project/ipkg.ts` every `.ipkg`, the checks the files
 * of documents (`features/diagnostics/checks.ts`), and IDE mode the source files its replies name
 * (`readSourceFile`).
 */
import * as fs from 'fs';

/** What a path names, after following symbolic links. */
export interface PathInfo {
  readonly kind: 'file' | 'directory' | 'other';
  /**
   * For a file: whether the platform would run it. On POSIX, `access(X_OK)` for this process;
   * on Windows every file counts (the OS decides by extension, which the search chooses).
   */
  readonly executable: boolean;
}

export interface FileSystemProbe {
  /** `undefined` when nothing is there (or it cannot be examined). */
  stat(path: string): Promise<PathInfo | undefined>;
  /** The text of a regular file of at most 1 MiB (`readRegularTextFile`), or `undefined`. */
  readTextFile(path: string): Promise<string | undefined>;
  /** The path with every symbolic link resolved (`fs.realpath`), or `undefined` if it cannot be. */
  realpath(path: string): Promise<string | undefined>;
}

/** The largest file `readRegularTextFile` reads by default: 1 MiB. */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

export type TextFileRead =
  | { readonly ok: true; readonly text: string }
  /** `problem` completes a sentence about the file: "is not a regular file (a FIFO)". */
  | { readonly ok: false; readonly problem: string };

function kindOf(stats: fs.Stats): string {
  if (stats.isDirectory()) {
    return 'a directory';
  }
  if (stats.isFIFO()) {
    return 'a FIFO';
  }
  if (stats.isCharacterDevice() || stats.isBlockDevice()) {
    return 'a device';
  }
  return stats.isSocket() ? 'a socket' : 'not a file';
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? String(error);
}

/**
 * The text of the file at `path` (symbolic links followed), decoded as UTF-8, when it is a
 * regular file of at most `maxBytes` bytes. Anything else is refused without being read:
 * reading a FIFO waits for a writer, and a device such as `/dev/zero` has no end, and either
 * would hold one of libuv's four thread-pool threads, which every extension in the Extension
 * Host shares. The path is examined with `stat` first, so that a FIFO or a device is never
 * opened; then it is opened with `O_NONBLOCK` (POSIX; opening a FIFO with it returns at once)
 * and examined again through the handle, so that a FIFO put in its place in between is refused
 * too; and at most `maxBytes + 1` bytes are read, so that a file that grew in between is refused
 * as well. Never rejects.
 */
export async function readRegularTextFile(path: string, maxBytes = MAX_TEXT_FILE_BYTES): Promise<TextFileRead> {
  const refusal = (stats: fs.Stats): string | undefined => {
    if (!stats.isFile()) {
      return `is not a regular file (${kindOf(stats)})`;
    }
    return stats.size > maxBytes ? `is larger than ${maxBytes} bytes` : undefined;
  };
  let handle: fs.promises.FileHandle;
  try {
    const problem = refusal(await fs.promises.stat(path));
    if (problem !== undefined) {
      return { ok: false, problem };
    }
    // O_NONBLOCK does not exist on Windows (undefined there), where no FIFO has a file name.
    handle = await fs.promises.open(path, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    return { ok: false, problem: `cannot be read (${errorCode(error)})` };
  }
  try {
    const stats = await handle.stat();
    const problem = refusal(stats);
    if (problem !== undefined) {
      return { ok: false, problem };
    }
    let buffer = Buffer.allocUnsafe(stats.size + 1);
    let length = 0;
    for (;;) {
      if (length === buffer.length) {
        if (length > maxBytes) {
          return { ok: false, problem: `is larger than ${maxBytes} bytes` };
        }
        const bigger = Buffer.allocUnsafe(Math.min(2 * length, maxBytes + 1));
        buffer.copy(bigger, 0, 0, length);
        buffer = bigger;
      }
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) {
        return { ok: true, text: buffer.toString('utf8', 0, length) };
      }
      length += bytesRead;
    }
  } catch (error) {
    return { ok: false, problem: `cannot be read (${errorCode(error)})` };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The largest source file `readSourceFile` reads: 8 MiB. Idris sources can exceed the 1 MiB of
 * `MAX_TEXT_FILE_BYTES` (a generated module); the largest of the compiler's own is 108,758 bytes
 * (`src/Idris/Parser.idr` on v0.8.0 [src]). A choice, not measured against a real limit.
 */
export const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * The text of the Idris source file at `path` for IDE mode (`backend/ide/backend.ts`
 * `IdeModeDeps.readFile`: the loaded file, the files a load's warnings name, the targets of Go to
 * Definition): `readRegularTextFile` with `MAX_SOURCE_FILE_BYTES`, rejecting with an `Error` that
 * says why when it refuses. The paths come from the compiler's replies, and a `:name-at` answer can
 * name any path — an elaborator script sets a name's file context freely (`PhysicalPkgSrc`,
 * printed as given, `src/Idris/IDEMode/REPL.idr` 433 on v0.8.0 [src]; `/dev/zero` answered [live,
 * third review of M3]) —, so a FIFO or a device is refused unopened here, as for every other file
 * the extension did not write (third review of M3: this read was `fs.promises.readFile`, which
 * waits on a FIFO without a writer, holding a thread of the pool every extension shares, and read
 * `/dev/zero` until the string was too long).
 */
export async function readSourceFile(path: string): Promise<string> {
  const read = await readRegularTextFile(path, MAX_SOURCE_FILE_BYTES);
  if (!read.ok) {
    throw new Error(`${path} ${read.problem}`);
  }
  return read.text;
}

/** The real file system, for `process.platform`. */
export const nodeFileSystem: FileSystemProbe = {
  async stat(path) {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(path);
    } catch {
      return undefined;
    }
    if (!stats.isFile()) {
      return { kind: stats.isDirectory() ? 'directory' : 'other', executable: false };
    }
    if (process.platform === 'win32') {
      return { kind: 'file', executable: true };
    }
    try {
      await fs.promises.access(path, fs.constants.X_OK);
      return { kind: 'file', executable: true };
    } catch {
      return { kind: 'file', executable: false };
    }
  },
  async readTextFile(path) {
    const read = await readRegularTextFile(path);
    return read.ok ? read.text : undefined;
  },
  async realpath(path) {
    try {
      return await fs.promises.realpath(path);
    } catch {
      return undefined;
    }
  },
};
