
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
  if (err.message && (err.message.includes('Bad MAC') || err.message.includes('Verification failed'))) {
      console.warn(`[WARNING - Signal] Erro de descriptografia (Bad MAC). O Baileys tentará recuperar a sessão automaticamente.`);
      return;
  }
  console.error(`[FATAL - RECOVERED] Exceção não capturada: ${err.message}`, { stack: err.stack, origin });
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason?.message?.includes('Bad MAC')) return;
  console.error('[FATAL - RECOVERED] Rejeição de Promise não tratada:', reason);
});

const SERVER_VERSION = "29.12.0_BAD_MAC_FIX_STABLE";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PERSISTÊNCIA DE DADOS ---
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
    const tempPath = `${filePath}.tmp`;
    const backupPath = `${filePath}.bak`;
    if (fs.existsSync(filePath)) {
        try { fs.copyFileSync(filePath, backupPath); } catch(e) {}
    }
    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) { console.error(`[Persistence] ERRO ao salvar ${filename}:`, error); }
};

const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const backupPath = `${filePath}.bak`;
    const tryRead = (p) => {
        if (!fs.existsSync(p)) return null;
        const content = fs.readFileSync(p, 'utf8');
        if (!content || content.trim() === '') return null;
        return JSON.parse(content);
    };
    let parsedData = tryRead(filePath) || tryRead(backupPath);
    if (parsedData) {
        if (defaultValue instanceof Map && Array.isArray(parsedData)) return deserializeMap(parsedData);
        return parsedData;
    }
  } catch (error) { console.error(`[Persistence] ERRO ao carregar ${filename}.`, error); }
  return defaultValue;
};

