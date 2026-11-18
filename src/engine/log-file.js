const fs = require('fs');
const path = require('path');
const { isPrivateUrl } = require('./scene-share');

// Keeps the activity log on disk so there is something to read after a show:
//   <data folder>\logs\sync-YYYY-MM-DD.log   (one file per day, 14 days kept)
// The window only holds the last 300 lines and loses them when the app closes.
// Private-looking URLs (overlay tokens, ?key=, ?password=...) are never written.

const KEEP_DAYS = 14;
const MAX_LINE = 2000;
const CRASH_LOG_MAX_BYTES = 1024 * 1024;
const FILE_RE = /^sync-(\d{4}-\d{2}-\d{2})\.log$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayOf(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Replaces private-looking URLs with "[private URL on <host>]". */
function redact(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    if (!isPrivateUrl(url)) return url;
    try {
      return `[private URL on ${new URL(url).host}]`;
    } catch (e) {
      return '[private URL]';
    }
  });
}

function formatLine(entry, date) {
  const time = `${dayOf(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const level = String((entry && entry.level) || 'info').toUpperCase().padEnd(5);
  const message = redact((entry && entry.message) || '').replace(/[\r\n]+/g, ' ').slice(0, MAX_LINE);
  return `${time} ${level} ${message}\n`;
}

class LogFile {
  /** dir: the logs folder. now: clock, replaced by tests. */
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.now = now;
    this.day = '';
    this.failed = false;
  }

  /** Appends one log entry. Never throws: logging must not stop a show. */
  append(entry) {
    if (this.failed) return;
    try {
      const date = this.now();
      const day = dayOf(date);
      if (day !== this.day) {
        fs.mkdirSync(this.dir, { recursive: true });
        this.day = day;
        this.prune(date);
      }
      fs.appendFileSync(path.join(this.dir, `sync-${day}.log`), formatLine(entry, date), 'utf8');
    } catch (e) {
      // Disk full or folder not writable: stop trying instead of failing on every line.
      this.failed = true;
      console.error('[LogFile] Could not write the activity log:', e.message);
    }
  }

  /** Deletes daily logs older than KEEP_DAYS. */
  prune(date) {
    const oldest = new Date(date.getFullYear(), date.getMonth(), date.getDate() - KEEP_DAYS);
    const cutoff = dayOf(oldest);
    for (const name of fs.readdirSync(this.dir)) {
      const m = name.match(FILE_RE);
      if (m && m[1] < cutoff) {
        try { fs.unlinkSync(path.join(this.dir, name)); } catch (e) { /* in use: try again another day */ }
      }
    }
  }
}

/** Before appending to crash.log: once it is over 1 MB, keep it as crash.log.old and start again. */
function rotateIfLarge(file, maxBytes = CRASH_LOG_MAX_BYTES) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      fs.renameSync(file, `${file}.old`);
      return true;
    }
  } catch (e) { /* keep appending to the existing file */ }
  return false;
}

module.exports = { LogFile, redact, formatLine, rotateIfLarge, KEEP_DAYS };
