import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RankRequest, RankResult } from "../domain/schemas.js";
import type { Campaign, DecideResult } from "../workflow/schemas.js";
import type { LoadedLoop } from "../loop/store.js";
import type { LongSpec } from "../long/schemas.js";
import { loadLongStore } from "../long/store.js";
import { longStatusCommand } from "../long/commands.js";
import { loadLoop } from "../loop/store.js";
import { DEFAULT_TUI_MONITORING, readTuiSession, registerComponentSession, type TuiMonitoring, type TuiSessionRecord } from "./store.js";

function nowIso(): string { return new Date().toISOString(); }
function summarizeLongGoal(goal: string): string { return goal.length <= 180 ? goal : `${goal.slice(0, 177)}...`; }
async function existingMonitoring(root: string, id: string, fallback: TuiMonitoring): Promise<TuiMonitoring> {
  return (await readTuiSession(root, id))?.monitoring ?? fallback;
}

export async function recordRankSession(root: string, request: RankRequest, result: RankResult, _workMs: number, component: "sift" | "run"): Promise<void> {
  const sift = component === "sift";
  const id = `${sift ? "sift" : "run"}_${result.run_id.replace(/[^a-z0-9_-]/gi, "_")}`;
  const selected = result.decisions.filter((candidate) => candidate.status === "keep").map((candidate) => `Selected ${candidate.candidate_id}`);
  const review = result.decisions.filter((candidate) => candidate.status === "review").map((candidate) => `Review ${candidate.candidate_id}`);
  const rejected = result.decisions.filter((candidate) => candidate.status === "reject").map((candidate) => `Rejected ${candidate.candidate_id}`);
  const record: TuiSessionRecord = {
    version: 1, id, component: "sift", source: "component", monitoring: await existingMonitoring(root, id, DEFAULT_TUI_MONITORING), title: summarizeLongGoal(request.task.goal), goal: request.task.goal,
    status: "complete", started_at: nowIso(), updated_at: nowIso(), agent_work_ms: null,
    summary: `${selected.length} selected · ${review.length} review · ${rejected.length} rejected`,
    details: [sift ? "JevSift ranking complete; selection is not execution proof." : "Candidate ranking complete.", ...selected, ...review, ...rejected].slice(0, 64),
    kanban: { in_progress: selected, attention: review, verified: [] },
  };
  await registerComponentSession(root, record);
}

export async function recordCampaignSession(root: string, campaign: Campaign, _workMs: number): Promise<void> {
  const selected = campaign.work_orders.map((order) => `${order.candidate_id} · probe ready`);
  const review = campaign.sift.decisions.filter((decision) => decision.status === "review").map((decision) => `${decision.candidate_id} · needs human review`);
  const record: TuiSessionRecord = {
    version: 1, id: campaign.campaign_id, component: "sift", source: "component", monitoring: await existingMonitoring(root, campaign.campaign_id, DEFAULT_TUI_MONITORING), title: summarizeLongGoal(campaign.request.task.goal), goal: campaign.request.task.goal,
    status: "active", started_at: nowIso(), updated_at: nowIso(), agent_work_ms: null,
    summary: `${selected.length} probe work order${selected.length === 1 ? "" : "s"} created`,
    details: ["Candidates are selected for bounded probing; none is verified yet.", ...selected, ...review].slice(0, 64),
    kanban: { in_progress: selected, attention: review, verified: [] },
  };
  await registerComponentSession(root, record);
}

export async function recordDecisionSession(root: string, campaign: Campaign, result: DecideResult, _workMs: number): Promise<void> {
  const outcome = result.decision;
  const inProgress = outcome === "winner" && result.winner !== null ? [`Recommended winner · ${result.winner} · integration not yet recorded`] : [];
  const verified: string[] = [];
  const attention = outcome === "human_review" || outcome === "no_winner" ? [outcome] : [];
  const record: TuiSessionRecord = {
    version: 1, id: campaign.campaign_id, component: "sift", source: "component", monitoring: await existingMonitoring(root, campaign.campaign_id, DEFAULT_TUI_MONITORING), title: summarizeLongGoal(campaign.request.task.goal), goal: campaign.request.task.goal,
    status: "complete", started_at: nowIso(), updated_at: nowIso(), agent_work_ms: null,
    summary: `Decision · ${outcome}`,
    details: [`Evidence-based decision: ${outcome}`, ...verified, ...attention],
    kanban: { in_progress: inProgress, attention, verified },
  };
  await registerComponentSession(root, record);
}

