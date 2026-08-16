import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { SUMMARY_OPEN_TAG } from './prompt.js';
function textOfBlocks(blocks) {
    let out = '';
    for (const block of blocks) {
        if (block.type === 'text')
            out += block.text;
        else if (block.type === 'tool-result')
            out += textOfBlocks(block.content);
    }
    return out;
}
function textOfMessage(message) {
    return textOfBlocks(message.content);
}
export function isCompactionSummaryMessage(message) {
    return message.role === 'user' && textOfMessage(message).trimStart().startsWith(SUMMARY_OPEN_TAG);
}
export function isProtectedMessage(message) {
    const text = textOfMessage(message).trim().toLowerCase();
    // Tool results in DSH are user-role with a tool-result block; check the
    // structured error flag before text heuristics.
    for (const block of message.content) {
        if (block.type === 'tool-result' && block.isError)
            return true;
    }
    if (message.role === 'user') {
        return text.startsWith('[[keep]]') || text.startsWith('[keep]') || text.startsWith('<keep>') || text.startsWith('<!-- keep -->');
    }
    return text.startsWith('error:') || text.startsWith('blocked:');
}
/** Estimate message tokens with the meter's fixed estimator. */
export function estimateMessageTokens(message, meter) {
    return meter.estimateMessage(message);
}
function isUserMessage(message) {
    return message.role === 'user';
}
/** Assert the token-meter surface and the live session surface are identical. */
function assertSurfaceMatchesMeasurement(session, nodes) {
    const surfaceNodes = session.surface.nodes;
    if (surfaceNodes.length !== nodes.length || surfaceNodes.some((seq, index) => seq !== nodes[index]?.seq)) {
        throw new Error('compaction: token-meter surface does not match the current session surface');
    }
}
/** True when a surface node is a tool result (never a legal tail start). */
function isToolResultNode(session, seq) {
    const event = session.events[seq];
    if (!event || event.seq !== seq)
        return false;
    if (event.type === 'tool/result')
        return true;
    if (event.type === 'user/message') {
        const data = event.data;
        const content = data.message?.content ?? data.content;
        return Array.isArray(content) && content.some((block) => block.type === 'tool-result');
    }
    return false;
}
/** Index of the first surface node that may be folded (stable prefix end). */
function pinnedPrefixEnd(messages, nodes, config, spec, meter) {
    let head = 0;
    if (messages.length > 0 && isUserMessage(messages[0]) && !isCompactionSummaryMessage(messages[0])) {
        const cost = estimateMessageTokens(messages[0], meter);
        const budget = Math.min(config.maxPinnedFirstUserTokens, Math.floor(spec.contextWindow * config.pinnedFirstUserWindowFrac));
        if (cost <= budget)
            head = 1;
    }
    // Keep index alignment with nodes; nodes and messages are both surface-ordered.
    return Math.min(head, nodes.length);
}
/**
 * Choose the recent-tail start index. Walks newest→oldest, growing the tail
 * until the next node would exceed `tailTokens`, then snaps the cut to a
 * balanced boundary and backs up to protect kept content.
 */
