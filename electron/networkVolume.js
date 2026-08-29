// Is a path on a network volume (SMB share, NFS export, WebDAV mount)?
//
// This decides where the library's SQLite database lives, and it is not a
// preference - it is the difference between an app that works and one that
// does not. SQLite needs a shared-memory file for its write-ahead log, and no
// network filesystem provides one: over SMB, `PRAGMA journal_mode = WAL`
// silently stays in rollback mode, where every single write locks the entire
// database file for the duration of a round trip over the network. A library
// on a NAS then dies with "database is locked" the moment the background
// thumbnail worker overlaps with anything the user does. SQLite documents this
// (https://sqlite.org/wal.html: "WAL does not work over a network filesystem"),
// so the fix is to keep the database off the share, not to tune the timeouts.
//
// Photos, thumbnails and staging are plain files and stay in the library.
//
// Detection reads the system's own mount table rather than guessing from the
// path, because a share can be mounted anywhere ("/Volumes/fantec", "/mnt/nas",
// "Z:") and a local disk can sit under the same parent.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Filesystem types that are a network protocol underneath, per platform naming.
const NETWORK_FS = new Set([
  "smbfs", "cifs", "smb3", "afpfs", "webdav", "nfs", "nfs4", "autofs",
  "fuse.sshfs", "sshfs", "davfs", "davfs2", "9p", "ncpfs", "ftp",
]);

// Longest matching mount point wins: "/Volumes/fantec/Foto Library" is served
// by the mount at "/Volumes/fantec", not by "/".
function fsTypeForPath(mounts, target) {
  const abs = path.resolve(target);
  let best = null;
  for (const m of mounts) {
    if (abs === m.mountPoint || abs.startsWith(m.mountPoint.replace(/\/?$/, "/"))) {
      if (!best || m.mountPoint.length > best.mountPoint.length) best = m;
    }
  }
  return best ? best.type : null;
}

// `mount` prints: //user@server/share on /Volumes/fantec (smbfs, nodev, nosuid)
function parseMacMounts(output) {
  const mounts = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^.+ on (.+) \(([^,)]+)[,)]/);
    if (m) mounts.push({ mountPoint: m[1], type: m[2].trim() });
  }
  return mounts;
}

// /proc/mounts: <device> <mountpoint> <type> <options> 0 0, with octal escapes
// for spaces in the mount point.
function parseLinuxMounts(output) {
  const mounts = [];
  for (const line of output.split("\n")) {
    const parts = line.split(" ");
    if (parts.length < 3) continue;
    mounts.push({ mountPoint: parts[1].replace(/\\040/g, " "), type: parts[2] });
  }
  return mounts;
}

function isNetworkPath(target) {
  if (!target) return false;
  try {
    if (process.platform === "win32") {
      // A UNC path is unambiguous. A mapped drive letter needs asking: `net use
      // Z:` succeeds only for network drives, and exits non-zero otherwise.
      if (/^\\\\/.test(path.resolve(target))) return true;
      const drive = path.resolve(target).slice(0, 2);
      if (!/^[A-Za-z]:$/.test(drive)) return false;
      try {
        execFileSync("net", ["use", drive], { stdio: "ignore", timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }
    const mounts =
      process.platform === "darwin"
        ? parseMacMounts(execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000 }))
        : parseLinuxMounts(fs.readFileSync("/proc/mounts", "utf8"));
    const type = fsTypeForPath(mounts, target);
    return type ? NETWORK_FS.has(type.toLowerCase()) : false;
  } catch (err) {
    // Never let detection failure decide the layout: treating an unknown
    // filesystem as local keeps the previous, self-contained behaviour.
    console.error("[main] network volume detection failed, assuming local:", err);
    return false;
  }
}

module.exports = { isNetworkPath, fsTypeForPath, parseMacMounts, parseLinuxMounts };
