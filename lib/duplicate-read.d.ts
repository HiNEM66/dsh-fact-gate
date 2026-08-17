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
export interface DuplicateReadConfig {
    enabled: boolean;
}
export declare class DuplicateReadTracker {
    private config;
    /** sessionKey → filePath(absolute) → content hash */
    private hashes;
    constructor(config: () => DuplicateReadConfig);
    /** Is the duplicate-read softening active? */
    enabled(): boolean;
    /** pre-execute hook: record the file hash; returns true when a duplicate read is detected. */
    recordRead(sessionKey: string, filePath: string): {
        duplicate: boolean;
        path: string;
    };
    /** Build the unchanged hint message when a duplicate read fired. */
    static hintMessage(path: string): string;
    private detectDuplicate;
}
