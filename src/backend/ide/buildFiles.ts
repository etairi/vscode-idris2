/**
 * What the load after a save must build (review 1, N1; M2 recorded it as a limitation). Used for IDE
 * mode's sessions (`pool.ts` `outdateSaved`) and for idris2-lsp (`extension.ts`, through
 * `backend/lsp/middleware.ts` `DocumentSync`).
 *
 * The compiler builds a module when its source is at least as new as its TTC, and compares nothing
 * else (`isTTCOutdated`, `src/Idris/ProcessIdr.idr` 244–255 [src]; `-Xcheck-hashes` is disabled). A load
 * that overlaps a save breaks that: it writes its TTC after the save, from what it read before, so
 * that the TTC is newer than the source and the next load builds nothing. What it read is the text
 * before the save, or nothing at all between VS Code's truncation of the file and its write, and an
 * empty file loads without an error, as an empty module: no hovers, holes or errors for that file.
 *
 * So once a file was saved and no load runs any more, a TTC of it newer than the file was written
 * after the save began: `outdateBuild` sets its time back, and the next load builds the text saved.
 * A load that started after the write, before the save's event, gets one build more than it needed,
 * which is all a mistake here can cost. The TTC keeps its contents and stays readable, for a load
 * that is already reading it. On the real compiler, with a second save during each load at the worst
 * moment, 37 of 40 rounds came out wrong without this (28 the earlier text, 9 an empty module), and
 * 100 of 100 right with it [live, docs/measurements/save-race.md].
 *
 * Only regular files are touched: a link in a build directory is no build file, and what it names
 * may be anything. The path of a TTC is the compiler's: `<build>/ttc/<TTC version>/<module path>.ttc`
 * (`ttcBuildDirectory`, `getTTCFileName`, `src/Core/Directory.idr` [src]), the module path being the
 * file's below the source directory, without any extension (`mbPathToNS`, `Path.dropExtensions`). The
 * TTC version is the compiler's own, so every directory there is looked at.
 */
import * as fs from 'fs';
import * as path from 'path';
import { shadowCopyPath } from './shadow';

/** The file operations `outdateBuild` needs. */
export interface BuildFiles {
  /** The names in a directory, none when it cannot be read. */
  list(dir: string): Promise<readonly string[]>;
  /** A source file's modification time in nanoseconds, through links, as the compiler reads it; `undefined` when it has none. */
  sourceTime(file: string): Promise<bigint | undefined>;
  /** A build file's modification time in nanoseconds; `undefined` unless it is a regular file. */
  builtTime(file: string): Promise<bigint | undefined>;
  /** Makes `file` older than any source. */
  setBack(file: string): Promise<void>;
}

export const nodeBuildFiles: BuildFiles = {
  list: (dir) => fs.promises.readdir(dir).catch(() => []),
  sourceTime: async (file) => (await fs.promises.stat(file, { bigint: true }).catch(() => undefined))?.mtimeNs,
  builtTime: async (file) => {
    const stats = await fs.promises.lstat(file, { bigint: true }).catch(() => undefined);
    return stats?.isFile() === true ? stats.mtimeNs : undefined;
  },
  setBack: (file) => fs.promises.utimes(file, 0, 0),
};

/** Where a compiler puts the build files of a root. */
export interface BuildPlace {
  /** The absolute build directory. */
  readonly buildDir: string;
  /** The directory the compiler resolves `sourceDir` against. */
  readonly cwd: string;
  /** The package's source directory (`shadow.ts` `packageSourceDir`). */
  readonly sourceDir: string;
}

/**
 * Sets back the TTCs of `file` newer than it (module comment), and answers them. To be called when no
 * compiler that writes `place` runs a load: one that runs writes its TTC after this has looked.
 */
export async function outdateBuild(files: BuildFiles, place: BuildPlace, file: string, platform: NodeJS.Platform): Promise<readonly string[]> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const below = shadowCopyPath(place.cwd, place.sourceDir, file, platform);
  if ('problem' in below) {
    return [];
  }
  const source = await files.sourceTime(file);
  if (source === undefined) {
    return [];
  }
  const name = pathApi.basename(below.relative).replace(/(?<=[^.])\..*$/, '');
  const module = pathApi.join(pathApi.dirname(below.relative), `${name}.ttc`);
  const ttcDir = pathApi.join(place.buildDir, 'ttc');
  const outdated: string[] = [];
  for (const version of await files.list(ttcDir)) {
    const ttc = pathApi.join(ttcDir, version, module);
    const built = await files.builtTime(ttc);
    if (built !== undefined && built > source) {
      await files.setBack(ttc);
      outdated.push(ttc);
    }
  }
  return outdated;
}
