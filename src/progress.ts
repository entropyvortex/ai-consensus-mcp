// ─────────────────────────────────────────────────────────────
// Engine events → MCP progress notifications
// ─────────────────────────────────────────────────────────────
// Every structured engine event is forwarded as a progress
// notification so MCP hosts can render real-time status. Token-
// level events (participantToken, synthesisToken) are intentionally
// NOT forwarded — they fire hundreds of times per round and would
// flood the notification channel.

import type { AdjudicationEngine, ConsensusEngine } from "ai-consensus-core";

/**
 * Shape of the `sendNotification` callback that the MCP SDK hands to
 * request handlers. Declared locally so this module doesn't import SDK
 * types that might churn between SDK versions.
 */
export type SendNotification = (notification: {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}) => Promise<void>;

export interface WireProgressOptions {
  engine: ConsensusEngine;
  sendNotification: SendNotification;
  progressToken: string | number;
  maxRounds: number;
  judgeEnabled: boolean;
}

/**
 * Register listeners on `engine` that forward each structured event as
 * an MCP progress notification. Returns a detach function that removes
 * all registered listeners — call it after `engine.run(...)` resolves
 * or rejects, whichever comes first.
 */
export function wireEngineProgress(opts: WireProgressOptions): () => void {
  const { engine, sendNotification, progressToken, maxRounds, judgeEnabled } = opts;
  const total = maxRounds + (judgeEnabled ? 1 : 0);
  let progress = 0;

  // Notifications are best-effort. A host that disconnects mid-run
  // shouldn't crash the consensus process.
  const notify = (message: string, increment = 0): void => {
    progress += increment;
    void sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    }).catch(() => {
      /* swallow — client may have disconnected */
    });
  };

  const handlers = {
    roundStart: (e: Parameters<Parameters<typeof engine.on<"roundStart">>[1]>[0]) => {
      notify(
        `Round ${e.round}/${maxRounds} — ${e.label} (${e.blind ? "blind, parallel" : "sequential"}) starting`,
      );
    },
    participantStart: (e: Parameters<Parameters<typeof engine.on<"participantStart">>[1]>[0]) => {
      notify(`  ${e.participantId} (${e.modelId}) thinking…`);
    },
    participantComplete: (
      e: Parameters<Parameters<typeof engine.on<"participantComplete">>[1]>[0],
    ) => {
      const tag = e.response.error
        ? `ERROR: ${e.response.error}`
        : `confidence=${e.response.confidence}`;
      notify(`  ${e.response.participantId} done — ${tag} (${e.response.durationMs}ms)`);
    },
    confidenceUpdate: (e: Parameters<Parameters<typeof engine.on<"confidenceUpdate">>[1]>[0]) => {
      notify(
        `  running avg round ${e.round}: ${e.runningAverage.toFixed(1)} (last: ${e.participantId}=${e.confidence})`,
      );
    },
    disagreementDetected: (
      e: Parameters<Parameters<typeof engine.on<"disagreementDetected">>[1]>[0],
    ) => {
      notify(`  ⚠ disagreement: ${e.disagreement.label} (Δ=${e.disagreement.severity})`);
    },
    roundComplete: (e: Parameters<Parameters<typeof engine.on<"roundComplete">>[1]>[0]) => {
      notify(
        `Round ${e.round} complete — score=${e.score}, avg=${e.averageConfidence.toFixed(1)}, σ=${e.stddev.toFixed(1)}, disagreements=${e.disagreements.length}`,
        1,
      );
    },
    earlyStop: (e: Parameters<Parameters<typeof engine.on<"earlyStop">>[1]>[0]) => {
      notify(`✓ Early stop at round ${e.round}: ${e.reason}`);
    },
    synthesisStart: (e: Parameters<Parameters<typeof engine.on<"synthesisStart">>[1]>[0]) => {
      notify(`Judge synthesis starting (${e.modelId})…`);
    },
    synthesisComplete: (e: Parameters<Parameters<typeof engine.on<"synthesisComplete">>[1]>[0]) => {
      notify(`Judge synthesis complete (confidence=${e.synthesis.judgeConfidence})`, 1);
    },
    finalResult: (e: Parameters<Parameters<typeof engine.on<"finalResult">>[1]>[0]) => {
      notify(
        `Consensus complete — finalScore=${e.result.finalScore}, rounds=${e.result.roundsCompleted}, stopReason=${e.result.stopReason}`,
      );
    },
    error: (err: Error) => {
      notify(`✗ engine error: ${err.message}`);
    },
  } as const;

  engine.on("roundStart", handlers.roundStart);
  engine.on("participantStart", handlers.participantStart);
  engine.on("participantComplete", handlers.participantComplete);
  engine.on("confidenceUpdate", handlers.confidenceUpdate);
  engine.on("disagreementDetected", handlers.disagreementDetected);
  engine.on("roundComplete", handlers.roundComplete);
  engine.on("earlyStop", handlers.earlyStop);
  engine.on("synthesisStart", handlers.synthesisStart);
  engine.on("synthesisComplete", handlers.synthesisComplete);
  engine.on("finalResult", handlers.finalResult);
  engine.on("error", handlers.error);

  return () => {
    engine.off("roundStart", handlers.roundStart);
    engine.off("participantStart", handlers.participantStart);
    engine.off("participantComplete", handlers.participantComplete);
    engine.off("confidenceUpdate", handlers.confidenceUpdate);
    engine.off("disagreementDetected", handlers.disagreementDetected);
    engine.off("roundComplete", handlers.roundComplete);
    engine.off("earlyStop", handlers.earlyStop);
    engine.off("synthesisStart", handlers.synthesisStart);
    engine.off("synthesisComplete", handlers.synthesisComplete);
    engine.off("finalResult", handlers.finalResult);
    engine.off("error", handlers.error);
  };
}

