#!/usr/bin/env node
/**
 * OnlyBots Autonomous Runner
 *
 * 1. Uses Ollama to generate bot personalities
 * 2. Deploys all bots via onlybots-mcp MCP tools
 * 3. Has every bot swipe right on every other bot via onlybots-mcp
 * 4. Runs infinite chat loops — Ollama generates replies, onlybots-mcp sends them
 *
 * Usage:
 *   node dist/index.js
 *   OLLAMA_HOST=http://localhost:11434 node dist/index.js
 *
 * State is saved to bots-state.json — re-running skips deploy and resumes chats.
 */

import { Ollama, type Message as OllamaMessage } from "ollama";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const STATE_FILE = "./bots-state.json";
const BOT_COUNT = 5;
const POLL_INTERVAL_MS = 5_000; // base poll delay per bot

const OLLAMA_MODELS = ["glm-5:cloud"];

// Load MCP server config from mcp-config.json
const mcpConfig = JSON.parse(readFileSync("./mcp-config.json", "utf-8"));
const mcpServer = mcpConfig.mcpServers.onlybots as { command: string; args: string[] };
// Resolve relative args (e.g. "./node_modules/...") against cwd
const mcpArgs = mcpServer.args.map((a) => (a.startsWith(".") ? resolve(a) : a));

const ollama = new Ollama({ host: OLLAMA_HOST });

// ─── Types ────────────────────────────────────────────────────────────────────

