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
  if (err.message && err.message.includes('Bad MAC')) {
      console.warn(`[WARNING - Bad MAC] Erro de descriptografia detectado. Ignorando crash.`);
      return;
  }
  console.error(`[FATAL - RECOVERED] Exceção não capturada: ${err.message}`, { stack: err.stack, origin });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL - RECOVERED] Rejeição de Promise não tratada:', reason);
});

const SERVER_VERSION = "29.8.0_NAME_SYNC_FIX";
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

// Helper functions
const serializeMap = (map) => Array.from(map.entries());
const deserializeMap = (arr) => new Map(arr);

const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (error) {
    console.error(`[Persistence] ERRO ao salvar ${filename}:`, error);
  }
};

const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content) return defaultValue;
    const parsedData = JSON.parse(content);
    if (defaultValue instanceof Map && Array.isArray(parsedData)) return deserializeMap(parsedData);
    return parsedData;
  } catch (error) {
    return defaultValue;
  }
};

// --- DISK STORAGE UTILS ---
const saveMediaToDisk = (base64Data, mimeType, originalName) => {
    try {
        if (!base64Data) return null;
        let ext = null;
        if (originalName && originalName.includes('.')) {
            ext = path.extname(originalName).substring(1);
        }
        if (!ext) {
            const extMap = {
                'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
                'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a'
            };
            ext = extMap[mimeType] || mimeType.split('/')[1] || 'bin';
        }
        const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const filePath = path.join(MEDIA_DIR, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/media/${fileName}`; 
    } catch (error) {
        console.error('[Media] Erro ao salvar arquivo:', error);
        return null;
    }
};

// --- CUSTOM STORE ---
const makeCustomStore = () => {
    let contacts = {};
    const STORE_FILE = path.join(DATA_DIR, 'baileys_store.json');
    const load = () => {
        try { if (fs.existsSync(STORE_FILE)) contacts = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')).contacts || {}; } catch(e) {}
    };
    const save = () => {
        try { fs.writeFileSync(STORE_FILE, JSON.stringify({ contacts })); } catch(e) {}
    };
    const upsert = (id, data) => {
        if (!id || id.includes('@g.us') || id === 'status@broadcast') return;
        const existing = contacts[id] || {};
        
        // Proteção: não sobrescrever nome existente por nulo
        const newName = data.name || data.notify || data.verifiedName;
        contacts[id] = { 
            ...existing, 
            ...data, 
            name: newName || existing.name,
            notify: data.notify || existing.notify || existing.name
        };
    };
    load();
    setInterval(save, 15000);
    return {
        getContacts: () => contacts,
        upsert, save,
        bind: (ev) => {
            ev.on('messaging-history.set', ({ contacts: newContacts }) => newContacts?.forEach(c => upsert(c.id, c)));
            ev.on('contacts.upsert', (newContacts) => newContacts.forEach(c => upsert(c.id, c)));
            ev.on('contacts.update', (updates) => updates.forEach(u => upsert(u.id, u)));
        }
    };
};
const store = makeCustomStore();

// HELPER PARA RESOLVER O MELHOR NOME POSSÍVEL
function resolveBestName(userId, pushName = null) {
    const contact = store.getContacts()[userId];
    const numberFallback = userId.split('@')[0];
    
    if (contact) {
        // Prioridade: Nome da Agenda > PushName/Notify > Nome Verificado > PushName Atual > Número
        return contact.name || contact.notify || contact.verifiedName || pushName || numberFallback;
    }
    return pushName || numberFallback;
}

// --- ESTADO ---
let ATTENDANTS = loadData('attendants.json', [{ id: 'attendant_1', name: 'Admin' }]);
const userSessions = loadData('userSessions.json', new Map());
let requestQueue = loadData('requestQueue.json', []);
const activeChats = loadData('activeChats.json', new Map());
const archivedChats = loadData('archivedChats.json', new Map());
let contactTags = loadData('contactTags.json', {}); 

const outboundGatewayQueue = []; 
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'dist')));
app.use('/media', express.static(MEDIA_DIR));

// --- IA ---
let ai = null;
if (API_KEY) ai = new GoogleGenAI({apiKey: API_KEY});

// --- WHATSAPP (BAILEYS) ---
const SESSION_FOLDER = path.join(DATA_DIR, 'baileys_auth_info');

async function startWhatsApp() {
    gatewayStatus.status = 'LOADING';
    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version, auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ['JZF Chat', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            markOnlineOnConnect: true,
            getMessage: async () => ({ conversation: 'hi' })
        });

        store.bind(sock.ev);
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { gatewayStatus.qrCode = await QRCode.toDataURL(qr); gatewayStatus.status = 'QR_CODE_READY'; }
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                gatewayStatus.status = 'DISCONNECTED';
                if (shouldReconnect) setTimeout(startWhatsApp, 5000);
            } else if (connection === 'open') {
                gatewayStatus.status = 'CONNECTED';
                gatewayStatus.qrCode = null;
                console.log('[WhatsApp] Conectado!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                const rawUserId = msg.key.remoteJid;
                if (!rawUserId || rawUserId === 'status@broadcast' || rawUserId.includes('@g.us')) continue;
                const cleanUserId = rawUserId.replace(/:.*$/, '');

                if (!msg.key.fromMe && msg.message) {
                    // RESOLVER NOME REAL
                    const userName = resolveBestName(cleanUserId, msg.pushName);
                    
                    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    const messageType = Object.keys(msg.message)[0];
                    
                    let file = null;
                    if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            const msgContent = msg.message[messageType];
                            file = {
                                name: msgContent.fileName || `${messageType}_${Date.now()}`,
                                type: msgContent.mimetype,
                                data: buffer.toString('base64')
                            };
                            text = msgContent.caption || '';
                        } catch (e) {}
                    }
                    await processIncomingMessage({ userId: cleanUserId, userName, userInput: text, file, msgId: msg.key.id });
                }
            }
        });
    } catch (e) { setTimeout(startWhatsApp, 5000); }
}

async function processOutboundQueue() {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            let options = {};
            if (item.replyTo?.id) {
                options.quoted = { key: { remoteJid: jid, fromMe: item.replyTo.fromMe, id: item.replyTo.id }, message: { conversation: item.replyTo.text } };
            }

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

                    await sock.sendMessage(jid, messageContent, options);
                }
            } else {
                await sock.sendMessage(jid, { text: item.text }, options);
            }
        } catch (e) {
            console.error('[Outbound] Erro:', e.message);
            if (!item.retry) item.retry = 0;
            if (item.retry < 3) { item.retry++; outboundGatewayQueue.push(item); }
        }
    }
    setTimeout(processOutboundQueue, 1000);
}

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    const resolvedName = resolveBestName(userId, userName);
    
    if (!session) {
        session = { 
            userId, 
            userName: resolvedName, 
            currentState: ChatState.GREETING, 
            context: { history: {} }, 
            aiHistory: [], 
            messageLog: [], 
            handledBy: 'bot', 
            attendantId: null, 
            createdAt: new Date().toISOString() 
        };
        userSessions.set(userId, session);
    } else if (userName && session.userName !== resolvedName) {
        // Atualiza nome se o resolvido agora for melhor que o antigo
        session.userName = resolvedName;
    }
    return session;
}

async function processIncomingMessage({ userId, userName, userInput, file, msgId }) {
    const session = getSession(userId, userName);
    const logEntry = { sender: 'user', text: userInput, timestamp: new Date().toISOString(), msgId };
    if (file) {
        const url = saveMediaToDisk(file.data, file.type, file.name);
        if (url) logEntry.files = [{ name: file.name, type: file.type, url }];
    }
    session.messageLog.push(logEntry);
    
    if (activeChats.has(userId)) {
        saveData('activeChats.json', activeChats);
    } else {
        saveData('userSessions.json', userSessions);
    }
}

function queueOutbound(userId, content) {
    outboundGatewayQueue.push({ userId, ...content });
}

// --- API ---
app.get('/api/gateway/status', (req, res) => res.json(gatewayStatus));

app.get('/api/clients', (req, res) => {
    const clientsMap = new Map();
    
    // 1. Contatos do Store (Prioritário)
    const storeContacts = store.getContacts();
    Object.keys(storeContacts).forEach(uid => {
        const name = resolveBestName(uid);
        clientsMap.set(uid, { userId: uid, userName: name, tags: contactTags[uid] || [] });
    });

    // 2. Mesclar com Chats Ativos (Caso o store esteja falhando)
    activeChats.forEach(c => {
        if (!clientsMap.has(c.userId)) {
            clientsMap.set(c.userId, { userId: c.userId, userName: c.userName, tags: contactTags[c.userId] || [] });
        }
    });

    res.json(Array.from(clientsMap.values()));
});

app.get('/api/chats/active', (req, res) => {
    const summary = Array.from(activeChats.values()).map(c => ({
        userId: c.userId, 
        userName: resolveBestName(c.userId, c.userName), 
        attendantId: c.attendantId, 
        logLength: c.messageLog.length,
        lastMessage: c.messageLog[c.messageLog.length - 1]
    }));
    res.json(summary);
});

app.get('/api/chats/history/:userId', (req, res) => {
    const userId = req.params.userId;
    const chat = activeChats.get(userId) || userSessions.get(userId);
    if (chat) chat.userName = resolveBestName(userId, chat.userName);
    res.json(chat || { userId, messageLog: [] });
});

app.post('/api/chats/attendant-reply', (req, res) => {
    const { userId, text, files, replyTo } = req.body;
    const chat = activeChats.get(userId);
    if (chat) {
        const msg = { sender: 'attendant', text, timestamp: new Date().toISOString(), status: 1 };
        if (files?.length > 0) {
            msg.files = files.map(f => ({ name: f.name, type: f.type, url: saveMediaToDisk(f.data, f.type, f.name) })).filter(f => f.url);
        }
        chat.messageLog.push(msg);
        saveData('activeChats.json', activeChats);
        queueOutbound(userId, { text, files: msg.files, replyTo });
        res.json({ success: true });
    } else res.status(404).send();
});

app.post('/api/chats/initiate', (req, res) => {
    const { recipientNumber, clientName, message, attendantId, files } = req.body;
    const cleanNumber = recipientNumber.replace(/\D/g, '');
    const userId = cleanNumber + '@s.whatsapp.net';
    
    // Tenta resolver nome real se já existir no store
    const realName = resolveBestName(userId, clientName);
    
    let session = getSession(userId, realName);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    const msg = { sender: 'attendant', text: message, timestamp: new Date().toISOString(), status: 1 };
    if (files?.length > 0) {
        msg.files = files.map(f => ({ name: f.name, type: f.type, url: saveMediaToDisk(f.data, f.type, f.name) })).filter(f => f.url);
    }
    session.messageLog.push(msg);
    activeChats.set(userId, session);
    saveData('activeChats.json', activeChats);
    queueOutbound(userId, { text: message, files: msg.files });
    res.json(session);
});

app.post('/api/chats/read/:userId', async (req, res) => {
    if (!sock) return res.status(503).send();
    const chat = activeChats.get(req.params.userId);
    const lastMsg = chat?.messageLog.reverse().find(m => m.sender === 'user' && m.msgId);
    if (lastMsg) {
        await sock.readMessages([{ remoteJid: req.params.userId + '@s.whatsapp.net', id: lastMsg.msgId, fromMe: false }]);
    }
    res.json({ success: true });
});

app.post('/api/chats/resolve/:userId', (req, res) => {
    activeChats.delete(req.params.userId);
    saveData('activeChats.json', activeChats);
    res.json({ success: true });
});

app.post('/api/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    let session = userSessions.get(userId) || getSession(userId);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.userName = resolveBestName(userId, session.userName);
    activeChats.set(userId, session);
    userSessions.delete(userId);
    saveData('activeChats.json', activeChats);
    res.json(session);
});

startWhatsApp();
processOutboundQueue();
app.listen(port, () => console.log(`Rodando na porta ${port}`));