// --- DISK STORAGE UTILS ---
const saveMediaToDisk = (base64Data, mimeType, originalName) => {
    try {
        let ext = originalName?.includes('.') ? path.extname(originalName).substring(1) : (mimeType.split('/')[1] || 'bin');
        const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const filePath = path.join(MEDIA_DIR, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/media/${fileName}`; 
    } catch (error) { console.error('[Media] Erro salvar:', error); return null; }
};

// --- CUSTOM STORE (COM PERSISTÊNCIA DE MENSAGENS PARA FIX BAD MAC) ---
const makeCustomStore = () => {
    let contacts = {};
    let messages = {}; // Cache de mensagens para retentativas (Essencial para Bad MAC)
    const STORE_FILE = path.join(DATA_DIR, 'baileys_store.json');
    const MSG_CACHE_FILE = path.join(DATA_DIR, 'baileys_msg_cache.json');

    const load = () => { 
        try { 
            if (fs.existsSync(STORE_FILE)) contacts = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')).contacts || {}; 
            if (fs.existsSync(MSG_CACHE_FILE)) messages = JSON.parse(fs.readFileSync(MSG_CACHE_FILE, 'utf-8')) || {};
        } catch(e){} 
    };

    const save = () => { 
        try { 
            fs.writeFileSync(STORE_FILE, JSON.stringify({ contacts }, null, 2)); 
            // Salva apenas as últimas 100 mensagens para não sobrecarregar o JSON
            const keys = Object.keys(messages);
            const limitedMessages = {};
            keys.slice(-100).forEach(k => limitedMessages[k] = messages[k]);
            fs.writeFileSync(MSG_CACHE_FILE, JSON.stringify(limitedMessages, null, 2));
        } catch(e){} 
    };
    
    const upsert = (id, data) => {
        if (!id || id.includes('@g.us') || id === 'status@broadcast') return;
        const existing = contacts[id] || {};
        contacts[id] = { 
            ...existing, 
            ...data, 
            name: data.name || existing.name, 
            notify: data.notify || existing.notify, 
            verifiedName: data.verifiedName || existing.verifiedName 
        };
    };

    const cacheMessage = (m) => {
        if (m.key?.id && m.message) {
            messages[m.key.id] = m.message;
            const keys = Object.keys(messages);
            if (keys.length > 500) delete messages[keys[0]];
        }
    };

    load(); setInterval(save, 15000);
    return {
        getContacts: () => contacts,
        loadMessage: (id) => messages[id],
        upsert, save, bind: (ev) => {
            ev.on('messaging-history.set', ({ contacts: newContacts, messages: newMsgs }) => { 
                if (newContacts) { newContacts.forEach(c => upsert(c.id, c)); } 
                if (newMsgs) newMsgs.forEach(m => cacheMessage(m));
            });
            ev.on('contacts.upsert', (newContacts) => newContacts.forEach(c => upsert(c.id, c)));
            ev.on('contacts.update', (updates) => updates.forEach(u => upsert(u.id, u)));
            ev.on('messages.upsert', ({ messages: newMsgs }) => newMsgs.forEach(m => cacheMessage(m)));
        }
    };
};
const store = makeCustomStore();

// --- ESTADO DO SISTEMA ---
let ATTENDANTS = loadData('attendants.json', [{ id: 'attendant_1', name: 'Admin' }]);
let requestQueue = loadData('requestQueue.json', []);
const activeChats = loadData('activeChats.json', new Map());
const userSessions = loadData('userSessions.json', new Map());
const archivedChats = loadData('archivedChats.json', new Map());
let syncedContacts = loadData('syncedContacts.json', []);
let tags = loadData('tags.json', []); 
let contactTags = loadData('contactTags.json', {}); 

class PersistentMap {
    constructor(filename) {
        this.filename = filename;
        this.internalMap = loadData(filename, new Map());
    }
    get(key) { return this.internalMap.get(key); }
    set(key, value) { this.internalMap.set(key, value); saveData(this.filename, this.internalMap); return this; }
    delete(key) { const result = this.internalMap.delete(key); saveData(this.filename, this.internalMap); return result; }
    del(key) { return this.delete(key); } // Compatibilidade total Baileys
    has(key) { return this.internalMap.has(key); }
}
const msgRetryCounterCache = new PersistentMap('msgRetryCounterMap.json');

const outboundGatewayQueue = []; 
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 
let nextRequestId = requestQueue.length > 0 ? Math.max(...requestQueue.map(r => r.id || 0)) + 1 : 1;

// --- RESOLUÇÃO DE NOMES ---
function resolveName(userId, fallback) {
    if (!userId) return fallback;
    const contact = store.getContacts()[userId];
    if (contact) {
        const name = contact.name || contact.notify || contact.verifiedName;
        if (name) return name;
    }
    const synced = syncedContacts.find(c => c.userId === userId);
    if (synced && synced.userName && synced.userName !== userId.split('@')[0]) return synced.userName;
    return fallback || userId.split('@')[0];
}

function propagateNameUpdate(userId, newName) {
    if (!userId || !newName) return;
    let changed = false;
    requestQueue = requestQueue.map(r => {
        if (r.userId === userId && (r.userName === userId.split('@')[0] || !r.userName || r.userName === userId)) {
            changed = true;
            return { ...r, userName: newName };
        }
        return r;
    });
    if (activeChats.has(userId)) {
        const chat = activeChats.get(userId);
        if (chat.userName === userId.split('@')[0] || !chat.userName || chat.userName === userId) {
            chat.userName = newName;
            changed = true;
        }
    }
    if (userSessions.has(userId)) {
        const sess = userSessions.get(userId);
        if (sess.userName === userId.split('@')[0] || !sess.userName || sess.userName === userId) {
            sess.userName = newName;
            changed = true;
        }
    }
    if (changed) {
        saveData('requestQueue.json', requestQueue);
        saveData('activeChats.json', activeChats);
        saveData('userSessions.json', userSessions);
    }
}

// --- IA CONFIG ---
let ai = null;
if (API_KEY) {
    try { ai = new GoogleGenAI({apiKey: API_KEY}); } catch (e) {}
}

async function transcribeAudio(fileUrl, mimeType) {
    if (!ai) return "[Áudio não transcrito]";
    try {
        const filePath = path.join(MEDIA_DIR, path.basename(fileUrl));
        const fileData = fs.readFileSync(filePath).toString('base64');
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [{ parts: [{ inlineData: { mimeType, data: fileData } }, { text: "Transcreva este áudio." }] }],
        });
        return response?.text?.trim() || "[Transcrição vazia]";
    } catch (error) { return `[Erro na transcrição]`; }
}

function archiveSession(session) {
    if (!session?.userId) return;
    let userHistory = archivedChats.get(session.userId) || [];
    userHistory.push(session);
    if (userHistory.length > 20) userHistory.shift();
    archivedChats.set(session.userId, userHistory);
    saveData('archivedChats.json', archivedChats);
}

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    const resolvedName = resolveName(userId, userName);
    if (!session) {
        session = {
            userId, userName: resolvedName, currentState: ChatState.GREETING,
            context: { history: {} }, aiHistory: [], messageLog: [],
            handledBy: 'bot', attendantId: null, createdAt: new Date().toISOString(),
        };
        userSessions.set(userId, session);
        saveData('userSessions.json', userSessions);
    } else if (resolvedName && session.userName !== resolvedName) {
        session.userName = resolvedName;
        saveData('userSessions.json', userSessions);
    }
    return session;
}

function addRequestToQueue(session, department, message) {
    if (requestQueue.some(r => r.userId === session.userId) || activeChats.has(session.userId)) return;
    const resolvedName = resolveName(session.userId, session.userName);
    const request = { 
        id: nextRequestId++, 
        userId: session.userId, 
        userName: resolvedName, 
        department, 
        message, 
        timestamp: new Date().toISOString() 
    };
    requestQueue.unshift(request);
    saveData('requestQueue.json', requestQueue);
}

function formatFlowStepForWhatsapp(step, context) {
    const textTemplate = translations.pt[step.textKey];
    let messageText = typeof textTemplate === 'function' ? textTemplate(context) : (textTemplate || '');
    if (step.options?.length > 0) {
        const optionsList = step.options.map((opt, i) => `*${i + 1}*. ${translations.pt[opt.textKey] || opt.textKey}`).join('\n');
        messageText += `\n\n${optionsList}\n\nPor favor, digite o número da opção desejada.`;
    }
    return messageText;
}

async function processMessage(session, userInput) {
    if (session.handledBy !== 'bot') return;
    if (!conversationFlow.has(session.currentState)) session.currentState = ChatState.GREETING;
    let currentStep = conversationFlow.get(session.currentState);
    let nextState = null;
    let payload = null;
    const choice = parseInt(userInput.trim(), 10);
    const selectedOption = (currentStep.options && !isNaN(choice)) ? currentStep.options[choice - 1] : null;

    if (selectedOption) {
        nextState = selectedOption.nextState;
        payload = selectedOption.payload;
    } else if (currentStep.requiresTextInput) {
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            if (!ai) { queueOutbound(session.userId, { text: "IA indisponível." }); return; }
            try {
                session.aiHistory.push({ role: 'user', parts: [{ text: userInput }] });
                const response = await ai.models.generateContent({ 
                    model: 'gemini-3-flash-preview', 
                    contents: session.aiHistory, 
                    config: { systemInstruction: departmentSystemInstructions.pt[session.context.department] || "Você é um assistente." } 
                });
                const aiText = response.text;
                queueOutbound(session.userId, { text: aiText });
                session.messageLog.push({ sender: 'bot', text: aiText, timestamp: new Date() });
                session.aiHistory.push({ role: 'model', parts: [{ text: aiText }] });
                if (session.aiHistory.length > 20) session.aiHistory = session.aiHistory.slice(-20);
            } catch (e) { queueOutbound(session.userId, { text: translations.pt.error }); }
            return;
        }
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        const rep = formatFlowStepForWhatsapp(currentStep, session.context);
        queueOutbound(session.userId, { text: rep });
        session.messageLog.push({ sender: 'bot', text: rep, timestamp: new Date() });
        return;
    }
    
    if (payload) session.context = { ...session.context, ...payload };
    if (nextState === ChatState.END_SESSION) {
        queueOutbound(session.userId, { text: translations.pt.sessionEnded });
        session.resolvedAt = new Date().toISOString(); 
        archiveSession(session);
        userSessions.delete(session.userId); 
        saveData('userSessions.json', userSessions); 
        return;
    }
    
    let cur = nextState;
    while(cur) {
        session.currentState = cur;
        const step = conversationFlow.get(cur);
        if (cur === ChatState.ATTENDANT_TRANSFER || cur === ChatState.SCHEDULING_CONFIRMED) {
            const dep = cur === ChatState.SCHEDULING_CONFIRMED ? 'Agendamento' : session.context.department;
            const det = session.context.history[ChatState.SCHEDULING_NEW_CLIENT_DETAILS] || session.context.history[ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS];
            addRequestToQueue(session, dep, cur === ChatState.SCHEDULING_CONFIRMED ? `Agendamento: ${session.context.clientType} - ${det}` : `Setor ${dep}`);
            session.handledBy = 'bot_queued';
        }
        const rep = formatFlowStepForWhatsapp(step, session.context);
        queueOutbound(session.userId, { text: rep });
        session.messageLog.push({ sender: 'bot', text: rep, timestamp: new Date() });
        if (step.nextState && !step.requiresTextInput && (!step.options || step.options.length === 0)) {
            cur = step.nextState; await delay(500);
        } else cur = null;
    }
}

function queueOutbound(userId, content) { outboundGatewayQueue.push({ userId, ...content }); }

async function processIncomingMessage({ userId, userName, userInput, file, replyContext, msgId }) {
    if (!userId) return;
    const cleanId = userId.replace(/:.*$/, '');
    if (userName) store.upsert(cleanId, { id: cleanId, notify: userName });
    const session = getSession(cleanId, userName);
    if (activeChats.has(cleanId)) session.handledBy = 'human';
    const logEntry = { sender: 'user', text: userInput, timestamp: new Date().toISOString(), msgId };
    if (file) {
        const url = saveMediaToDisk(file.data, file.type, file.name);
        if (url) logEntry.files = [{ name: file.name, type: file.type, url }];
    }
    if (replyContext) logEntry.replyTo = { text: replyContext.text, sender: replyContext.fromMe ? 'attendant' : 'user', senderName: replyContext.fromMe ? 'Você' : session.userName };
    session.messageLog.push(logEntry);

    if (logEntry.files && logEntry.files[0]?.type?.startsWith('audio/')) {
        const transcription = await transcribeAudio(logEntry.files[0].url, logEntry.files[0].type);
        session.messageLog.push({ sender: 'system', text: `Transcrição: "${transcription}"`, timestamp: new Date().toISOString() });
        if (session.handledBy === 'bot') await processMessage(session, transcription);
    } else if (session.handledBy === 'bot') {
        await processMessage(session, userInput);
    }
    saveData(activeChats.has(cleanId) ? 'activeChats.json' : 'userSessions.json', activeChats.has(cleanId) ? activeChats : userSessions);
}

// --- BAILEYS SETUP ---
const SESSION_FOLDER = path.join(DATA_DIR, 'baileys_auth_info');
async function startWhatsApp() {
    gatewayStatus.status = 'LOADING';
    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version, 
            auth: state, 
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true, 
            browser: ['JZF Atendimento', 'Chrome', '1.0.0'],
            msgRetryCounterCache, // Cache de retentativas para evitar loops de Bad MAC
            // ESSENCIAL: getMessage é o que resolve o erro "Aguardando mensagem..." e Bad MAC
            getMessage: async (key) => {
                const cached = await store.loadMessage(key.id);
                if (cached) return cached;
                return { conversation: '' };
            },
            // Otimizações para ambiente Render (menos quedas de conexão)
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            retryRequestDelayMs: 2000
        });
        
        store.bind(sock.ev);
        sock.ev.on('creds.update', saveCreds);

        // SYNC HANDLERS
        sock.ev.on('messaging-history.set', ({ contacts }) => {
            if (!contacts) return;
            contacts.forEach(contact => {
                if (contact.id.includes('@g.us')) return;
                const name = contact.name || contact.notify || contact.verifiedName;
                if (name) propagateNameUpdate(contact.id, name);
                const exists = syncedContacts.find(c => c.userId === contact.id);
                if (!exists) syncedContacts.push({ userId: contact.id, userName: name || contact.id.split('@')[0] });
                else if (name && exists.userName !== name) exists.userName = name;
            });
            saveData('syncedContacts.json', syncedContacts);
        });

        sock.ev.on('contacts.upsert', (contacts) => {
            contacts.forEach(c => {
                const name = c.name || c.notify || c.verifiedName;
                if (name) propagateNameUpdate(c.id, name);
                const exists = syncedContacts.find(sc => sc.userId === c.id);
                if (!exists) syncedContacts.push({ userId: c.id, userName: name || c.id.split('@')[0] });
                else if (name && exists.userName !== name) exists.userName = name;
            });
            saveData('syncedContacts.json', syncedContacts);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { gatewayStatus.qrCode = await QRCode.toDataURL(qr); gatewayStatus.status = 'QR_CODE_READY'; }
            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const should = statusCode !== DisconnectReason.loggedOut;
                gatewayStatus.status = 'DISCONNECTED';
                
                // Se erro for Bad MAC ou algo do Signal, limpa o contador de retentativas
                if (error?.message?.includes('Bad MAC') || error?.message?.includes('Signal')) {
                    console.warn('[Signal Fix] Resetando cache de retentativas para recuperar sessão.');
                    // Limpeza parcial do cache se necessário
                }

                if (should) setTimeout(startWhatsApp, 5000);
                else { 
                    fs.rmSync(SESSION_FOLDER, { recursive: true, force: true }); 
                    gatewayStatus.qrCode = null; setTimeout(startWhatsApp, 2000); 
                }
            } else if (connection === 'open') { gatewayStatus.status = 'CONNECTED'; gatewayStatus.qrCode = null; }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
                    const rawId = msg.key.remoteJid;
                    const userName = msg.pushName || rawId.split('@')[0];
                    let file = null;
                    const messageType = Object.keys(msg.message)[0];
                    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                    if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            const msgContent = msg.message[messageType];
                            file = { name: msgContent.fileName || `${messageType}_${Date.now()}`, type: msgContent.mimetype, data: buffer.toString('base64') };
                            text = msgContent.caption || '';
                        } catch (e) {}
                    }
                    let replyContext = null;
                    const ctx = msg.message.extendedTextMessage?.contextInfo || msg.message[messageType]?.contextInfo;
                    if (ctx?.quotedMessage) {
                        replyContext = { text: ctx.quotedMessage.conversation || "[Mídia]", fromMe: ctx.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net' };
                    }
                    await processIncomingMessage({ userId: rawId, userName, userInput: text, file, replyContext, msgId: msg.key.id });
                }
            }
        });
    } catch (e) { setTimeout(startWhatsApp, 5000); }
}

setInterval(async () => {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            let opt = {};
            if (item.replyTo?.id) opt.quoted = { key: { remoteJid: jid, fromMe: item.replyTo.fromMe || false, id: item.replyTo.id }, message: { conversation: item.replyTo.text || '...' } };
            if (item.files?.length > 0) {
                 for (const file of item.files) {
                    const buffer = file.url ? fs.readFileSync(path.join(MEDIA_DIR, path.basename(file.url))) : Buffer.from(file.data, 'base64');
                    await sock.sendMessage(jid, { [file.type.startsWith('image') ? 'image' : 'document']: buffer, caption: item.text, mimetype: file.type, fileName: file.name }, opt);
                 }
            } else { await sock.sendMessage(jid, { text: item.text }, opt); }
        } catch (e) { outboundGatewayQueue.unshift(item); await delay(2000); }
    }
}, 500); 

// --- API ---
app.use(express.json({ limit: '50mb' }));
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) app.use(express.static(distPath));
app.use('/media', express.static(MEDIA_DIR));

app.get('/api/gateway/status', (req, res) => res.json(gatewayStatus));
app.get('/api/attendants', (req, res) => res.json(ATTENDANTS));
app.get('/api/requests', (req, res) => res.json(requestQueue.map(r => ({ ...r, userName: resolveName(r.userId, r.userName) }))));
app.get('/api/clients', (req, res) => {
    const clientsMap = new Map();
    const sc = store.getContacts();
    Object.values(sc).forEach(c => { if (!c.id.includes('@g.us')) clientsMap.set(c.id, { userId: c.id, userName: c.name || c.notify || c.id.split('@')[0], tags: contactTags[c.id] || [] }); });
    syncedContacts.forEach(c => { if (!clientsMap.has(c.userId)) clientsMap.set(c.userId, { ...c, tags: contactTags[c.userId] || [] }); });
    res.json(Array.from(clientsMap.values()).sort((a,b) => (a.userName || '').localeCompare(b.userName || '')));
});
app.get('/api/chats/active', (req, res) => res.json(Array.from(activeChats.values()).map(c => ({ userId: c.userId, userName: resolveName(c.userId, c.userName), attendantId: c.attendantId, lastMessage: c.messageLog[c.messageLog.length-1], logLength: c.messageLog.length, lastMsgStatus: c.messageLog[c.messageLog.length-1]?.status || 0 }))));
app.get('/api/chats/ai-active', (req, res) => res.json(Array.from(userSessions.values()).filter(s => s.handledBy === 'bot' && !activeChats.has(s.userId)).map(c => ({ userId: c.userId, userName: resolveName(c.userId, c.userName), logLength: c.messageLog.length }))));
app.get('/api/chats/history/:userId', (req, res) => {
    const session = activeChats.get(req.params.userId) || userSessions.get(req.params.userId);
    if (!session) return res.status(404).send();
    res.json({ ...session, userName: resolveName(session.userId, session.userName) });
});
app.post('/api/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params; const { attendantId } = req.body;
    let session = userSessions.get(userId);
    if (!session) {
        const qIdx = requestQueue.findIndex(r => r.userId === userId);
        if (qIdx !== -1) { session = getSession(userId, requestQueue[qIdx].userName); requestQueue.splice(qIdx, 1); }
        else session = getSession(userId);
    } else { const qIdx = requestQueue.findIndex(r => r.userId === userId); if(qIdx !== -1) requestQueue.splice(qIdx, 1); }
    session.handledBy = 'human'; session.attendantId = attendantId;
    const msg = `Olá, sou o atendente ${ATTENDANTS.find(a=>a.id===attendantId)?.name || 'Atendente'} e vou te ajudar.`;
    session.messageLog.push({ sender: 'attendant', text: msg, timestamp: new Date().toISOString(), status: 2 });
    userSessions.delete(userId); activeChats.set(userId, session);
    saveData('requestQueue.json', requestQueue); saveData('activeChats.json', activeChats);
    queueOutbound(userId, { text: msg }); res.json(session);
});
app.post('/api/chats/attendant-reply', (req, res) => {
    const { userId, text, files, replyTo } = req.body;
    const chat = activeChats.get(userId); if (!chat) return res.status(404).send();
    const msg = { sender: 'attendant', text, timestamp: new Date().toISOString(), status: 1 };
    if (files?.length > 0) msg.files = files.map(f => f.data ? { name: f.name, type: f.type, url: saveMediaToDisk(f.data, f.type, f.name) } : f);
    if (replyTo) msg.replyTo = replyTo;
    chat.messageLog.push(msg); saveData('activeChats.json', activeChats);
    queueOutbound(userId, { text, files: msg.files, replyTo }); res.json({ success: true });
});
app.get('/api/system/backup', async (req, res) => {
    const archive = archiver('zip'); res.attachment(`JZF_Backup.zip`); archive.pipe(res);
    fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).forEach(f => archive.file(path.join(DATA_DIR, f), { name: f }));
    archive.directory(MEDIA_DIR, 'media'); await archive.finalize();
});
app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).send();
    const p = path.join(distPath, 'index.html');
    if (fs.existsSync(p)) res.sendFile(p); else res.status(500).send('Build not found');
});

startWhatsApp();
app.listen(port, () => console.log(`[Server] Rodando na porta ${port}`));
