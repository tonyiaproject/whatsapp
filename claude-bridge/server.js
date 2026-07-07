const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3001;
const AGENTS_FILE = process.env.AGENTS_FILE || path.join(__dirname, 'agents.json');
const MAX_HISTORY_MESSAGES = 20;

// Random reply delay so response timing doesn't look mechanically constant.
const MIN_REPLY_DELAY_MS = parseInt(process.env.MIN_REPLY_DELAY_MS || '2000', 10);
const MAX_REPLY_DELAY_MS = parseInt(process.env.MAX_REPLY_DELAY_MS || '8000', 10);

function randomReplyDelay() {
  const ms = MIN_REPLY_DELAY_MS + Math.random() * (MAX_REPLY_DELAY_MS - MIN_REPLY_DELAY_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://api:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const FALLBACK_AGENT = {
  model: 'claude-haiku-4-5-20251001',
  maxTokens: 120,
  systemPrompt: 'Eres un asistente de atención al cliente. Responde de forma breve y amable.',
  welcomeMessage: 'Hola 👋 este número aún no tiene su asistente configurado.',
  handoffMessage: 'Claro, en un momento te contacta alguien del equipo 🙌',
};

// Reads agents.json fresh on every call -- editing the file takes effect on the
// very next message, no restart needed. A JSON typo falls back to a safe default
// instead of crashing the whole bridge for every instance.
function loadAgentConfig(instanceName) {
  let all;
  try {
    all = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read/parse ${AGENTS_FILE}:`, err.message);
    return FALLBACK_AGENT;
  }
  return all[instanceName] || all._default || FALLBACK_AGENT;
}

// In-memory conversation history, keyed per instance + contact. Resets on restart.
const conversations = new Map();
function conversationKey(instanceName, user) {
  return `${instanceName || 'unknown'}:${user}`;
}

// Phrases that hand the conversation off to a human. Matched as substrings, accent/case-insensitive.
const HANDOFF_TRIGGERS = [
  'hablar con tony',
  'hablar con un humano',
  'hablar con una persona',
  'pasame con tony',
  'pasame con un humano',
  'pasame con una persona',
  'quiero hablar con alguien real',
];

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function isHandoffRequest(text) {
  const normalized = normalize(text);
  return HANDOFF_TRIGGERS.some((trigger) => normalized.includes(trigger));
}

async function closeBotSession(instanceName, remoteJid) {
  if (!instanceName || !remoteJid) return;
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/evolutionBot/changeStatus/${instanceName}`,
      { remoteJid, status: 'closed' },
      { headers: { apikey: EVOLUTION_API_KEY } },
    );
  } catch (err) {
    console.error('Failed to close bot session:', err.response?.data || err.message);
  }
}

const app = express();
app.use(express.json());

app.post('/webhook', async (req, res) => {
  const { query, user, inputs } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.json({ message: null });
  }

  const instanceName = inputs?.instanceName;
  const agent = loadAgentConfig(instanceName);
  const key = conversationKey(instanceName, user);

  let reply;

  if (isHandoffRequest(query)) {
    conversations.delete(key);
    await closeBotSession(instanceName, inputs?.remoteJid || user);
    reply = agent.handoffMessage;
  } else if (!conversations.has(key)) {
    conversations.set(key, []);
    reply = agent.welcomeMessage;
  } else {
    const history = conversations.get(key);
    history.push({ role: 'user', content: query });

    try {
      const response = await anthropic.messages.create({
        model: agent.model,
        max_tokens: agent.maxTokens,
        system: agent.systemPrompt,
        messages: history,
      });

      reply = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      history.push({ role: 'assistant', content: reply });
      conversations.set(key, history.slice(-MAX_HISTORY_MESSAGES));
    } catch (err) {
      console.error('Anthropic error:', err.message);
      reply = 'Disculpa, tuve un problema. Intenta de nuevo.';
    }
  }

  await randomReplyDelay();
  return res.json({ message: reply });
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`claude-bridge listening on ${PORT}, agents file=${AGENTS_FILE}`));
