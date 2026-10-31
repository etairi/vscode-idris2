// toolchain/fileSystem.ts `readSourceFile`: how IDE mode reads the source files its replies name
// (the loaded file, the files of warnings, Go to Definition's targets). A path in a reply may name
// a FIFO or a device (an elaborator script sets a name's file context freely [live, third review of
// M3]), which a plain read would wait on or never finish; they are refused unopened.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkFolder, MAX_SOURCE_FILE_BYTES, readSourceFile } from '../../src/toolchain/fileSystem';

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

suite('toolchain/fileSystem: linkFolder', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi2-link-'));
  });
  teardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a link to a folder that exists, kept while it stays right, moved when the folder does, gone with the folder', async () => {
    const first = path.join(dir, 'first');
    const second = path.join(dir, 'second');
    const link = path.join(dir, 'link');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'kept.ttc'), 'x');
    await linkFolder(first, link);
    assert.strictEqual(fs.readlinkSync(link), first);
    const made = fs.lstatSync(link).ctimeMs;
    await linkFolder(first, link);
    assert.strictEqual(fs.lstatSync(link).ctimeMs, made, 'not made again');
    await linkFolder(second, link);
    assert.strictEqual(fs.readlinkSync(link), second);
    fs.rmdirSync(second);
    await linkFolder(second, link);
    assert.strictEqual(fs.existsSync(link), false);
    assert.throws(() => fs.lstatSync(link));
    assert.ok(fs.existsSync(path.join(first, 'kept.ttc')));
  });

  test('no folder, no link: nothing is made; a file is no folder', async () => {
    const link = path.join(dir, 'link');
    await linkFolder(path.join(dir, 'gone'), link);
    assert.throws(() => fs.lstatSync(link));
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    await linkFolder(path.join(dir, 'file'), link);
    assert.throws(() => fs.lstatSync(link));
  });

  test('removing the folder that holds a link leaves the folder it names', async () => {
    const target = path.join(dir, 'depends');
    const shadow = path.join(dir, 'shadow');
    fs.mkdirSync(target);
    fs.mkdirSync(shadow);
    fs.writeFileSync(path.join(target, 'kept.ttc'), 'x');
    await linkFolder(target, path.join(shadow, 'depends'));
    await fs.promises.rm(shadow, { recursive: true, force: true });
    assert.ok(fs.existsSync(path.join(target, 'kept.ttc')));
  });
});
