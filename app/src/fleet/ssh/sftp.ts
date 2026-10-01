// SFTP subsystem for the embedded ssh2 server: file transfer over the same SSH connection as exec/shell. The protocol
// events come from ssh2; this maps them to the local filesystem as the relay's user (the same trust as the shell, so
// no jail). Paths are resolved against baseDir when relative.
import fs from "node:fs";
import path from "node:path";
import { utils, type Attributes, type FileEntry, type SFTPWrapper } from "ssh2";

const { STATUS_CODE, flagsToString } = utils.sftp;
const ZERO_ATTRS: Attributes = { mode: 0, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };

export function wireSftp(sftp: SFTPWrapper, baseDir: string): void {
  let seq = 0;
  const files = new Map<number, number>(); // handle id -> open fd
  const dirs = new Map<number, { path: string; done: boolean }>(); // handle id -> directory read state

  const newHandle = (): Buffer => {
    const id = ++seq;
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id, 0);
    return b;
  };
  const idOf = (h: Buffer): number => h.readUInt32BE(0);
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(baseDir, p));
  const attrsOf = (st: fs.Stats): Attributes => ({ mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });

  sftp.on("REALPATH", (reqid, p) => {
    const resolved = path.resolve(abs(p));
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: ZERO_ATTRS }]);
  });

  sftp.on("OPEN", (reqid, filename, flags) => {
    fs.open(abs(filename), flagsToString(flags) ?? "r", (err, fd) => {
      if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      const h = newHandle();
      files.set(idOf(h), fd);
      sftp.handle(reqid, h);
    });
  });

  sftp.on("READ", (reqid, handle, offset, length) => {
    const fd = files.get(idOf(handle));
    if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const buf = Buffer.alloc(length);
    fs.read(fd, buf, 0, length, offset, (err, bytes) => {
      if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (bytes === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, bytes));
    });
  });

  sftp.on("WRITE", (reqid, handle, offset, data) => {
    const fd = files.get(idOf(handle));
    if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.write(fd, data, 0, data.length, offset, (err) => sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK));
  });

  sftp.on("FSTAT", (reqid, handle) => {
    const fd = files.get(idOf(handle));
    if (fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.fstat(fd, (err, st) => (err ? sftp.status(reqid, STATUS_CODE.FAILURE) : sftp.attrs(reqid, attrsOf(st))));
  });

  sftp.on("CLOSE", (reqid, handle) => {
    const id = idOf(handle);
    const fd = files.get(id);
    if (fd !== undefined) {
      files.delete(id);
      return fs.close(fd, () => sftp.status(reqid, STATUS_CODE.OK));
    }
    dirs.delete(id);
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on("OPENDIR", (reqid, p) => {
    const dir = abs(p);
    fs.stat(dir, (err, st) => {
      if (err || !st.isDirectory()) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      const h = newHandle();
      dirs.set(idOf(h), { path: dir, done: false });
      sftp.handle(reqid, h);
    });
  });

  // SFTP calls READDIR repeatedly until EOF; return the whole listing once, then EOF.
  sftp.on("READDIR", (reqid, handle) => {
    const d = dirs.get(idOf(handle));
    if (!d) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (d.done) return sftp.status(reqid, STATUS_CODE.EOF);
    fs.readdir(d.path, (err, entries) => {
      if (err) return sftp.status(reqid, STATUS_CODE.FAILURE);
      d.done = true;
      const names: FileEntry[] = entries.map((name) => {
        let attrs: Attributes = ZERO_ATTRS;
        try {
          attrs = attrsOf(fs.statSync(path.join(d.path, name)));
        } catch {
          // a vanished or unreadable entry still gets listed, without attrs
        }
        return { filename: name, longname: name, attrs };
      });
      sftp.name(reqid, names);
    });
  });

  const stat = (reqid: number, p: string, fn: typeof fs.stat) => fn(abs(p), (err, st) => (err ? sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE) : sftp.attrs(reqid, attrsOf(st))));
  sftp.on("STAT", (reqid, p) => stat(reqid, p, fs.stat));
  sftp.on("LSTAT", (reqid, p) => stat(reqid, p, fs.lstat));

  const simple = (reqid: number, err: NodeJS.ErrnoException | null) => sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK);
  sftp.on("REMOVE", (reqid, p) => fs.unlink(abs(p), (err) => simple(reqid, err)));
  sftp.on("RMDIR", (reqid, p) => fs.rmdir(abs(p), (err) => simple(reqid, err)));
  sftp.on("MKDIR", (reqid, p) => fs.mkdir(abs(p), (err) => simple(reqid, err)));
  sftp.on("RENAME", (reqid, from, to) => fs.rename(abs(from), abs(to), (err) => simple(reqid, err)));
  sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on("READLINK", (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
}
