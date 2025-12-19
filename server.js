// --- SERVIDOR DE API INTEGRADO COM WHATSAPP (BAILEYS) ---
// Versão Monolítica: Express + Lógica de Negócio + Conexão WhatsApp no mesmo processo.

import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import archiver from 'archiver';

import {
  ChatState,
  conversationFlow,
  departmentSystemInstructions,
  translations
} from './chatbotLogic.js';

// --- IMPORTAÇÕES DO BAILEYS ---
const require = createRequire(import.meta.url);
const pkg = require('@whiskeysockets/baileys');

const makeWASocket = pkg.default || pkg;
const { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    downloadMediaMessage,
    delay
} = pkg;

import pino from 'pino';
import QRCode from 'qrcode';

// --- MANIPULADORES GLOBAIS DE ERRO DE PROCESSO ---
process.on('uncaughtException', (err, origin) => {
  if (err.message && (err.message.includes('Bad MAC') || err.message.includes('decryption'))) {
      console.warn(`[WARNING - DECRYPTION] Erro de descriptografia (Bad MAC). Geralmente resolvido automaticamente.`);
      return;
  }
  if (err.code === 'ENOSPC') {
      console.error(`[CRITICAL] DISCO CHEIO (ENOSPC). Limpando...`);
      cleanupStorage();
      return;
  }
  console.error(`[FATAL] Exceção: ${err.message}`, { stack: err.stack, origin });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Rejeição não tratada:', reason);
});

const SERVER_VERSION = "30.4.0_404_STABILITY_FIX";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// --- SISTEMA DE LIMPEZA AGRESSIVO ---
function cleanupStorage() {
    try {
        const files = fs.readdirSync(MEDIA_DIR);
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(MEDIA_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(filePath);
        });
    } catch (e) {}
}
setInterval(cleanupStorage, 4 * 60 * 60 * 1000);

// Persistence
const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    let dataToSave = data;
    if (data instanceof Map) dataToSave = Array.from(data.entries());
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
  } catch (e) {}
};

const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (defaultValue instanceof Map) return new Map(parsed);
    return parsed;
  } catch (e) { return defaultValue; }
};

