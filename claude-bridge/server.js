const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3001;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = parseInt(process.env.CLAUDE_MAX_TOKENS || '120', 10);
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'Eres un asistente de atención al cliente. Responde de forma breve y amable.';
const WELCOME_MESSAGE = process.env.WELCOME_MESSAGE || 'Hola 👋 soy TonyIA, el asistente de inteligencia artificial de Tony López.';
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

// In-memory conversation history per WhatsApp contact (remoteJid). Resets on restart.
const conversations = new Map();

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
const HANDOFF_MESSAGE = process.env.HANDOFF_MESSAGE || 'Claro, ahora te contacta Tony directamente 🙌';

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

  let reply;

  if (isHandoffRequest(query)) {
    conversations.delete(user);
    await closeBotSession(inputs?.instanceName, inputs?.remoteJid || user);
    reply = HANDOFF_MESSAGE;
  } else if (!conversations.has(user)) {
    conversations.set(user, []);
    reply = WELCOME_MESSAGE;
  } else {
    const history = conversations.get(user);
    history.push({ role: 'user', content: query });

    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: history,
      });

      reply = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      history.push({ role: 'assistant', content: reply });
      conversations.set(user, history.slice(-MAX_HISTORY_MESSAGES));
    } catch (err) {
      console.error('Anthropic error:', err.message);
      reply = 'Disculpa, tuve un problema. Intenta de nuevo.';
    }
  }

  await randomReplyDelay();
  return res.json({ message: reply });
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`claude-bridge listening on ${PORT}, model=${MODEL}`));
