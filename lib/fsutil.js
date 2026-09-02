'use strict';
const fs = require('fs');
const path = require('path');

// Write a file atomically: stream to a sibling temp file, fsync, then rename
// over the target. If the disk is full (ENOSPC) or the process dies mid-write,
// the existing file is left untouched instead of being truncated to zero bytes
// the way fs.writeFileSync would leave it.
function writeFileAtomic(file, data, { mode } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', mode);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (mode !== undefined) fs.chmodSync(tmp, mode); // umask-independent
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { writeFileAtomic };
