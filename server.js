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
    delay,
    Browsers
} = pkg;

import pino from 'pino';
import QRCode from 'qrcode';

// --- MANIPULADORES GLOBAIS DE ERRO ---
process.on('uncaughtException', (err) => {
  if (err.message && (err.message.includes('Bad MAC') || err.message.includes('decryption') || err.message.includes('ciphertext'))) {
      console.warn(`[WhatsApp] Aviso: Erro de descriptografia (Bad MAC). Geralmente ignorado.`);
      return;
  }
  console.error(`[Fatal] Erro Crítico no Processo: ${err.message}`);
});

const SERVER_VERSION = "30.6.0_STABILITY_AND_ROUTES_FIX";
console.log(`[JZF Server] Iniciando Versão: ${SERVER_VERSION}`);

const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// --- PERSISTÊNCIA ---
const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    let dataToSave = data;
    if (data instanceof Map) dataToSave = Array.from(data.entries());
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
  } catch (e) { console.error(`Erro ao salvar ${filename}`); }
};

const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content) return defaultValue;
    const parsed = JSON.parse(content);
    if (defaultValue instanceof Map) return new Map(parsed);
    return parsed;
  } catch (e) { return defaultValue; }
};

// --- ESTADO GLOBAL ---
let ATTENDANTS = loadData('attendants.json', [{ id: 'attendant_1', name: 'Admin' }]);
const userSessions = loadData('userSessions.json', new Map());
const activeChats = loadData('activeChats.json', new Map());
let requestQueue = loadData('requestQueue.json', []);
const outboundGatewayQueue = []; 
let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

// --- LOGICA DO BOT ---

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) {
        session = { 
            userId, 
            userName: userName || userId.split('@')[0], 
            currentState: ChatState.GREETING, 
            context: { history: {} }, 
            aiHistory: [], 
            messageLog: [], 
            handledBy: 'bot', 
            createdAt: new Date().toISOString() 
        };
        userSessions.set(userId, session);
        saveData('userSessions.json', userSessions);
    }
    return session;
}

async function handleBotResponse(userId, userInput, session) {
    const config = conversationFlow.get(session.currentState);
    if (!config || session.handledBy === 'human') return;

    const inputClean = userInput.trim();

    // 1. Tentar processar como Opção (Número)
    if (config.options) {
        const optionIndex = parseInt(inputClean) - 1;
        if (!isNaN(optionIndex) && config.options[optionIndex]) {
            const selected = config.options[optionIndex];
            session.currentState = selected.nextState;
            if (selected.payload) session.context = { ...session.context, ...selected.payload };
            return sendCurrentStateMenu(userId, session);
        }
    }

    // 2. Tentar processar como entrada de texto
    if (config.requiresTextInput) {
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            return handleAiChat(userId, inputClean, session);
        } else {
            session.context.history[session.currentState] = inputClean;
            if (config.nextState) {
                session.currentState = config.nextState;
                return sendCurrentStateMenu(userId, session);
            }
        }
    }

    // 3. Fallback: Se não entendeu o comando ou é uma mensagem genérica, re-envia o menu
    sendCurrentStateMenu(userId, session);
}

async function handleAiChat(userId, userInput, session) {
    if (!ai) return queueOutbound(userId, { text: "Assistente de IA temporariamente indisponível." });
    try {
        const dept = session.context.department || "Contábil";
        const instruction = departmentSystemInstructions.pt[dept] || departmentSystemInstructions.pt["Contábil"];
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: [{ parts: [{ text: `Usuário: ${userInput}` }] }],
            config: { systemInstruction: instruction }
        });

        queueOutbound(userId, { text: response.text });
        
        // Re-envia as opções de navegação da IA
        const config = conversationFlow.get(ChatState.AI_ASSISTANT_CHATTING);
        let menuText = "\n\n--- OPÇÕES ---\n";
        config.options.forEach((opt, idx) => {
            menuText += `*${idx + 1}* - ${translations.pt[opt.textKey] || opt.textKey}\n`;
        });
        queueOutbound(userId, { text: menuText });

    } catch (e) { 
        queueOutbound(userId, { text: "Tive um problema técnico. Pode repetir sua pergunta?" });
    }
}

function sendCurrentStateMenu(userId, session) {
    const config = conversationFlow.get(session.currentState);
    if (!config) return;

    let textTemplate = translations.pt[config.textKey] || config.textKey;
    let text = typeof textTemplate === 'function' ? textTemplate(session.context || session) : textTemplate;
    
    if (config.options) {
        text += "\n\nEscolha uma opção digitando o número correspondente:\n";
        config.options.forEach((opt, idx) => {
            text += `*${idx + 1}* - ${translations.pt[opt.textKey] || opt.textKey}\n`;
        });
    }

    queueOutbound(userId, { text });

    if (session.currentState === ChatState.ATTENDANT_TRANSFER || session.currentState === ChatState.SCHEDULING_CONFIRMED) {
        if (!requestQueue.find(r => r.userId === userId)) {
            requestQueue.push({ userId, userName: session.userName, timestamp: new Date().toISOString(), department: session.context.department || 'Geral' });
            saveData('requestQueue.json', requestQueue);
        }
    }
}

