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
      console.warn(`[WARNING - DECRYPTION] Erro de descriptografia (Bad MAC). Geralmente resolvido automaticamente pelo Baileys na próxima mensagem.`);
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

const SERVER_VERSION = "30.3.0_MAC_AND_LOGIC_FIX";
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

// --- SISTEMA DE LIMPEZA AGRESSIVO (GARBAGE COLLECTOR) ---
const MAX_MESSAGE_HISTORY = 30; 

function pruneSession(session) {
    if (session && session.messageLog && session.messageLog.length > MAX_MESSAGE_HISTORY) {
        session.messageLog = session.messageLog.slice(-MAX_MESSAGE_HISTORY);
    }
    return session;
}

function cleanupStorage() {
    console.log('[GC] Limpeza iniciada...');
    try {
        const files = fs.readdirSync(MEDIA_DIR);
        const now = Date.now();
        const expiration = 24 * 60 * 60 * 1000; 
        let deletedFiles = 0;

        files.forEach(file => {
            const filePath = path.join(MEDIA_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > expiration) {
                    fs.unlinkSync(filePath);
                    deletedFiles++;
                }
            } catch(e) {}
        });
        
        const sessionExpiration = 12 * 60 * 60 * 1000;
        for (const [userId, session] of userSessions.entries()) {
            const lastInteraction = session.messageLog?.length > 0 
                ? new Date(session.messageLog[session.messageLog.length-1].timestamp).getTime()
                : new Date(session.createdAt).getTime();
            
            if (now - lastInteraction > sessionExpiration) {
                userSessions.delete(userId);
            }
        }
    } catch (e) {}
}

cleanupStorage();
setInterval(cleanupStorage, 2 * 60 * 60 * 1000);

// persistence helpers
const serializeMap = (map) => Array.from(map.entries()).map(([k, s]) => [k, pruneSession(s)]);
const deserializeMap = (arr) => new Map(arr);

const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    const jsonString = JSON.stringify(dataToSave, null, 2);
    const tempPath = filePath + '.tmp';
    fs.writeFileSync(tempPath, jsonString, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {}
};

const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (defaultValue instanceof Map && Array.isArray(parsed)) return deserializeMap(parsed);
    return parsed;
  } catch (e) { return defaultValue; }
};

