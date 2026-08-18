/**
 * Compaction notice scanning (phase-3): the `compaction/start` session event is
 * appended to the session event stream (compaction-basic/src/region.ts:189),
 * NOT emitted on a cordis event a plugin fiber can listen to. The reachable
 * alternative: a plugin listener on `agent/pre-step` (the same event the
 * automatic compaction backend itself triggers on —
 * compaction-basic/src/index.ts:147) incrementally scans `agent.session.events`
 * for new `compaction/start` records and injects a notice — effectively
 * equivalent to Claude Code's PreCompact hook notice.
 */
/** One scanned event's identity; structural subset of SessionEvent. */
export interface ScanEventLike {
    readonly seq: number;
    readonly type: string;
}
/**
 * Return the seqs of `compaction/start` events newer than `afterSeq`, in order.
 * The caller keeps the last returned seq (or the initial baseline) as the next
 * `afterSeq`; events must be scanned in ascending seq order for that to work.
 * @param events - the session event stream (ascending seq).
 * @param afterSeq - exclusive lower bound.
 * @returns seqs of newly seen compaction starts.
 */
export declare function scanCompactionStarts(events: readonly ScanEventLike[], afterSeq: number): number[];
/** The notice text injected into the agent when a compaction lands. */
export declare const COMPACTION_NOTICE = "[Fact-Forcing Gate] Compaction notice: the session context was compacted \u2014 earlier detail was summarized. Re-read key files or state if you need the original detail.";
