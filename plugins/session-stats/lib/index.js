/**
 * @dsh-desktop/session-stats — host half.
 *
 * Registers the `sessionToolDetail` session projection: a whole-log fold that
 * keeps per-session tool telemetry the paged conversation window cannot see:
 *
 *   - total dispatched / settled tool calls
 *   - the longest completed tool call (input + return value)
 *   - live state for the current session: the open model step and every
 *     in-flight tool call, so the client can tick current wall times
 *     between event frames.
 *
 * The totals mirror @deepseek-ai/dsh-session-stats exactly (`llmMs` measures
 * step/start → assistant/message; `toolMs` pairs tool/call → tool/result), so
 * the two projection values can be combined without double counting.
 */
import { z } from "zod";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";

const name = "dsh-desktop-session-stats";
const inject = ["sessionProjections", "webServer"];

const MAX_RUNNING_ARGS_CHARS = 500;
const MAX_RUNNING_ROWS = 16;
const MAX_ARGS_CHARS = 4000;
const MAX_RETURN_CHARS = 12000;

function clipText(value, maxChars) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, truncated: false };
  return { text: `${chars.slice(0, maxChars).join("")}…`, truncated: true };
}

function textOfBlock(block) {
  if (typeof block === "string") return block;
  if (block === null || block === undefined) return "";
  if (Array.isArray(block)) {
    const parts = block.map(textOfBlock).filter((part) => part !== "");
    return parts.length > 0 ? parts.join("\n").trim() : JSON.stringify(block);
  }
  if (typeof block !== "object") return JSON.stringify(block);
  if (typeof block.text === "string") return block.text;
  if (block.type === "tool-result") return textOfBlock(block.content);
  if (Array.isArray(block.content)) return textOfBlock(block.content);
  return JSON.stringify(block);
}

function textOfContent(content) {
  if (Array.isArray(content)) {
    const parts = content.map(textOfBlock).filter((part) => part !== "");
    if (parts.length > 0) return parts.join("\n").trim();
    return JSON.stringify(content);
  }
  return textOfBlock(content);
}

function toolResultValue(message) {
  const first = Array.isArray(message?.content) ? message.content[0] : message?.content;
  return textOfBlock(first);
}

const runningCallSchema = z
  .object({
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
    argumentsTruncated: z.boolean(),
    startedAt: z.number(),
    turn: z.number(),
    step: z.number(),
  })
  .strict();

const longestToolCallSchema = z
  .object({
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
    argumentsTruncated: z.boolean(),
    durationMs: z.number().nonnegative(),
    startedAt: z.number(),
    completedAt: z.number(),
    turn: z.number(),
    step: z.number(),
    returnValue: z.string(),
    returnValueTruncated: z.boolean(),
    isError: z.boolean(),
  })
  .strict();

const openStepSchema = z
  .object({
    turn: z.number(),
    step: z.number(),
    startedAt: z.number(),
  })
  .strict();

const sessionToolDetailSchema = z
  .object({
    toolCalls: z.number().int().nonnegative(),
    toolResults: z.number().int().nonnegative(),
    longestToolCall: z.union([longestToolCallSchema, z.null()]),
    runningCalls: z.array(runningCallSchema),
    openStep: z.union([openStepSchema, z.null()]),
  })
  .strict();