export function selectReasonixRange(session, measurement, config, spec, meter, force) {
    const messages = session.deriveMessages();
    const nodes = measurement.nodes;
    assertSurfaceMatchesMeasurement(session, nodes);
    if (nodes.length === 0 || messages.length === 0)
        return null;
    const head = pinnedPrefixEnd(messages, nodes, config, spec, meter);
    if (head >= nodes.length)
        return null;
    let tailTokens = spec.recentTailTokens;
    if (force) {
        // Reasonix `planCompaction(force=true)` halves the tail for mid-size sessions.
        const half = Math.floor(measurement.surfaceTokens / 2);
        if (half > 0 && half < tailTokens)
            tailTokens = half;
    }
    let startIdx = tailStartIndex(nodes, head, tailTokens, config.minRecentKeep);
    // Align so the tail never begins with an orphan tool result.
    while (startIdx > head && startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) {
        startIdx--;
    }
    // Defensive: even if the balance helper disagrees, never start the tail on a
    // tool result whose tool-call would be shadowed.
    while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx].seq)) {
        startIdx--;
    }
    // Preserve protected messages ([[keep]] user turns, error tool results) by
    // moving the fold boundary before the earliest protected message in the fold.
    for (let i = head; i < startIdx; i++) {
        if (isProtectedMessage(messages[i])) {
            startIdx = i;
            break;
        }
    }
    // Re-align after protected-message moves (a protected error tool result must
    // not become an orphan at the tail start).
    while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx].seq)) {
        startIdx--;
    }
    // After alignment startIdx may equal head; re-check minimum compactable span.
    if (startIdx - head < config.minCompactMessages)
        return null;
    if (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) {
        throw new Error('compaction: tail start is not tool-pairing balanced');
    }
    const endIdx = startIdx - 1;
    const shadowed = nodes.slice(head, startIdx);
    return {
        start: shadowed[0].seq,
        end: shadowed[shadowed.length - 1].seq,
        startIdx: head,
        endIdx,
        shadowedSeqs: shadowed.map((n) => n.seq),
        shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
    };
}
/** Fallback range for force/overflow when no adapter context capacity is known. */
export function selectOverflowRange(session, measurement, config) {
    const messages = session.deriveMessages();
    const nodes = measurement.nodes;
    assertSurfaceMatchesMeasurement(session, nodes);
    if (nodes.length === 0 || messages.length === 0)
        return null;
    const head = 0;
    let startIdx = Math.max(head, nodes.length - config.minRecentKeep);
    while (startIdx > head && startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) {
        startIdx--;
    }
    // Defensive: never start the tail on a tool result.
    while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx].seq)) {
        startIdx--;
    }
    for (let i = head; i < startIdx; i++) {
        if (isProtectedMessage(messages[i])) {
            startIdx = i;
            break;
        }
    }
    // Re-align after protected-message moves.
    while (startIdx > head && startIdx < nodes.length && isToolResultNode(session, nodes[startIdx].seq)) {
        startIdx--;
    }
    if (startIdx - head < config.minCompactMessages)
        return null;
    if (startIdx < nodes.length && !toolPairingBalancedBefore(session, nodes[startIdx].seq)) {
        throw new Error('compaction: tail start is not tool-pairing balanced');
    }
    const shadowed = nodes.slice(head, startIdx);
    return {
        start: shadowed[0].seq,
        end: shadowed[shadowed.length - 1].seq,
        startIdx: head,
        endIdx: startIdx - 1,
        shadowedSeqs: shadowed.map((n) => n.seq),
        shadowedTokenCount: shadowed.reduce((sum, n) => sum + n.tokens, 0),
    };
}
function tailStartIndex(nodes, head, budgetTokens, minKeep) {
    let start = nodes.length;
    let acc = 0;
    for (let i = nodes.length - 1; i > head; i--) {
        const cost = nodes[i].tokens;
        if (nodes.length - i > minKeep && acc + cost > budgetTokens)
            break;
        acc += cost;
        start = i;
    }
    return Math.max(start, head);
}
/** Compute the fixed-prefix tokens (request envelope + nodes before the range). */
export function fixedPrefixTokens(measurement, startIdx) {
    const headerTokens = Math.max(0, measurement.totalTokens - measurement.surfaceTokens);
    const before = measurement.nodes.slice(0, startIdx).reduce((sum, n) => sum + n.tokens, 0);
    return headerTokens + before;
}
/**
 * Reasonix `acceptCheckpointCandidate`: normal path requires candidate ≤ 50%
 * and below trigger; force/overflow may exceed the ceiling only when still
 * below trigger; manual below trigger accepts any real savings.
 */
export function acceptCheckpointCandidate(opts) {
    const { trigger, force, sourceTokens, candidateTokens, fixedPrefixTokens, spec, config } = opts;
    if (candidateTokens >= sourceTokens) {
        throw new Error(`checkpoint rejected: candidate would not reduce tokens (${candidateTokens} >= ${sourceTokens})`);
    }
    const manualBelowTrigger = trigger === 'manual' && sourceTokens < spec.thresholdTokens;
    if (manualBelowTrigger)
        return;
    if (fixedPrefixTokens > spec.ceilingTokens) {
        const savings = sourceTokens - candidateTokens;
        if (savings < spec.exceptionalMinSavingsTokens) {
            throw new Error(`checkpoint rejected: fixed-prefix exception requires >=${spec.exceptionalMinSavingsTokens} token savings, got ${savings}`);
        }
        if (candidateTokens >= spec.thresholdTokens) {
            throw new Error(`checkpoint rejected: candidate ${candidateTokens} still at or above trigger ${spec.thresholdTokens}`);
        }
        if (candidateTokens >= spec.hardCeilingTokens) {
            throw new Error(`checkpoint rejected: candidate ${candidateTokens} still at or above physical ceiling ${spec.hardCeilingTokens}`);
        }
        return;
    }
    if (candidateTokens > spec.ceilingTokens && !force) {
        throw new Error(`checkpoint rejected: candidate ${candidateTokens} exceeds checkpoint ceiling ${spec.ceilingTokens}`);
    }
    if (candidateTokens >= spec.thresholdTokens && !force) {
        throw new Error(`checkpoint rejected: candidate ${candidateTokens} still at or above trigger ${spec.thresholdTokens}`);
    }
    if (force && candidateTokens >= spec.thresholdTokens) {
        throw new Error(`checkpoint rejected: forced candidate ${candidateTokens} still at or above trigger ${spec.thresholdTokens}`);
    }
}
