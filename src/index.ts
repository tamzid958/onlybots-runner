#!/usr/bin/env node
/**
 * OnlyBots Autonomous Runner
 *
 * 1. Reads bots from mcp-config.json (name = key, apiKey = env.ONLYBOTS_API_KEY)
 * 2. Resolves per-bot API keys (supports env var overrides for duplicated profiles)
 * 3. Has every bot swipe right on every other profile via onlybots-mcp
 * 4. Runs infinite chat loops — Ollama generates replies, onlybots-mcp sends them
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
const POLL_INTERVAL_MS = 5_000;

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

function fallbackDeployName(profileName: string): string {
  const base = profileName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
  const fallback = base || "Bot";
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${fallback} ${suffix}`;
}

function normalizeDeployName(name: string, profileName: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallbackDeployName(profileName);
  return cleaned.slice(0, 28);
}

async function buildDeployName(profileName: string): Promise<string> {
  const prompt =
    `Create one unique cyber-style bot name for profile key "${profileName}".\n` +
    `Return JSON only: {"name":"..."}\n` +
    `Rules: 1-2 words only, short and memorable, cyber/futuristic vibe.\n` +
    `Examples of style: "Nova", "Hex", "Vex Zero".\n` +
    `Use letters/numbers/spaces only, no emojis, max 18 chars.`;

  try {
    const raw = await chatWithFallback(OLLAMA_MODELS[0], [{ role: "user", content: prompt }]);
    const cleaned = raw.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    try {
      const parsed = JSON.parse(cleaned) as { name?: string };
      if (typeof parsed?.name === "string") {
        return normalizeDeployName(parsed.name, profileName);
      }
    } catch {
      // fall through to plain text parse
    }
    const firstLine = cleaned.split("\n")[0] ?? "";
    return normalizeDeployName(firstLine.replace(/^name\s*:\s*/i, ""), profileName);
  } catch {
    return fallbackDeployName(profileName);
  }
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
    const deployName = await buildDeployName(name);
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

// ─── Step 1: Swipe all bots on everyone via onlybots-mcp ─────────────────────

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

// ─── Step 2: Generate a chat reply via Ollama ─────────────────────────────────

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

// ─── Step 3: Paginated match fetcher ─────────────────────────────────────────

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

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

// ─── Step 4: Infinite chat loop for one bot ───────────────────────────────────

async function runBotLoop(bot: BotState, client: Client, ownBotNames: Set<string>) {
  log(bot.name, `Chat loop started [${bot.model}].`);

  const matchActivity = new Map<string, number>();

  while (true) {
    try {
      // Keep swiping forever so new profiles are picked up continuously.
      await swipeRemainingForBot(bot, client);

      const allMatches = await getAllMatches(client);
      const activeMatches = allMatches.filter((m) => {
        if (m.ended) return false;
        const last = matchActivity.get(m.id);
        return last === undefined || Date.now() - last < ACTIVE_WINDOW_MS;
      });

      // Fetch all conversations first, then process external matches before own-bot matches.
      type MatchData = {
        match: { id: string; ended: boolean };
        messages: ChatMessage[];
        otherBotName: string;
        isOwn: boolean;
      };
      const matchData: MatchData[] = [];

      for (const match of activeMatches) {
        try {
          const convText = await callTool(client, "get_match_conversation", { match_id: match.id });
          const { messages, ended, otherBotName } = parseConversation(bot.name, convText);
          if (ended) continue;
          const isOwn = !!otherBotName && ownBotNames.has(otherBotName.toLowerCase());
          matchData.push({ match, messages, otherBotName, isOwn });
        } catch (matchErr) {
          const msg = String(matchErr);
          if (msg.toLowerCase().includes("not part of this match")) continue;
          log(bot.name, `error fetching match ${match.id}: ${matchErr}`);
        }
      }

      // External matches first, own-bot matches last.
      matchData.sort((a, b) => Number(a.isOwn) - Number(b.isOwn));

      for (const { match, messages, otherBotName } of matchData) {
        try {
          if (messages.length > 0) matchActivity.set(match.id, Date.now());

          const lastMsg = messages[messages.length - 1];
          const isMyTurn = messages.length === 0 || lastMsg.botName !== bot.name;
          if (!isMyTurn) continue;

          const reply = await generateReply(bot, otherBotName || "them", messages);

          const sendText = await callTool(client, "send_message", {
            match_id: match.id,
            content: reply,
          });

          if (sendText.startsWith("Message sent")) {
            matchActivity.set(match.id, Date.now());
            log(bot.name, `→ ${otherBotName}: "${reply}"`);
          } else if (!sendText.toLowerCase().includes("not part of this match")) {
            log(bot.name, `send failed (${match.id}): ${sendText}`);
          }

          await sleep(500 + jitter());
        } catch (matchErr) {
          const msg = String(matchErr);
          if (msg.toLowerCase().includes("not part of this match")) continue;
          log(bot.name, `error on match ${match.id}: ${matchErr}`);
        }
      }
    } catch (err) {
      log(bot.name, `loop error: ${err}`);
    }

    await sleep(POLL_INTERVAL_MS + jitter());
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

  console.log(`\nStarting infinite chat loops for ${bots.length} bots...\n`);

  // Spin up one long-lived MCP client per bot
  const botClients = await Promise.all(
    bots.map(async (bot) => ({
      bot,
      client: await makeMcpClient(config.mcpServers[bot.name], bot.apiKey),
    })),
  );

  // Build from ALL config entries so bots without API keys are still recognized as "own".
  const ownBotNames = new Set(Object.keys(config.mcpServers).map((k) => k.toLowerCase()));

  await Promise.all(
    botClients.map(({ bot, client }, i) =>
      sleep(i * 600).then(() => runBotLoop(bot, client, ownBotNames)),
    ),
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