const sessionToolDetailProjectionDefinition = {
  key: "sessionToolDetail",
  schema: sessionToolDetailSchema,
  stateVersion: 1,
  init: () => ({
    toolCalls: 0,
    toolResults: 0,
    longestToolCall: null,
    pendingCalls: {},
    openStep: null,
  }),
  apply: (state, event) => {
    switch (event.type) {
      case "step/start": {
        const data = event.data;
        return {
          ...state,
          openStep: { turn: data.turn, step: data.step, startedAt: event.time },
        };
      }
      case "assistant/message": {
        const data = event.data;
        const open = state.openStep;
        if (open === null || open.turn !== data.turn || open.step !== data.step) return state;
        return { ...state, openStep: null };
      }
      case "tool/call": {
        const data = event.data;
        const callId = String(data.callId);
        const argumentsClipped = clipText(data.arguments ?? "", MAX_ARGS_CHARS);
        const pending = {
          callId,
          name: typeof data.name === "string" && data.name !== "" ? data.name : "tool",
          arguments: argumentsClipped.text,
          argumentsTruncated: argumentsClipped.truncated,
          startedAt: event.time,
          turn: data.turn,
          step: data.step,
        };
        return {
          ...state,
          toolCalls: state.toolCalls + 1,
          pendingCalls: { ...state.pendingCalls, [callId]: pending },
        };
      }
      case "tool/result": {
        const message = event.data?.message;
        const callId = String(message?.source?.callId ?? "");
        if (callId === "") return state;
        // callId is provider-minted; own-key check keeps prototype names harmless.
        if (!Object.hasOwn(state.pendingCalls, callId)) return state;
        const pending = state.pendingCalls[callId];
        const pendingCalls = { ...state.pendingCalls };
        delete pendingCalls[callId];
        const startedAt = pending.startedAt;
        const completedAt = event.time;
        const durationMs = Math.max(0, completedAt - startedAt);
        const returnClipped = clipText(toolResultValue(message), MAX_RETURN_CHARS);
        const isError =
          (Array.isArray(message?.content) && message.content[0]?.isError === true) ||
          event.data?.error !== undefined;
        const candidate = {
          callId,
          name: pending.name,
          arguments: pending.arguments,
          argumentsTruncated: pending.argumentsTruncated,
          durationMs,
          startedAt,
          completedAt,
          turn: pending.turn,
          step: pending.step,
          returnValue: returnClipped.text,
          returnValueTruncated: returnClipped.truncated,
          isError,
        };
        const previous = state.longestToolCall;
        const longestToolCall =
          previous === null || durationMs > previous.durationMs ? candidate : previous;
        return {
          ...state,
          toolResults: state.toolResults + 1,
          pendingCalls,
          longestToolCall,
        };
      }
      case "step/end":
        return { ...state, openStep: null };
      case "turn/end":
        return Object.keys(state.pendingCalls).length === 0 && state.openStep === null
          ? state
          : { ...state, pendingCalls: {}, openStep: null };
      default:
        return state;
    }
  },
  view: (state) => {
    const runningCalls = Object.values(state.pendingCalls)
      .sort((left, right) => left.startedAt - right.startedAt)
      .slice(0, MAX_RUNNING_ROWS)
      .map((call) => {
        const argumentsClipped = clipText(call.arguments, MAX_RUNNING_ARGS_CHARS);
        return {
          callId: call.callId,
          name: call.name,
          arguments: argumentsClipped.text,
          argumentsTruncated: argumentsClipped.truncated,
          startedAt: call.startedAt,
          turn: call.turn,
          step: call.step,
        };
      });
    return {
      toolCalls: state.toolCalls,
      toolResults: state.toolResults,
      longestToolCall: state.longestToolCall,
      runningCalls,
      openStep: state.openStep,
    };
  },
};