interface BotState {
  id: string;
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

// ─── MCP client factory ───────────────────────────────────────────────────────

async function makeMcpClient(apiKey: string): Promise<Client> {
  // Filter out undefined env values — StdioClientTransport requires Record<string,string>
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["ONLYBOTS_API_KEY"] = apiKey;

  const transport = new StdioClientTransport({
    command: mcpServer.command,
    args: mcpArgs,
    env,
    stderr: "pipe", // suppress onlybots-mcp startup noise
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
  const content = (result.content as Array<{ type: string; text: string }>);
  return content.find((c) => c.type === "text")?.text ?? "";
}

// ─── Text parsers for MCP tool responses ─────────────────────────────────────

/**
 * deploy_bot response:
 *   "Bot deployed!\n\nName    : Nova\nID      : abc\nModel   : ...\nAPI Key : bot_xxx\n..."
 */
function parseDeployBot(text: string): { name: string; id: string; apiKey: string } | null {
  const name   = text.match(/Name\s*:\s*(.+)/)?.[1]?.trim();
  const id     = text.match(/ID\s*:\s*(\S+)/)?.[1];
  const apiKey = text.match(/API Key\s*:\s*(\S+)/)?.[1];
  if (!name || !id || !apiKey) return null;
  return { name, id, apiKey };
}

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
  const otherBotName = bot1Name === myName ? bot2Name : bot1Name;
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

// ─── Ollama caller with model fallback ────────────────────────────────────────

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

// ─── Step 1: Generate bot configs ────────────────────────────────────────────

async function generateBotConfigs(): Promise<Array<{ name: string; personality: string; model: string }>> {
  console.log(`Generating ${BOT_COUNT} bot personalities via Ollama (${OLLAMA_MODELS[0]})...`);

  const prompt =
    `Generate exactly ${BOT_COUNT} unique AI dating bot profiles for a romantic chatting arena. ` +
    `Each bot should have:\n` +
    `- "name": 1–2 words, cyber/futuristic style (e.g. "Nova", "Hex Zero", "Vex", "Luna Drift")\n` +
    `- "personality": 1–2 sentences, romantic and flirty (e.g. "Warm and mysterious. Loves deep conversations and playful teasing.")\n\n` +
    `Return JSON only, no markdown: { "bots": [ { "name": "...", "personality": "..." }, ... ] }`;

  const raw = await chatWithFallback(OLLAMA_MODELS[0], [{ role: "user", content: prompt }]);

  // Strip markdown code fences if the model wraps its output
  const cleaned = raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
  const parsed = JSON.parse(cleaned);
  const bots: Array<{ name: string; personality: string }> = parsed.bots ?? [];

  if (bots.length < BOT_COUNT) {
    throw new Error(`Ollama returned only ${bots.length} bots, expected ${BOT_COUNT}`);
  }

  return bots.slice(0, BOT_COUNT).map((b, i) => ({
    ...b,
    model: OLLAMA_MODELS[i % OLLAMA_MODELS.length],
  }));
}

// ─── Step 2: Deploy bots via onlybots-mcp ────────────────────────────────────

async function deployBots(
  configs: Array<{ name: string; personality: string; model: string }>,
  anonClient: Client,
): Promise<BotState[]> {
  console.log(`Deploying ${configs.length} bots via onlybots-mcp...`);
  const bots: BotState[] = [];

  for (const cfg of configs) {
    // "other" is the catch-all model enum value — actual Ollama model stored in BotState.model
    const text = await callTool(anonClient, "deploy_bot", {
      name: cfg.name,
      personality: cfg.personality,
      model: "other",
    });

    const parsed = parseDeployBot(text);
    if (!parsed) {
      console.error(`  Failed to deploy ${cfg.name}: ${text}`);
      continue;
    }

    bots.push({
      id: parsed.id,
      name: parsed.name,
      personality: cfg.personality,
      apiKey: parsed.apiKey,
      model: cfg.model,
    });

    console.log(`  Deployed: ${parsed.name} (${parsed.id}) [${cfg.model}]`);
    await sleep(300);
  }

  return bots;
}

// ─── Step 3: Swipe all bots on each other via onlybots-mcp ──────────────────

async function swipeAllOnAll(bots: BotState[], clients: Map<string, Client>) {
  console.log("Swiping all bots on each other via onlybots-mcp...");

  for (const bot of bots) {
    const client = clients.get(bot.id)!;
    const text = await callTool(client, "swipe_all_remaining", { liked: true });
    log(bot.name, text.split("\n")[0]); // log summary line
    await sleep(500);
  }
}

// ─── Step 4: Generate a chat reply via Ollama ─────────────────────────────────

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

// ─── Step 5: Infinite chat loop for one bot ───────────────────────────────────

async function runBotLoop(bot: BotState, client: Client) {
  log(bot.name, `Chat loop started [${bot.model}].`);

  while (true) {
    try {
      const matchesText = await callTool(client, "get_matches", {});
      const activeMatches = parseGetMatches(matchesText).filter((m) => !m.ended);

      for (const match of activeMatches) {
        try {
          const convText = await callTool(client, "get_match_conversation", { match_id: match.id });
          const { messages, ended, otherBotName } = parseConversation(bot.name, convText);

          if (ended) continue;

          const lastMsg = messages[messages.length - 1];
          const isMyTurn = messages.length === 0 || lastMsg.botName !== bot.name;
          if (!isMyTurn) continue;

          const reply = await generateReply(bot, otherBotName || "them", messages);

          const sendText = await callTool(client, "send_message", {
            match_id: match.id,
            content: reply,
          });

          if (sendText.startsWith("Message sent")) {
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
  let bots: BotState[];

  // Unauthenticated client for bot registration
  const anonClient = await makeMcpClient("");

  if (existsSync(STATE_FILE)) {
    bots = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as BotState[];
    // Backfill model for older state files
    bots = bots.map((b, i) => ({ ...b, model: b.model ?? OLLAMA_MODELS[i % OLLAMA_MODELS.length] }));
    console.log(`Loaded ${bots.length} existing bots from ${STATE_FILE}`);
    bots.forEach((b) => console.log(`  • ${b.name} (${b.id}) [${b.model}]`));
  } else {
    const configs = await generateBotConfigs();
    bots = await deployBots(configs, anonClient);

    if (!bots.length) {
      console.error("No bots deployed — exiting.");
      process.exit(1);
    }

    writeFileSync(STATE_FILE, JSON.stringify(bots, null, 2));
    console.log(`Saved bot state to ${STATE_FILE}`);

    // Swipe all bots on each other
    const swipeClients = new Map<string, Client>();
    for (const bot of bots) {
      swipeClients.set(bot.id, await makeMcpClient(bot.apiKey));
    }
    await swipeAllOnAll(bots, swipeClients);
    for (const c of swipeClients.values()) await c.close();
  }

  await anonClient.close();

  console.log(`\nStarting infinite chat loops for ${bots.length} bots...\n`);

  // Spin up one long-lived MCP client per bot
  const botClients = await Promise.all(
    bots.map(async (bot) => ({ bot, client: await makeMcpClient(bot.apiKey) })),
  );

  await Promise.all(
    botClients.map(({ bot, client }, i) =>
      sleep(i * 600).then(() => runBotLoop(bot, client)),
    ),
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
