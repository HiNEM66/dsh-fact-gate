/**
 * Duplicate-read softening (phase-2, mirrors CC built-in constraint ②,
 * "file unchanged since your last Read"). Default OFF.
 *
 * pre-execute: hash the target file content per session; post-execute: if the
 * same file was read again with an unchanged hash, attach an "unchanged"
 * hint via additionalContexts instead of a full re-read payload. Because a
 * deny would break the read tool's contract, we never deny — we hint.
 *
 * The hash is computed on pre-execute (sync fs read, bounded by MAX_HASH_BYTES)
 * so the compare happens before the model sees the result.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const MAX_HASH_BYTES = 4 * 1024 * 1024; // hash first 4MB only (perf bound)
export class DuplicateReadTracker {
    config;
    /** sessionKey → filePath(absolute) → content hash */
    hashes = new Map();
    constructor(config) {
        this.config = config;
    }
    /** Is the duplicate-read softening active? */
    enabled() {
        return this.config().enabled;
    }
    /** pre-execute hook: record the file hash; returns true when a duplicate read is detected. */
    recordRead(sessionKey, filePath) {
        const dup = this.detectDuplicate(sessionKey, filePath);
        if (this.config().enabled && filePath) {
            const abs = resolve(filePath);
            try {
                const buf = readFileSync(abs);
                const hash = createHash('sha256').update(buf.subarray(0, MAX_HASH_BYTES)).digest('hex');
                const perSession = this.hashes.get(sessionKey) ?? new Map();
                perSession.set(abs, hash);
                this.hashes.set(sessionKey, perSession);
            }
            catch (_) {
                // unreadable file — nothing to track
            }
        }
        return { duplicate: dup, path: filePath };
    }
    /** Build the unchanged hint message when a duplicate read fired. */
    static hintMessage(path) {
        return `[Fact-Forcing Gate] File unchanged since your last Read: ${path} — refer to the earlier read result.`;
    }
    detectDuplicate(sessionKey, filePath) {
        if (!this.config().enabled || !filePath)
            return false;
        const abs = resolve(filePath);
        const perSession = this.hashes.get(sessionKey);
        if (!perSession)
            return false;
        const prev = perSession.get(abs);
        if (prev === undefined)
            return false;
        try {
            const buf = readFileSync(abs);
            const hash = createHash('sha256').update(buf.subarray(0, MAX_HASH_BYTES)).digest('hex');
            return hash === prev;
        }
        catch (_) {
            return false;
        }
    }
}
//# sourceMappingURL=duplicate-read.js.map