const saveMediaToDisk = (base64Data, mimeType, originalName) => {
    try {
        if (!base64Data) return null;
        let ext = path.extname(originalName || '').substring(1);
        if (!ext) {
            const extMap = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'video/mp4': 'mp4' };
            ext = extMap[mimeType] || 'bin';
        }
        const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const filePath = path.join(MEDIA_DIR, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/media/${fileName}`; 
    } catch (e) { return null; }
};

// --- WHATSAPP STORE ---
const makeCustomStore = () => {
    let contacts = {};
    const STORE_FILE = path.join(DATA_DIR, 'baileys_store.json');
    const load = () => { try { contacts = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')).contacts || {}; } catch(e) {} };
    const save = () => { try { saveData('baileys_store.json', { contacts }); } catch(e) {} };
    const upsert = (id, data) => {
        if (!id || id.includes('@g.us')) return;
        contacts[id] = { ...(contacts[id] || {}), ...data };
    };
    load();
    setInterval(save, 60000);
    return { getContacts: () => contacts, upsert, bind: (ev) => {
        ev.on('contacts.upsert', (c) => c.forEach(i => upsert(i.id, i)));
        ev.on('contacts.update', (u) => u.forEach(i => upsert(i.id, i)));
    }};
};
const store = makeCustomStore();

function resolveBestName(userId, pushName = null) {
    const contact = store.getContacts()[userId];
    return contact?.name || contact?.notify || pushName || userId.split('@')[0];
}

// --- ESTADO ---
let ATTENDANTS = loadData('attendants.json', [{ id: 'attendant_1', name: 'Admin' }]);
const userSessions = loadData('userSessions.json', new Map());
const activeChats = loadData('activeChats.json', new Map());
let requestQueue = loadData('requestQueue.json', []);
let contactTags = loadData('contactTags.json', {}); 
const outboundGatewayQueue = []; 
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 

// --- IA ---
const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

// --- BOT LOGIC ENGINE ---

async function handleBotResponse(userId, userInput, session) {
    const config = conversationFlow.get(session.currentState);
    if (!config) return;

    // Se a sessão estiver em atendimento humano, não faz nada
    if (session.handledBy === 'human') return;

    // 1. Processar opções numéricas se houver
    if (config.options) {
        const optionIndex = parseInt(userInput.trim()) - 1;
        if (!isNaN(optionIndex) && config.options[optionIndex]) {
            const selected = config.options[optionIndex];
            session.currentState = selected.nextState;
            if (selected.payload) session.context = { ...session.context, ...selected.payload };
            return sendCurrentStateMenu(userId, session);
        }
    }

    // 2. Processar entrada de texto livre (IA ou Agendamento)
    if (config.requiresTextInput) {
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            return handleAiChat(userId, userInput, session);
        } else {
            // Salva no histórico e avança
            session.context.history[session.currentState] = userInput;
            if (config.nextState) {
                session.currentState = config.nextState;
                return sendCurrentStateMenu(userId, session);
            }
        }
    }

    // Se o bot não entendeu e não é IA, reenviar o menu atual
    if (session.currentState !== ChatState.AI_ASSISTANT_CHATTING) {
        return sendCurrentStateMenu(userId, session);
    }
}

async function handleAiChat(userId, userInput, session) {
    if (!ai) return queueOutbound(userId, { text: "IA não configurada no servidor." });
    
    try {
        const dept = session.context.department || "Contábil";
        const instruction = departmentSystemInstructions.pt[dept] || departmentSystemInstructions.pt["Contábil"];
        
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [{ parts: [{ text: `Histórico: ${JSON.stringify(session.aiHistory.slice(-5))}\n\nUsuário: ${userInput}` }] }],
            config: { systemInstruction: instruction }
        });

        const reply = response.text;
        session.aiHistory.push({ role: 'user', parts: [{ text: userInput }] });
        session.aiHistory.push({ role: 'model', parts: [{ text: reply }] });
        
        // Mantém histórico curto
        if (session.aiHistory.length > 10) session.aiHistory = session.aiHistory.slice(-10);

        queueOutbound(userId, { text: reply });
        
        // Re-enviar opções do estado de IA para navegação
        const config = conversationFlow.get(ChatState.AI_ASSISTANT_CHATTING);
        let menuText = "\n\n";
        config.options.forEach((opt, idx) => {
            menuText += `${idx + 1}. ${translations.pt[opt.textKey] || opt.textKey}\n`;
        });
        queueOutbound(userId, { text: menuText });

    } catch (e) {
        queueOutbound(userId, { text: "Desculpe, tive um problema ao processar sua pergunta. Pode repetir?" });
    }
}

function sendCurrentStateMenu(userId, session) {
    const config = conversationFlow.get(session.currentState);
    if (!config) return;

    let text = typeof config.textKey === 'function' ? config.textKey(session) : (translations.pt[config.textKey] || config.textKey);
    
    if (config.options) {
        text += "\n\nEscolha uma opção:\n";
        config.options.forEach((opt, idx) => {
            text += `*${idx + 1}* - ${translations.pt[opt.textKey] || opt.textKey}\n`;
        });
    }

    queueOutbound(userId, { text });

    // Se for ponto de transferência, adicionar à fila
    if (session.currentState === ChatState.ATTENDANT_TRANSFER || session.currentState === ChatState.SCHEDULING_CONFIRMED) {
        const already = requestQueue.find(r => r.userId === userId);
        if (!already) {
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
        
        sock = makeWASocket({
            version, auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ['JZF Chat', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            markOnlineOnConnect: true
        });

        store.bind(sock.ev);
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { gatewayStatus.qrCode = await QRCode.toDataURL(qr); gatewayStatus.status = 'QR_CODE_READY'; }
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason !== DisconnectReason.loggedOut) setTimeout(startWhatsApp, 5000);
            } else if (connection === 'open') {
                gatewayStatus.status = 'CONNECTED';
                gatewayStatus.qrCode = null;
                console.log('[WhatsApp] Online!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                // Prevenção contra Bad MAC: Se a mensagem vier sem conteúdo (ciphertext error), ignoramos
                if (!msg.message) continue;
                
                const rawId = msg.key.remoteJid;
                if (!rawId || rawId.includes('@g.us')) continue;
                const cleanId = rawId.replace(/:.*$/, '');

                if (!msg.key.fromMe) {
                    const name = resolveBestName(cleanId, msg.pushName);
                    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const messageType = Object.keys(msg.message)[0];
                    
                    let file = null;
                    if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            file = { name: msg.message[messageType].fileName || `${messageType}`, type: msg.message[messageType].mimetype, data: buffer.toString('base64') };
                            text = msg.message[messageType].caption || text;
                        } catch (e) {}
                    }
                    await processIncomingMessage({ userId: cleanId, userName: name, userInput: text, file, msgId: msg.key.id });
                }
            }
        });
    } catch (e) { setTimeout(startWhatsApp, 5000); }
}

async function processIncomingMessage({ userId, userName, userInput, file, msgId }) {
    const session = getSession(userId, userName);
    const logEntry = { sender: 'user', text: userInput, timestamp: new Date().toISOString(), msgId };
    if (file) {
        const url = saveMediaToDisk(file.data, file.type, file.name);
        if (url) logEntry.files = [{ name: file.name, type: file.type, url }];
    }
    session.messageLog.push(logEntry);
    pruneSession(session);

    // DISPARAR LÓGICA DO BOT
    if (session.handledBy === 'bot') {
        await handleBotResponse(userId, userInput, session);
    }

    if (activeChats.has(userId)) saveData('activeChats.json', activeChats);
    else saveData('userSessions.json', userSessions);
}

function queueOutbound(userId, content) {
    outboundGatewayQueue.push({ userId, ...content });
}

async function processOutboundQueue() {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            if (item.files?.length > 0) {
                for (const file of item.files) {
                    const filePath = path.join(MEDIA_DIR, path.basename(file.url));
                    if (!fs.existsSync(filePath)) continue;
                    const buffer = fs.readFileSync(filePath);
                    let messageContent = {};
                    if (file.type.startsWith('image/')) messageContent = { image: buffer, caption: item.text };
                    else if (file.type.startsWith('video/')) messageContent = { video: buffer, caption: item.text, mimetype: file.type };
                    else if (file.type.startsWith('audio/')) messageContent = { audio: buffer, mimetype: file.type, ptt: true };
                    else messageContent = { document: buffer, mimetype: file.type, fileName: file.name, caption: item.text };
                    await sock.sendMessage(jid, messageContent);
                }
            } else {
                await sock.sendMessage(jid, { text: item.text });
            }
        } catch (e) {
            if (!item.retry || item.retry < 3) { item.retry = (item.retry || 0) + 1; outboundGatewayQueue.push(item); }
        }
    }
    setTimeout(processOutboundQueue, 1500);
}

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) {
        session = { userId, userName: userName || userId.split('@')[0], currentState: ChatState.GREETING, context: { history: {} }, aiHistory: [], messageLog: [], handledBy: 'bot', attendantId: null, createdAt: new Date().toISOString() };
        userSessions.set(userId, session);
        // Enviar menu inicial imediatamente para novos usuários
        setTimeout(() => sendCurrentStateMenu(userId, session), 1000);
    }
    return session;
}

// --- EXPRESS API ---

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));
app.use('/media', express.static(MEDIA_DIR));

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/history', (req, res) => {
    const { userId } = req.query;
    const chat = activeChats.get(userId) || userSessions.get(userId);
    res.json(chat || { userId, messageLog: [] });
});
app.get('/requests', (req, res) => res.json(requestQueue));
app.get('/ai-active', (req, res) => res.json(Array.from(userSessions.values()).filter(s => s.handledBy === 'bot')));
app.get('/attendants', (req, res) => res.json(ATTENDANTS));
app.get('/api/gateway/status', (req, res) => res.json(gatewayStatus));

app.post('/api/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    let session = getSession(userId);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    activeChats.set(userId, session);
    userSessions.delete(userId);
    requestQueue = requestQueue.filter(r => r.userId !== userId);
    saveData('activeChats.json', activeChats);
    saveData('requestQueue.json', requestQueue);
    queueOutbound(userId, { text: "Olá! Sou um atendente humano e assumirei seu atendimento agora. Como posso ajudar?" });
    res.json(session);
});

app.post('/api/chats/attendant-reply', (req, res) => {
    const { userId, text, files } = req.body;
    const chat = activeChats.get(userId);
    if (chat) {
        const msg = { sender: 'attendant', text, timestamp: new Date().toISOString() };
        if (files?.length > 0) msg.files = files.map(f => ({ name: f.name, type: f.type, url: saveMediaToDisk(f.data, f.type, f.name) }));
        chat.messageLog.push(msg);
        saveData('activeChats.json', activeChats);
        queueOutbound(userId, { text, files: msg.files });
        res.json({ success: true });
    } else res.status(404).send();
});

app.post('/api/chats/resolve/:userId', (req, res) => {
    activeChats.delete(req.params.userId);
    saveData('activeChats.json', activeChats);
    res.json({ success: true });
});

startWhatsApp();
processOutboundQueue();
app.listen(port, () => console.log(`Rodando na porta ${port}`));
