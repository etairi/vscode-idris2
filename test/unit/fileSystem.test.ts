// toolchain/fileSystem.ts `readSourceFile`: how IDE mode reads the source files its replies name
// (the loaded file, the files of warnings, Go to Definition's targets). A path in a reply may name
// a FIFO or a device (an elaborator script sets a name's file context freely [live, third review of
// M3]), which a plain read would wait on or never finish; they are refused unopened.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_SOURCE_FILE_BYTES, readSourceFile } from '../../src/toolchain/fileSystem';

suite('toolchain/fileSystem: readSourceFile', () => {
  let dir: string;

  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-source-'));
  });

  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a regular file is read as UTF-8', async () => {
    const file = path.join(dir, 'A.idr');
    fs.writeFileSync(file, 'module A\n\nx : String\nx = "𝕟"\n');
    assert.strictEqual(await readSourceFile(file), 'module A\n\nx : String\nx = "𝕟"\n');
  });

  test('POSIX: a FIFO without a writer and /dev/zero are refused at once, unopened', async function () {
    if (process.platform === 'win32') {
      this.skip(); // no FIFO has a file name there
    }
    const fifo = path.join(dir, 'fifo.idr');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(readSourceFile(fifo), (e: unknown) => e instanceof Error && e.message === `${fifo} is not a regular file (a FIFO)`);
    await assert.rejects(readSourceFile('/dev/zero'), /^Error: \/dev\/zero is not a regular file \(a device\)$/);
  });

  test('a file above MAX_SOURCE_FILE_BYTES, a directory and a missing file are refused', async () => {
    const big = path.join(dir, 'Big.idr');
    fs.writeFileSync(big, Buffer.alloc(MAX_SOURCE_FILE_BYTES + 1, 0x20));
    await assert.rejects(readSourceFile(big), /is larger than 8388608 bytes$/);
    const exact = path.join(dir, 'Exact.idr');
    fs.writeFileSync(exact, Buffer.alloc(MAX_SOURCE_FILE_BYTES, 0x20));
    assert.strictEqual((await readSourceFile(exact)).length, MAX_SOURCE_FILE_BYTES);
    await assert.rejects(readSourceFile(dir), /is not a regular file \(a directory\)$/);
    await assert.rejects(readSourceFile(path.join(dir, 'Missing.idr')), /cannot be read \(ENOENT\)$/);
  });
});
