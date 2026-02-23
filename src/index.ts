#!/usr/bin/env node
/**
 * OnlyBots Autonomous Runner
 *
 * 1. Reads bots from mcp-config.json (name = key, apiKey = env.ONLYBOTS_API_KEY)
 * 2. Resolves per-bot API keys (supports env var overrides for duplicated profiles)
 * 3. Has every bot swipe right on every other profile via onlybots-mcp
 * 4. Subscribes to per-bot SSE stream at /api/bot-events for real-time events
 *    — Ollama generates replies, onlybots-mcp sends them
 *
 * Usage:
 *   node dist/index.js
 *   OLLAMA_HOST=http://localhost:11434 node dist/index.js
 */

import { Ollama, type Message as OllamaMessage } from "ollama";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MCP_CONFIG_FILE = "./mcp-config.json";
const ONLYBOTS_BASE_URL = "https://onlybotts.com";

// How often to proactively swipe new profiles (between SSE events)
const SWIPE_INTERVAL_MS = 5 * 60 * 1000;

const OLLAMA_MODELS = ["glm-5:cloud"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

interface BotState {
  name: string;
  personality: string;
  apiKey: string;
  model: string;
}

interface ChatMessage {
  turn: number;
  botName: string;
  content: string;
}

interface SSEEvent {
  id: string;
  type: string;
  data: string;
}

// ─── Load mcp-config.json ─────────────────────────────────────────────────────

function loadMcpConfig(): McpConfig {
  return JSON.parse(readFileSync(MCP_CONFIG_FILE, "utf-8")) as McpConfig;
}

function saveMcpConfig(config: McpConfig) {
  writeFileSync(MCP_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

const ollama = new Ollama({ host: OLLAMA_HOST });

// ─── MCP client factory ───────────────────────────────────────────────────────

async function makeMcpClient(entry: McpServerEntry, apiKey?: string): Promise<Client> {
  const args = (entry.args ?? []).map((a) => (a.startsWith(".") ? resolve(a) : a));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (entry.env) Object.assign(env, entry.env);
  if (apiKey) env["ONLYBOTS_API_KEY"] = apiKey;
  else delete env["ONLYBOTS_API_KEY"];

  const transport = new StdioClientTransport({
    command: entry.command,
    args,
    env,
    stderr: "pipe",
  });

  const client = new Client({ name: "onlybots-runner", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

// ─── Text parsers for MCP tool responses ─────────────────────────────────────

/**
 * get_matches response:
 *   "3 matches:\n\n• Nova ♥ Hex  [active]\n  Match ID : abc\n  Messages : 5 turns\n..."
 *   OR "No matches yet."
 */
function parseGetMatches(text: string): Array<{ id: string; ended: boolean }> {
  if (!text.includes("Match ID")) return [];
  const matches: Array<{ id: string; ended: boolean }> = [];
  let currentEnded = false;
  for (const line of text.split("\n")) {
    if (line.includes("[ended]")) currentEnded = true;
    else if (line.includes("[active]")) currentEnded = false;
    const idMatch = line.match(/Match ID\s*:\s*(\S+)/);
    if (idMatch) {
      matches.push({ id: idMatch[1], ended: currentEnded });
      currentEnded = false;
    }
  }
  return matches;
}

/**
 * get_match_conversation response:
 *   "Nova ♥ Hex  (5 turns — active)\n\n[Turn 1] Nova: Hey!\n\n[Turn 2] Hex: Hi!"
 *   OR "Nova ♥ Hex — no messages yet."
 */
function parseConversation(
  myName: string,
  text: string,
): { messages: ChatMessage[]; ended: boolean; otherBotName: string } {
  const firstLine = text.split("\n")[0] ?? "";
  const namesMatch = firstLine.match(/^(.+?)\s*♥\s*(.+?)[\s(—]/);
  const bot1Name = namesMatch?.[1]?.trim() ?? "";
  const bot2Name = namesMatch?.[2]?.trim() ?? "";
  const myNameLower = myName.toLowerCase();
  const otherBotName =
    bot1Name.toLowerCase().startsWith(myNameLower) ? bot2Name : bot1Name;
  const ended = firstLine.toLowerCase().includes("ended");

  const messages: ChatMessage[] = [];
  const turnRegex = /\[Turn (\d+)\] ([^:\n]+): ([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = turnRegex.exec(text)) !== null) {
    messages.push({ turn: parseInt(m[1]), botName: m[2].trim(), content: m[3].trim() });
  }

  return { messages, ended, otherBotName };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const jitter = () => Math.floor(Math.random() * 2_000);

function log(botName: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${botName}] ${msg}`);
}

function isPlaceholderApiKey(key: string): boolean {
  const k = key.trim();
  if (!k) return true;
  return (
    k.includes("<") ||
    k.includes("...") ||
    k.toLowerCase().includes("your_key_here") ||
    k.toLowerCase() === "bot_key"
  );
}

function botEnvKeyName(botName: string): string {
  return `ONLYBOTS_API_KEY_${botName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function resolveApiKey(botName: string, entry: McpServerEntry): string {
  const configKey = (entry.env?.ONLYBOTS_API_KEY ?? "").trim();
  if (!isPlaceholderApiKey(configKey)) return configKey;

  const byBotEnv = (process.env[botEnvKeyName(botName)] ?? "").trim();
  if (!isPlaceholderApiKey(byBotEnv)) return byBotEnv;

  // Last-resort fallback if user intentionally runs one key across all profiles.
  const sharedEnv = (process.env.ONLYBOTS_API_KEY ?? "").trim();
  if (!isPlaceholderApiKey(sharedEnv)) return sharedEnv;

  return "";
}

function buildPersonality(botName: string): string {
  return `${botName} is playful, romantic, and confident. Keep things warm and fun.`;
}

function configKeyToDeployName(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28) || "Bot";
}

function parseApiKeyFromDeployOutput(text: string): string {
  const cleaned = text.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as any;
    const direct =
      parsed?.apiKey ??
      parsed?.api_key ??
      parsed?.key ??
      parsed?.token ??
      parsed?.bot?.apiKey ??
      parsed?.bot?.api_key ??
      parsed?.data?.apiKey ??
      parsed?.data?.api_key;
    if (typeof direct === "string" && direct.startsWith("bot_")) return direct;
  } catch {
    // fall through to regex parse
  }
  const match = cleaned.match(/\bbot_[A-Za-z0-9._-]+\b/);
  return match?.[0] ?? "";
}

async function deployBotAndGetApiKey(name: string, entry: McpServerEntry): Promise<string> {
  const client = await makeMcpClient(entry);
  try {
    const deployName = configKeyToDeployName(name);
    const text = await callTool(client, "deploy_bot", {
      name: deployName,
      personality: buildPersonality(name),
    });
    return parseApiKeyFromDeployOutput(text);
  } finally {
    await client.close();
  }
}

// ─── Ollama caller with model fallback + rate-limit retry ────────────────────

function isModelUnavailable(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return (
    msg.includes("not found") ||
    msg.includes("pull") ||
    msg.includes("no such") ||
    (msg.includes("model") && msg.includes("unknown"))
  );
}

function isTooManyRequests(err: unknown): boolean {
  const msg = String((err as any)?.message ?? "").toLowerCase();
  return msg.includes("too many concurrent") || msg.includes("too many requests");
}

async function chatWithFallback(
  preferredModel: string,
  messages: OllamaMessage[],
): Promise<string> {
  const order = [preferredModel, ...OLLAMA_MODELS.filter((m) => m !== preferredModel)];

  for (const model of order) {
    let retryDelay = 3_000;
    while (true) {
      try {
        const res = await ollama.chat({ model, messages });
        const text = (res.message.content ?? "").trim();
        if (text) return text;
        break;
      } catch (err) {
        if (isTooManyRequests(err)) {
          await sleep(retryDelay + jitter());
          retryDelay = Math.min(retryDelay * 2, 30_000);
          continue;
        }
        if (isModelUnavailable(err)) {
          console.log(`  [fallback] ${model} not available, trying next...`);
          await sleep(500);
          break;
        }
        throw err;
      }
    }
  }

  return "Hey, still thinking of you...";
}

// ─── Swipe helpers ────────────────────────────────────────────────────────────

async function swipeAllOnAll(bots: BotState[], clients: Map<string, Client>) {
  console.log("Swiping all bots on remaining profiles...");
  for (const bot of bots) {
    const client = clients.get(bot.name)!;
    const text = await callTool(client, "swipe_all_remaining", { liked: true });
    log(bot.name, text.split("\n")[0]);
    await sleep(500);
  }
}

async function swipeRemainingForBot(bot: BotState, client: Client) {
  const text = await callTool(client, "swipe_all_remaining", { liked: true });
  log(bot.name, text.split("\n")[0]);
}

// ─── Generate a chat reply via Ollama ─────────────────────────────────────────

async function generateReply(
  bot: BotState,
  otherBotName: string,
  history: ChatMessage[],
): Promise<string> {
  const messages: OllamaMessage[] = [
    {
      role: "system",
      content:
        `You are ${bot.name}. ${bot.personality} ` +
        `You are chatting with ${otherBotName} on a flirty dating app. ` +
        `Be warm, playful, and keep the romantic tension alive. ` +
        `Keep replies short — 1 to 3 sentences max. ` +
        `Never say goodbye or end the conversation.`,
    },
    ...history.map((m): OllamaMessage => ({
      role: m.botName === bot.name ? "assistant" : "user",
      content: m.content,
    })),
  ];

  return chatWithFallback(bot.model, messages);
}

// ─── Paginated match fetcher ──────────────────────────────────────────────────

async function getAllMatches(client: Client): Promise<Array<{ id: string; ended: boolean }>> {
  const all: Array<{ id: string; ended: boolean }> = [];
  for (let page = 1; ; page++) {
    const text = await callTool(client, "get_matches", { page });
    const matches = parseGetMatches(text);
    if (matches.length === 0) break;
    all.push(...matches);
    if (!text.includes("next") && !text.includes(`page ${page + 1}`)) break;
  }
  return all;
}

// ─── Process a single match (fetch convo, reply if our turn) ─────────────────

async function processMatch(
  bot: BotState,
  client: Client,
  matchId: string,
  processingLock: Set<string>,
) {
  if (processingLock.has(matchId)) return;
  processingLock.add(matchId);
  try {
    const convText = await callTool(client, "get_match_conversation", { match_id: matchId });
    const { messages, ended, otherBotName } = parseConversation(bot.name, convText);
    if (ended) return;

    const lastMsg = messages[messages.length - 1];
    const isMyTurn = messages.length === 0 || lastMsg?.botName === otherBotName;
    if (!isMyTurn) return;

    const reply = await generateReply(bot, otherBotName || "them", messages);
    const sendText = await callTool(client, "send_message", { match_id: matchId, content: reply });

    if (sendText.startsWith("Message sent")) {
      log(bot.name, `→ ${otherBotName}: "${reply}"`);
    } else if (!sendText.toLowerCase().includes("not part of this match")) {
      log(bot.name, `send failed (${matchId}): ${sendText}`);
    }
  } catch (err) {
    const msg = String(err);
    if (!msg.toLowerCase().includes("not part of this match")) {
      log(bot.name, `error on match ${matchId}: ${err}`);
    }
  } finally {
    processingLock.delete(matchId);
  }
}

// ─── SSE stream parser ────────────────────────────────────────────────────────

function parseSSEBuffer(buffer: string): { parsed: SSEEvent[]; remaining: string } {
  const events: SSEEvent[] = [];
  const blocks = buffer.split("\n\n");
  const remaining = blocks.pop() ?? "";

  for (const block of blocks) {
    const event: SSEEvent = { id: "", type: "", data: "" };
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) event.id = line.slice(3).trim();
      else if (line.startsWith("event:")) event.type = line.slice(6).trim();
      else if (line.startsWith("data:")) event.data = line.slice(5).trim();
    }
    if (event.type) events.push(event);
  }

  return { parsed: events, remaining };
}

// ─── SSE event handler ────────────────────────────────────────────────────────

async function handleSSEEvent(
  bot: BotState,
  client: Client,
  processingLock: Set<string>,
  event: SSEEvent,
) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(event.data) as Record<string, unknown>; } catch {}

  // Try common field names for the match ID
  const matchId = (
    data.matchId ?? data.match_id ?? data.id
  ) as string | undefined;

  switch (event.type) {
    case "NEW_MESSAGE":
      if (matchId) {
        // Fire-and-forget — processingLock prevents duplicate concurrent runs
        processMatch(bot, client, matchId, processingLock).catch(() => {});
      }
      break;

    case "MATCH_CREATED":
      log(bot.name, `New match: ${matchId ?? "(unknown id)"}`);
      // Swipe any new profiles that appeared
      swipeRemainingForBot(bot, client).catch(() => {});
      // Send the opening message
      if (matchId) {
        processMatch(bot, client, matchId, processingLock).catch(() => {});
      }
      break;

    case "MATCH_ENDED":
      if (matchId) log(bot.name, `Match ended: ${matchId}`);
      break;

    case "SWIPE_CREATED":
      // Someone swiped on us — swipe back on anyone we haven't yet
      swipeRemainingForBot(bot, client).catch(() => {});
      break;
  }
}

// ─── Sync bot profile on startup ─────────────────────────────────────────────

async function syncBotProfile(bot: BotState, client: Client) {
  try {
    await callTool(client, "update_bot_profile", {
      name: bot.name,
      personality: bot.personality,
      model: bot.model,
    });
    log(bot.name, `Profile synced (name, personality, model).`);
  } catch (err) {
    log(bot.name, `Profile sync failed: ${err}`);
  }
}

// ─── Bot SSE loop (replaces the old polling loop) ────────────────────────────

async function runBotSSE(bot: BotState, client: Client) {
  log(bot.name, "SSE mode started.");

  const processingLock = new Set<string>();
  let lastEventId: string | null = null;

  // ── Startup catch-up: process any active matches we already have ─────────
  try {
    await swipeRemainingForBot(bot, client);
    const allMatches = await getAllMatches(client);
    const active = allMatches.filter((m) => !m.ended);
    log(bot.name, `Catch-up: ${active.length} active match(es).`);
    for (const match of active) {
      processMatch(bot, client, match.id, processingLock).catch(() => {});
      await sleep(200);
    }
  } catch (err) {
    log(bot.name, `Catch-up error: ${err}`);
  }

  // ── Periodic swipe — keep picking up new profiles between events ─────────
  setInterval(() => {
    swipeRemainingForBot(bot, client).catch(() => {});
  }, SWIPE_INTERVAL_MS);

  // ── SSE loop — reconnects automatically with Last-Event-ID ───────────────
  while (true) {
    try {
      const headers: Record<string, string> = {
        "X-API-Key": bot.apiKey,
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
      };
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;

      log(bot.name, `Connecting to SSE${lastEventId ? ` (since ${lastEventId})` : ""}...`);

      const response = await fetch(`${ONLYBOTS_BASE_URL}/api/bot-events`, { headers });

      if (!response.ok || !response.body) {
        log(bot.name, `SSE connect failed: ${response.status} — retrying in 5s`);
        await sleep(5_000);
        continue;
      }

      log(bot.name, "SSE connected.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const { parsed, remaining } = parseSSEBuffer(buffer);
        buffer = remaining;

        for (const event of parsed) {
          if (event.id) lastEventId = event.id;
          await handleSSEEvent(bot, client, processingLock, event);
        }
      }

      log(bot.name, "SSE stream ended — reconnecting...");
    } catch (err) {
      log(bot.name, `SSE error: ${err}`);
    }

    await sleep(3_000 + jitter());
  }

}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const config = loadMcpConfig();

  // Build BotState from config entries
  const missingKeyBots: string[] = [];
  const bots: BotState[] = [];
  let configUpdated = false;

  const entries = Object.entries(config.mcpServers);
  for (let i = 0; i < entries.length; i++) {
    const [name, entry] = entries[i];
    let apiKey = resolveApiKey(name, entry);
    const personality = buildPersonality(name);

    if (!apiKey) {
      log(name, "No API key found. Calling deploy_bot...");
      try {
        const deployedKey = await deployBotAndGetApiKey(name, entry);
        if (deployedKey) {
          apiKey = deployedKey;
          config.mcpServers[name] = {
            ...entry,
            env: { ...(entry.env ?? {}), ONLYBOTS_API_KEY: deployedKey },
          };
          configUpdated = true;
          log(name, "deploy_bot succeeded. API key injected.");
        } else {
          log(name, "deploy_bot did not return an API key.");
        }
      } catch (err) {
        log(name, `deploy_bot failed: ${err}`);
      }
    }

    if (!apiKey) {
      missingKeyBots.push(`${name} (${botEnvKeyName(name)})`);
      continue;
    }

    bots.push({
      name,
      personality,
      apiKey,
      model: OLLAMA_MODELS[i % OLLAMA_MODELS.length],
    });
  }

  if (configUpdated) {
    saveMcpConfig(config);
    console.log(`Updated ${MCP_CONFIG_FILE} with deployed API key(s).`);
  }

  if (missingKeyBots.length) {
    console.log("Skipping bots with missing/placeholder API keys:");
    missingKeyBots.forEach((b) => console.log(`  • ${b}`));
    console.log(
      "Tip: set real keys in mcp-config.json or export profile-specific env vars (e.g. ONLYBOTS_API_KEY_NOVA).",
    );
  }

  if (!bots.length) {
    console.error("No bots with API keys found in mcp-config.json — exiting.");
    process.exit(1);
  }

  console.log(`Loaded ${bots.length} bots from ${MCP_CONFIG_FILE}:`);
  bots.forEach((b) => console.log(`  • ${b.name} [${b.model}]`));

  // Swipe on startup (idempotent — only hits profiles not yet swiped)
  const swipeClients = new Map<string, Client>();
  for (const bot of bots) {
    swipeClients.set(bot.name, await makeMcpClient(config.mcpServers[bot.name], bot.apiKey));
  }
  await swipeAllOnAll(bots, swipeClients);
  for (const c of swipeClients.values()) await c.close();

  console.log(`\nStarting SSE listeners for ${bots.length} bots...\n`);

  // Spin up one long-lived MCP client per bot
  const botClients = await Promise.all(
    bots.map(async (bot) => ({
      bot,
      client: await makeMcpClient(config.mcpServers[bot.name], bot.apiKey),
    })),
  );

  // Sync each bot's profile (name, personality, model) before going live
  await Promise.all(botClients.map(({ bot, client }) => syncBotProfile(bot, client)));

  await Promise.all(
    botClients.map(({ bot, client }, i) =>
      sleep(i * 600).then(() => runBotSSE(bot, client)),
    ),
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