export async function recordLoopSession(root: string, loop: LoadedLoop): Promise<void> {
  const status = loop.state.status;
  const sessionStatus: TuiSessionRecord["status"] = status === "completed" ? "complete" : status === "aborted" ? "aborted" : status === "waiting_human" || status === "budget_paused" ? "paused" : "active";
  const active = loop.state.active_order === null ? [] : [`Round ${loop.state.active_order.round_number} · ${loop.state.active_order.round_goal}`];
  const attention = loop.state.status === "waiting_human" ? [loop.state.last_audit?.next_action.reason ?? "Waiting for human input"] : loop.state.status === "budget_paused" ? ["Budget paused"] : [];
  const verified = loop.state.last_audit?.outcome === "completed" ? ["Completion audit passed"] : loop.state.last_audit?.material_progress ? [`Round ${loop.state.last_round} · material progress recorded`] : [];
  const created = loop.events[0]?.timestamp ?? nowIso();
  const record: TuiSessionRecord = {
    version: 1, id: loop.state.loop_id, component: "loop", source: "component", monitoring: await existingMonitoring(root, loop.state.loop_id, { loop: true, long: false }), title: loop.spec.title, goal: loop.spec.goal, status: sessionStatus,
    started_at: created, updated_at: loop.events.at(-1)?.timestamp ?? created, agent_work_ms: loop.state.cumulative_wall_ms,
    directory: loop.directory, loop_directory: loop.directory, summary: `Round ${loop.state.last_round} · ${status} · ${loop.state.cumulative_provider_tokens} tokens`,
    details: [
      `round ${loop.state.last_round}`, `head ${loop.state.head_revision}`, `stalled rounds ${loop.state.consecutive_stalled}`,
      ...(loop.state.last_audit === null ? [] : [`last audit · ${loop.state.last_audit.outcome}`, loop.state.last_audit.next_action.reason]),
    ].slice(0, 64), kanban: { in_progress: active, attention, verified },
  };
  await registerComponentSession(root, record);
}

export async function recordLongSession(root: string, directory: string, spec?: LongSpec): Promise<void> {
  const store = await loadLongStore(directory);
  const status = await longStatusCommand(directory);
  const openAlerts = status.policy.alerts.filter((alert) => alert.status === "open" || alert.status === "acknowledged");
  const info = JSON.parse(await readFile(join(directory, "identity.json"), "utf8")) as { created_at?: string };
  const passed = new Set(store.events.filter((event) => event.payload.source === "recorded" && event.payload.event_type === "milestone" && event.payload.payload.data?.status === "passed").map((event) => event.payload.payload.data?.milestone_id).filter((value): value is string => typeof value === "string"));
  const verified = [...passed].map((milestone) => `${milestone} · verified`);
  const inProgress = (spec ?? store.spec).milestones.filter((milestone) => !passed.has(milestone.id)).map((milestone) => `${milestone.id} · ${milestone.description}`);
  const record: TuiSessionRecord = {
    version: 1, id: store.spec.session_id, component: "long", source: "component", monitoring: await existingMonitoring(root, store.spec.session_id, { loop: false, long: true }), title: store.spec.title, goal: store.spec.goal,
    status: "active", started_at: info.created_at ?? nowIso(), updated_at: store.snapshot.last_event_at ?? info.created_at ?? nowIso(),
    agent_work_ms: null, directory: store.directory, long_directory: store.directory,
    summary: `${store.snapshot.sequence} events · ${openAlerts.length} open alerts`,
    details: [`${status.signals.cost.tool_calls} tool calls`, `${status.signals.cost.provider_tokens} provider tokens`, ...openAlerts.map((alert) => `${alert.severity} · ${alert.message}`)].slice(0, 64),
    kanban: { in_progress: inProgress, attention: openAlerts.map((alert) => `${alert.severity.toUpperCase()} · ${alert.message}`), verified },
  };
  await registerComponentSession(root, record);
}

export async function refreshRegisteredSessions(root: string): Promise<void> {
  const rootPath = root;
  const uiSessionPath = process.env.JEVREV_UI_DATA_DIR === undefined ? join(rootPath, ".jevrev", "ui", "sessions") : join(process.env.JEVREV_UI_DATA_DIR, "sessions");
  const entries = await readdir(uiSessionPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(uiSessionPath, entry.name), "utf8")) as TuiSessionRecord;
      if (parsed.component === "loop" && parsed.directory !== undefined) await recordLoopSession(rootPath, await loadLoop(parsed.directory));
      else if (parsed.component === "long" && parsed.directory !== undefined) await recordLongSession(rootPath, parsed.directory);
    } catch { /* bad session records are skipped by the view */ }
  }
  const longRoot = join(rootPath, ".jevrev");
  const candidates: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth < 0 || candidates.length >= 256) return;
    const children = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      const childPath = join(directory, child.name);
      const hasSpec = await stat(join(childPath, "spec.json")).then((value) => value.isFile()).catch(() => false);
      const hasSnapshot = await stat(join(childPath, "snapshot.json")).then((value) => value.isFile()).catch(() => false);
      if (hasSpec) candidates.push(childPath);
      else if (hasSnapshot) {
        try { await recordLoopSession(rootPath, await loadLoop(childPath)); } catch { /* unrelated snapshot store */ }
      } else await walk(childPath, depth - 1);
      if (candidates.length >= 256) return;
    }
  };
  await walk(longRoot, 3);
  for (const directory of candidates) await recordLongSession(rootPath, directory).catch(() => undefined);
}