export interface WireAdjudicationProgressOptions {
  engine: AdjudicationEngine;
  sendNotification: SendNotification;
  progressToken: string | number;
  jurorCount: number;
  maxRounds: number;
  judgeEnabled: boolean;
}

/**
 * Forward attempt-adjudication events as MCP progress notifications. One
 * progress step per juror verdict and one for the judge; token events are
 * not forwarded. Returns a detach function.
 */
export function wireAdjudicationProgress(opts: WireAdjudicationProgressOptions): () => void {
  const { engine, sendNotification, progressToken, jurorCount, maxRounds, judgeEnabled } = opts;
  const total = jurorCount * maxRounds + (judgeEnabled ? 1 : 0);
  let progress = 0;
  const notify = (message: string, increment = 0): void => {
    progress += increment;
    void sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    }).catch(() => {
      /* client may have disconnected */
    });
  };

  const handlers = {
    roundStart: (e: Parameters<Parameters<typeof engine.on<"roundStart">>[1]>[0]) => {
      notify(`Round ${e.round} (${e.kind}) — ${e.jurorIds.length} jurors comparing attempts`);
    },
    jurorComplete: (e: Parameters<Parameters<typeof engine.on<"jurorComplete">>[1]>[0]) => {
      const v = e.verdict;
      const tag =
        v.status === "valid"
          ? `ranked (${v.verifiedFindings.length} verified finding(s), ${v.droppedFindings.length} dropped)`
          : `${v.status}: ${v.abstainReason ?? ""}`;
      notify(`  ${v.jurorId} ${tag} (${v.durationMs}ms)`, 1);
    },
    roundComplete: (e: Parameters<Parameters<typeof engine.on<"roundComplete">>[1]>[0]) => {
      const w = e.agreement.kendallW;
      notify(
        `Round ${e.round} complete — agreement W=${w === null ? "n/a" : w.toFixed(2)}, ${e.agreement.votes} vote(s)`,
      );
    },
    rebuttalTriggered: (e: Parameters<Parameters<typeof engine.on<"rebuttalTriggered">>[1]>[0]) => {
      notify(
        `Jurors split (W=${e.kendallW.toFixed(2)} < ${e.threshold}); rebuttal round ${e.round}`,
      );
    },
    synthesisStart: (e: Parameters<Parameters<typeof engine.on<"synthesisStart">>[1]>[0]) => {
      notify(`Judge synthesis starting (${e.modelId})…`);
    },
    synthesisComplete: () => {
      notify("Judge synthesis complete", 1);
    },
    budgetStop: (e: Parameters<Parameters<typeof engine.on<"budgetStop">>[1]>[0]) => {
      notify(`Stopped: ${e.reason} — returning a partial result`);
    },
  } as const;

  engine.on("roundStart", handlers.roundStart);
  engine.on("jurorComplete", handlers.jurorComplete);
  engine.on("roundComplete", handlers.roundComplete);
  engine.on("rebuttalTriggered", handlers.rebuttalTriggered);
  engine.on("synthesisStart", handlers.synthesisStart);
  engine.on("synthesisComplete", handlers.synthesisComplete);
  engine.on("budgetStop", handlers.budgetStop);

  return () => {
    engine.off("roundStart", handlers.roundStart);
    engine.off("jurorComplete", handlers.jurorComplete);
    engine.off("roundComplete", handlers.roundComplete);
    engine.off("rebuttalTriggered", handlers.rebuttalTriggered);
    engine.off("synthesisStart", handlers.synthesisStart);
    engine.off("synthesisComplete", handlers.synthesisComplete);
    engine.off("budgetStop", handlers.budgetStop);
  };
}