// ---------------------------------------------------------------------------
// sessionTurnUsage — per-turn provider-reported token usage (whole-log).
// ---------------------------------------------------------------------------
const turnUsageEntrySchema = z
  .object({
    turn: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();

const sessionTurnUsageSchema = z
  .object({
    turns: z.array(turnUsageEntrySchema),
  })
  .strict();

function usageBuckets(usage) {
  return {
    inputTokens: typeof usage?.inputTokens === "number" ? usage.inputTokens : 0,
    outputTokens: typeof usage?.outputTokens === "number" ? usage.outputTokens : 0,
    cacheReadTokens: typeof usage?.cacheReadTokens === "number" ? usage.cacheReadTokens : 0,
    cacheWriteTokens: typeof usage?.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0,
  };
}

function usageEqual(left, right) {
  return left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens;
}

function turnTotal(entry) {
  return entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens;
}

const sessionTurnUsageProjectionDefinition = {
  key: "sessionTurnUsage",
  schema: sessionTurnUsageSchema,
  stateVersion: 1,
  init: () => ({ steps: {}, turnTotals: {} }),
  apply: (state, event) => {
    let turn;
    let step;
    let usage;
    if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
      turn = event.data.turn;
      step = event.data.step;
      usage = event.data.chunk.usage;
    } else if (event.type === "assistant/message" && event.data?.usage !== undefined) {
      turn = event.data.turn;
      step = event.data.step;
      usage = event.data.usage;
    } else {
      return state;
    }
    const key = `${turn}:${step}`;
    const next = usageBuckets(usage);
    const previous = state.steps[key];
    if (previous !== undefined && usageEqual(previous, next)) return state;
    const turnKey = String(turn);
    const previousTurn = state.turnTotals[turnKey];
    const nextTurn = {
      turn,
      inputTokens: (previousTurn?.inputTokens ?? 0) - (previous?.inputTokens ?? 0) + next.inputTokens,
      outputTokens: (previousTurn?.outputTokens ?? 0) - (previous?.outputTokens ?? 0) + next.outputTokens,
      cacheReadTokens: (previousTurn?.cacheReadTokens ?? 0) - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
      cacheWriteTokens: (previousTurn?.cacheWriteTokens ?? 0) - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    };
    nextTurn.totalTokens = turnTotal(nextTurn);
    const steps = { ...state.steps, [key]: next };
    const turnTotals = { ...state.turnTotals, [turnKey]: nextTurn };
    const keys = Object.keys(turnTotals);
    if (keys.length > 128) {
      const oldest = keys
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
        .slice(0, keys.length - 128);
      for (const oldTurn of oldest) delete turnTotals[String(oldTurn)];
    }
    return { steps, turnTotals };
  },
  view: (state) => ({
    turns: Object.values(state.turnTotals)
      .sort((a, b) => a.turn - b.turn)
      .slice(-24),
  }),
};

// ---------------------------------------------------------------------------
// DeepSeek balance endpoint (GET /dsh-desktop/deepseek-balance)
// ---------------------------------------------------------------------------
const BALANCE_ROUTE = "/dsh-desktop/deepseek-balance";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const BALANCE_FETCH_TIMEOUT_MS = 6000;

async function resolveDeepSeekKey(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) {
    try {
      const hit = await credentials.resolve("DEEPSEEK_API_KEY");
      if (hit !== undefined && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
    } catch (_) {
      // fall through to the ambient environment
    }
  }
  let env;
  try {
    env = launchEnvironmentOf(ctx).get("DEEPSEEK_API_KEY");
  } catch (_) {
    env = undefined;
  }
  return env !== undefined && typeof env.value === "string" && env.value.length > 0 ? env.value : null;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function fetchDeepSeekBalance(ctx) {
  const key = await resolveDeepSeekKey(ctx);
  if (key === null) {
    return { ok: false, error: "missing-credential", message: "DEEPSEEK_API_KEY not configured" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(DEEPSEEK_BALANCE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        "X-Client": "dsh-desktop",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: "http", status: response.status, message: `DeepSeek API responded ${response.status}` };
    }
    const payload = await response.json();
    const first = Array.isArray(payload.balance_infos) ? payload.balance_infos[0] : undefined;
    if (first === undefined || typeof first.total_balance !== "string") {
      return { ok: false, error: "shape", message: "unexpected balance payload" };
    }
    return {
      ok: true,
      balance: {
        available: payload.is_available === true,
        currency: typeof first.currency === "string" ? first.currency : "CNY",
        total: first.total_balance,
        granted: typeof first.granted_balance === "string" ? first.granted_balance : "0",
        toppedUp: typeof first.topped_up_balance === "string" ? first.topped_up_balance : "0",
        fetchedAt: Date.now(),
      },
    };
  } catch (error) {
    return { ok: false, error: "network", message: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

function registerBalanceRoute(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: BALANCE_ROUTE,
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method", message: "GET only" });
          return;
        }
        const body = await fetchDeepSeekBalance(ctx);
        sendJson(res, 200, body);
      },
    }),
    "dsh-desktop-session-stats: balance route",
  );
}

function apply(ctx) {
  ctx.sessionProjections.register(sessionToolDetailProjectionDefinition);
  ctx.sessionProjections.register(sessionTurnUsageProjectionDefinition);
  registerBalanceRoute(ctx);
}

export { apply, inject, name };