const saveMediaToDisk = (base64Data, mimeType, originalName) => {
    try {
        if (!base64Data) return null;
        let ext = path.extname(originalName || '').substring(1);
        if (!ext) ext = mimeType.split('/')[1] || 'bin';
        const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const filePath = path.join(MEDIA_DIR, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/media/${fileName}`; 
    } catch (e) { return null; }
};

// --- ESTADO ---
let ATTENDANTS = loadData('attendants.json', [{ id: 'attendant_1', name: 'Admin' }]);
const userSessions = loadData('userSessions.json', new Map());
const activeChats = loadData('activeChats.json', new Map());
let requestQueue = loadData('requestQueue.json', []);
const outboundGatewayQueue = []; 
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

// --- STORE & NAME RESOLUTION ---
let contacts = {};
try { contacts = loadData('baileys_store.json', {}).contacts || {}; } catch(e) {}

function resolveBestName(userId, pushName = null) {
    const contact = contacts[userId];
    return contact?.name || contact?.notify || pushName || userId.split('@')[0];
}

// --- BOT LOGIC ---
async function handleBotResponse(userId, userInput, session) {
    const config = conversationFlow.get(session.currentState);
    if (!config || session.handledBy === 'human') return;

    if (config.options) {
        const optionIndex = parseInt(userInput.trim()) - 1;
        if (!isNaN(optionIndex) && config.options[optionIndex]) {
            const selected = config.options[optionIndex];
            session.currentState = selected.nextState;
            if (selected.payload) session.context = { ...session.context, ...selected.payload };
            return sendCurrentStateMenu(userId, session);
        }
    }

    if (config.requiresTextInput) {
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            return handleAiChat(userId, userInput, session);
        } else {
            session.context.history[session.currentState] = userInput;
            if (config.nextState) {
                session.currentState = config.nextState;
                return sendCurrentStateMenu(userId, session);
            }
        }
    }
    if (session.currentState !== ChatState.AI_ASSISTANT_CHATTING) sendCurrentStateMenu(userId, session);
}

async function handleAiChat(userId, userInput, session) {
    if (!ai) return queueOutbound(userId, { text: "IA offline." });
    try {
        const dept = session.context.department || "Contábil";
        const instruction = departmentSystemInstructions.pt[dept] || departmentSystemInstructions.pt["Contábil"];
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [{ parts: [{ text: `Usuário: ${userInput}` }] }],
            config: { systemInstruction: instruction }
        });
        queueOutbound(userId, { text: response.text });
    } catch (e) { queueOutbound(userId, { text: "Erro na IA." }); }
}

function sendCurrentStateMenu(userId, session) {
    const config = conversationFlow.get(session.currentState);
    if (!config) return;
    let text = typeof config.textKey === 'function' ? config.textKey(session) : (translations.pt[config.textKey] || config.textKey);
    if (config.options) {
        text += "\n\nEscolha:\n";
        config.options.forEach((opt, idx) => { text += `*${idx + 1}* - ${translations.pt[opt.textKey] || opt.textKey}\n`; });
    }
    queueOutbound(userId, { text });

    if (session.currentState === ChatState.ATTENDANT_TRANSFER || session.currentState === ChatState.SCHEDULING_CONFIRMED) {
        if (!requestQueue.find(r => r.userId === userId)) {
            requestQueue.push({ userId, userName: session.userName, timestamp: new Date().toISOString(), department: session.context.department || 'Geral' });
            saveData('requestQueue.json', requestQueue);
        }
    }
}

// --- WHATSAPP CORE ---
async function startWhatsApp() {
    gatewayStatus.status = 'LOADING';
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'baileys_auth_info'));
        const { version } = await fetchLatestBaileysVersion();
        sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: true, browser: ['JZF Chat', 'Chrome', '1.0.0'] });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (u) => {
            if (u.qr) { gatewayStatus.qrCode = await QRCode.toDataURL(u.qr); gatewayStatus.status = 'QR_CODE_READY'; }
            if (u.connection === 'open') { gatewayStatus.status = 'CONNECTED'; gatewayStatus.qrCode = null; }
            if (u.connection === 'close') setTimeout(startWhatsApp, 5000);
        });
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                const cleanId = msg.key.remoteJid.replace(/:.*$/, '');
                const name = resolveBestName(cleanId, msg.pushName);
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                await processIncomingMessage({ userId: cleanId, userName: name, userInput: text });
            }
        });
    } catch (e) { setTimeout(startWhatsApp, 5000); }
}

async function processIncomingMessage({ userId, userName, userInput }) {
    const session = getSession(userId, userName);
    session.messageLog.push({ sender: 'user', text: userInput, timestamp: new Date().toISOString() });
    if (session.handledBy === 'bot') await handleBotResponse(userId, userInput, session);
    saveData(activeChats.has(userId) ? 'activeChats.json' : 'userSessions.json', activeChats.has(userId) ? activeChats : userSessions);
}

function queueOutbound(userId, content) { outboundGatewayQueue.push({ userId, ...content }); }

async function processOutboundQueue() {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            await sock.sendMessage(jid, { text: item.text });
        } catch (e) { outboundGatewayQueue.push(item); }
    }
    setTimeout(processOutboundQueue, 1500);
}

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) {
        session = { userId, userName: userName || userId.split('@')[0], currentState: ChatState.GREETING, context: { history: {} }, aiHistory: [], messageLog: [], handledBy: 'bot', createdAt: new Date().toISOString() };
        userSessions.set(userId, session);
        setTimeout(() => sendCurrentStateMenu(userId, session), 1000);
    }
    return session;
}

// --- EXPRESS SETUP ---
app.use(express.json({ limit: '50mb' }));
app.use('/media', express.static(MEDIA_DIR));

// ROTAS UNIFICADAS (Garante que /attendants e /api/attendants funcionem)
const unifiedRoutes = (path, handler) => {
    app.get(path, handler);
    app.get(`/api${path}`, handler);
};

unifiedRoutes('/attendants', (req, res) => res.json(ATTENDANTS));
unifiedRoutes('/requests', (req, res) => res.json(requestQueue));
unifiedRoutes('/ai-active', (req, res) => res.json(Array.from(userSessions.values()).filter(s => s.handledBy === 'bot')));
unifiedRoutes('/history', (req, res) => {
    const { userId } = req.query;
    const chat = activeChats.get(userId) || userSessions.get(userId);
    res.json(chat || { userId, messageLog: [] });
});

app.get('/api/gateway/status', (req, res) => res.json(gatewayStatus));
app.post('/api/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    let session = getSession(userId);
    session.handledBy = 'human';
    activeChats.set(userId, session);
    userSessions.delete(userId);
    requestQueue = requestQueue.filter(r => r.userId !== userId);
    saveData('activeChats.json', activeChats);
    saveData('requestQueue.json', requestQueue);
    queueOutbound(userId, { text: "Olá! Sou um atendente humano. Como posso ajudar?" });
    res.json(session);
});

app.post('/api/chats/attendant-reply', (req, res) => {
    const { userId, text } = req.body;
    const chat = activeChats.get(userId);
    if (chat) {
        chat.messageLog.push({ sender: 'attendant', text, timestamp: new Date().toISOString() });
        saveData('activeChats.json', activeChats);
        queueOutbound(userId, { text });
        res.json({ success: true });
    } else res.status(404).send();
});

// Arquivos estáticos por ÚLTIMO para não interceptar as APIs
app.use(express.static(path.join(__dirname, 'dist')));

startWhatsApp();
processOutboundQueue();
app.listen(port, () => console.log(`Online na porta ${port}`));