// --- WHATSAPP ENGINE ---

async function startWhatsApp() {
    gatewayStatus.status = 'LOADING';
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'baileys_auth_info'));
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: true,
            retryRequestDelayMs: 2000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                gatewayStatus.qrCode = await QRCode.toDataURL(qr);
                gatewayStatus.status = 'QR_CODE_READY';
            }
            if (connection === 'open') {
                gatewayStatus.status = 'CONNECTED';
                gatewayStatus.qrCode = null;
                console.log('[WhatsApp] Online!');
            }
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                gatewayStatus.status = 'DISCONNECTED';
                if (shouldReconnect) setTimeout(startWhatsApp, 5000);
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                
                const cleanId = msg.key.remoteJid.replace(/:.*$/, '');
                const name = msg.pushName || cleanId.split('@')[0];
                
                // Se não houver mensagem legível, pode ser erro de chave ou mídia sem legenda
                if (!msg.message) {
                    console.warn(`[WhatsApp] Mensagem ignorada de ${cleanId} (Provável Bad MAC ou Erro de Chave).`);
                    // Mesmo com erro de descriptografia, inicializamos a sessão se for nova
                    getSession(cleanId, name);
                    continue;
                }

                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
                
                // Tratar mídia básica
                if (!text) {
                    if (msg.message.imageMessage) text = msg.message.imageMessage.caption || "";
                    if (msg.message.videoMessage) text = msg.message.videoMessage.caption || "";
                    if (msg.message.documentMessage) text = msg.message.documentMessage.caption || "";
                }

                await processIncomingMessage({ userId: cleanId, userName: name, userInput: text });
            }
        });

    } catch (e) {
        console.error('[WhatsApp] Erro fatal:', e);
        setTimeout(startWhatsApp, 10000);
    }
}

async function processIncomingMessage({ userId, userName, userInput }) {
    const session = getSession(userId, userName);
    
    session.messageLog.push({ sender: 'user', text: userInput || "(Mídia)", timestamp: new Date().toISOString() });

    if (session.handledBy === 'bot') {
        // Se for a PRIMEIRA mensagem real ou se o bot estiver no estado inicial, envia o menu
        if (session.messageLog.length === 1 || session.currentState === ChatState.GREETING) {
             // Se o usuário já enviou algo que não seja comando, tratamos como saudação
             await handleBotResponse(userId, userInput, session);
        } else {
             await handleBotResponse(userId, userInput, session);
        }
    }

    saveData(activeChats.has(userId) ? 'activeChats.json' : 'userSessions.json', activeChats.has(userId) ? activeChats : userSessions);
}

function queueOutbound(userId, content) {
    outboundGatewayQueue.push({ userId, ...content, retry: 0 });
}

async function processOutboundQueue() {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            await sock.sendMessage(jid, { text: item.text });
        } catch (e) {
            if (item.retry < 3) {
                item.retry++;
                outboundGatewayQueue.push(item);
            }
        }
    }
    setTimeout(processOutboundQueue, 1500);
}

// --- EXPRESS API (CORREÇÃO DE ROTAS 404) ---

app.use(express.json({ limit: '50mb' }));
app.use('/media', express.static(MEDIA_DIR));

// Helper para expor rotas em múltiplos caminhos requisitados pelo frontend
const expose = (paths, handler) => {
    const p = Array.isArray(paths) ? paths : [paths];
    p.forEach(path => {
        app.get(path, handler);
        app.get(`/api${path}`, handler);
    });
};

expose(['/attendants'], (req, res) => res.json(ATTENDANTS));
expose(['/requests'], (req, res) => res.json(requestQueue));
expose(['/ai-active'], (req, res) => res.json(Array.from(userSessions.values()).filter(s => s.handledBy === 'bot')));
expose(['/history'], (req, res) => {
    const { userId } = req.query;
    const chat = activeChats.get(userId) || userSessions.get(userId);
    res.json(chat || { userId, messageLog: [] });
});
expose(['/active', '/chats/active'], (req, res) => {
    res.json(Array.from(activeChats.values()));
});
expose(['/clients'], (req, res) => {
    const clients = Array.from(userSessions.values()).map(s => ({ userId: s.userId, userName: s.userName }));
    res.json(clients);
});

// Handler para attendant específico
app.get(['/attendant_*', '/api/attendant_*'], (req, res) => {
    const id = req.path.split('/').pop();
    const attendant = ATTENDANTS.find(a => a.id === id);
    if (attendant) res.json(attendant);
    else res.status(404).json({ error: "Atendente não encontrado" });
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
    queueOutbound(userId, { text: "Olá! Assumi seu atendimento. Como posso ajudar?" });
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

// Arquivos do frontend (Dist)
app.use(express.static(path.join(__dirname, 'dist')));

// Redireciona qualquer outra rota para o index.html (SPA)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

startWhatsApp();
processOutboundQueue();
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
