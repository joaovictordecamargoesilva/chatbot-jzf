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
    jidDecode
} = pkg;

import pino from 'pino';
import QRCode from 'qrcode';

// --- MANIPULADORES GLOBAIS DE ERRO DE PROCESSO ---
process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL - RECOVERED] Exceção não capturada: ${err.message}`, { stack: err.stack, origin });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL - RECOVERED] Rejeição de Promise não tratada:', reason);
});

const SERVER_VERSION = "28.0.0_CONTACTS_FORCE_SYNC";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PERSISTÊNCIA DE DADOS ---
// Tenta usar o caminho do Render Disk, senão usa local
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

// LOG DE DIAGNÓSTICO
console.log("========================================");
console.log(`[STORAGE] Salvando dados em: ${DATA_DIR}`);
console.log(`[STORAGE] Variável RENDER_DISK_PATH: ${process.env.RENDER_DISK_PATH || 'Não definida'}`);
console.log("========================================");

if (!fs.existsSync(DATA_DIR)) {
  console.log(`[Persistence] Criando diretório de dados em: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(MEDIA_DIR)) {
    console.log(`[Persistence] Criando diretório de mídia em: ${MEDIA_DIR}`);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Helper functions
const serializeMap = (map) => Array.from(map.entries());
const deserializeMap = (arr) => new Map(arr);

// Salvamento com Backup (Blindado)
const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const tempPath = `${filePath}.tmp`;
    const backupPath = `${filePath}.bak`;
    
    if (fs.existsSync(filePath)) {
        try {
            fs.copyFileSync(filePath, backupPath);
        } catch(e) { console.warn(`[Persistence] Falha ao criar backup para ${filename}`); }
    }

    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    
    fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error(`[Persistence] ERRO CRÍTICO ao salvar dados em ${filename}:`, error);
  }
};

// Carregamento com Recuperação (Blindado)
const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const backupPath = `${filePath}.bak`;

    const tryRead = (path) => {
        if (!fs.existsSync(path)) return null;
        const content = fs.readFileSync(path, 'utf8');
        if (!content || content.trim() === '') return null;
        return JSON.parse(content);
    };

    let parsedData = tryRead(filePath);

    if (!parsedData && fs.existsSync(backupPath)) {
        console.warn(`[Persistence] Arquivo principal ${filename} corrompido ou vazio. Recuperando do backup...`);
        parsedData = tryRead(backupPath);
        if (parsedData) {
            saveData(filename, defaultValue instanceof Map && Array.isArray(parsedData) ? deserializeMap(parsedData) : parsedData);
        }
    }

    if (parsedData) {
        if (defaultValue instanceof Map && Array.isArray(parsedData)) return deserializeMap(parsedData);
        return parsedData;
    }

  } catch (error) {
    console.error(`[Persistence] ERRO ao carregar ${filename}. Usando valor padrão.`, error);
  }
  return defaultValue;
};

// --- DISK STORAGE UTILS ---
const saveMediaToDisk = (base64Data, mimeType, originalName) => {
    try {
        const ext = mimeType.split('/')[1] || 'bin';
        const fileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const filePath = path.join(MEDIA_DIR, fileName);
        
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(filePath, buffer);
        
        return `/media/${fileName}`; 
    } catch (error) {
        console.error('[Media] Erro ao salvar arquivo em disco:', error);
        return null;
    }
};

// --- CUSTOM STORE IMPLEMENTATION ---
const makeCustomStore = () => {
    let contacts = {};
    const STORE_FILE = path.join(DATA_DIR, 'baileys_store.json');

    const load = () => {
        try {
            if (fs.existsSync(STORE_FILE)) {
                const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
                if (data.contacts) contacts = data.contacts;
                console.log(`[Store] Carregados ${Object.keys(contacts).length} contatos do arquivo.`);
            }
        } catch(e) { console.error('[Store] Erro ao carregar:', e); }
    };

    const save = () => {
        try {
            fs.writeFileSync(STORE_FILE, JSON.stringify({ contacts }, null, 2));
        } catch(e) { console.error('[Store] Erro ao salvar:', e); }
    };

    // Lógica inteligente para mesclar dados
    const upsert = (id, data) => {
        if (!id || id.includes('@g.us') || id === 'status@broadcast') return;
        
        const existing = contacts[id] || {};
        
        // LÓGICA DE PRIORIDADE DE NOME
        const finalName = data.name || existing.name;
        const finalNotify = data.notify || existing.notify;

        contacts[id] = { 
            ...existing, 
            ...data,
            name: finalName,
            notify: finalNotify
        };
    };

    load();
    setInterval(save, 10000); 

    return {
        getContacts: () => contacts,
        upsert, 
        save, 
        bind: (ev) => {
            // Eventos internos do store
            ev.on('messaging-history.set', ({ contacts: newContacts }) => {
                if (newContacts) newContacts.forEach(c => upsert(c.id, c));
            });
            ev.on('contacts.upsert', (newContacts) => {
                newContacts.forEach(c => upsert(c.id, c));
            });
            ev.on('contacts.update', (updates) => {
                updates.forEach(u => upsert(u.id, u));
            });
        }
    };
};

const store = makeCustomStore();

// --- ESTADO DO SISTEMA ---
let ATTENDANTS = loadData('attendants.json', []);

if (!Array.isArray(ATTENDANTS) || ATTENDANTS.length === 0) {
    console.warn("[System] Lista de atendentes vazia. Criando usuário Admin padrão.");
    ATTENDANTS = [{ id: 'attendant_1', name: 'Admin' }];
    saveData('attendants.json', ATTENDANTS);
}

let nextAttendantId = 1;
if (ATTENDANTS.length > 0) {
    const ids = ATTENDANTS.map(a => {
        const parts = a.id.split('_');
        return parts.length > 1 ? parseInt(parts[1]) : 0;
    });
    nextAttendantId = Math.max(...ids) + 1;
}

const userSessions = loadData('userSessions.json', new Map());
let requestQueue = loadData('requestQueue.json', []);
const activeChats = loadData('activeChats.json', new Map());
const archivedChats = loadData('archivedChats.json', new Map());
// syncedContacts mantido como backup secundário
let syncedContacts = loadData('syncedContacts.json', []);

let tags = loadData('tags.json', []); 
let contactTags = loadData('contactTags.json', {}); 

let nextRequestId = requestQueue.length > 0 && requestQueue.every(r => typeof r.id === 'number') ? Math.max(...requestQueue.map(r => r.id)) + 1 : 1;

const MAX_SESSIONS = 1000; 
const MAX_ARCHIVED_CHATS = 500;

const outboundGatewayQueue = []; 

let gatewayStatus = { status: 'DISCONNECTED', qrCode: null };
let sock = null; 
let reconnectAttempts = 0;

// --- MIDDLEWARE ---
app.use(express.json({ limit: '50mb' }));

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
}

app.use('/media', express.static(MEDIA_DIR));

// --- CONFIGURAÇÃO IA (GEMINI) ---
let ai = null;
if (API_KEY) {
    try {
        ai = new GoogleGenAI({apiKey: API_KEY});
        console.log("[AI] Cliente Google GenAI inicializado.");
    } catch (error) {
        console.error("[AI] ERRO na inicialização da IA.", error);
    }
}

async function transcribeAudio(fileUrl, mimeType) {
    if (!ai) return "[Áudio não transcrito - IA indisponível]";
    try {
        const filePath = path.join(MEDIA_DIR, path.basename(fileUrl));
        if (!fs.existsSync(filePath)) return "[Erro: Arquivo de áudio não encontrado]";
        
        const fileData = fs.readFileSync(filePath).toString('base64');

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [{ inlineData: { mimeType: mimeType, data: fileData } }, { text: "Transcreva este áudio em português do Brasil de forma literal." }] }],
        });
        return response?.text?.trim() || "[Transcrição vazia]";
    } catch (error) {
        console.error("[Transcribe] Erro:", error);
        return `[Erro na transcrição]`;
    }
}

// --- LÓGICA DE SESSÃO E ARQUIVAMENTO ---
function archiveSession(session) {
    if (!session?.userId) return;
    
    let userHistory = archivedChats.get(session.userId) || [];
    userHistory.push(session);
    
    if (userHistory.length > 20) userHistory.shift();

    archivedChats.set(session.userId, userHistory);
    saveData('archivedChats.json', archivedChats);
    
    if (archivedChats.size > MAX_ARCHIVED_CHATS) {
        const oldestKey = archivedChats.keys().next().value;
        archivedChats.delete(oldestKey);
        saveData('archivedChats.json', archivedChats);
    }
}

function getSession(userId, userName = null) {
    let session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) {
        if (userSessions.size >= MAX_SESSIONS) {
            const oldestKey = userSessions.keys().next().value;
            userSessions.delete(oldestKey);
        }
        session = {
            userId, userName, currentState: ChatState.GREETING,
            context: { history: {} }, aiHistory: [], messageLog: [],
            handledBy: 'bot',
            attendantId: null, createdAt: new Date().toISOString(),
        };
        userSessions.set(userId, session);
        saveData('userSessions.json', userSessions);
    } else if (userName && session.userName !== userName) {
        session.userName = userName;
        saveData('userSessions.json', userSessions);
    }
    return session;
}

// GC Manual
setInterval(() => {
    const now = new Date().getTime();
    const expiry = 24 * 60 * 60 * 1000;
    
    for (const [key, session] of userSessions.entries()) {
        const lastInteraction = session.messageLog.length > 0 
            ? new Date(session.messageLog[session.messageLog.length-1].timestamp).getTime()
            : new Date(session.createdAt).getTime();
            
        if (now - lastInteraction > expiry) {
            userSessions.delete(key);
        }
    }
    saveData('userSessions.json', userSessions);
    
    if (global.gc) { try { global.gc(); } catch (e) {} }
}, 10 * 60 * 1000); 

function addRequestToQueue(session, department, message) {
    if (requestQueue.some(r => r.userId === session.userId) || activeChats.has(session.userId)) return;
    const request = { id: nextRequestId++, userId: session.userId, userName: session.userName, department, message, timestamp: new Date().toISOString() };
    requestQueue.unshift(request);
    saveData('requestQueue.json', requestQueue);
}

// --- LÓGICA DO CHATBOT ---
function formatFlowStepForWhatsapp(step, context) {
    let messageText = '';
    const textTemplate = translations.pt[step.textKey];
    if (textTemplate) messageText = typeof textTemplate === 'function' ? textTemplate(context) : textTemplate;
    
    if (step.options?.length > 0) {
        messageText += `\n\n${step.options.map((opt, i) => `*${i + 1}*. ${translations.pt[opt.textKey] || opt.textKey}`).join('\n')}`;
        messageText += `\n\nPor favor, digite o número da opção desejada.`;
    }
    return messageText;
}

async function processMessage(session, userInput, file) {
    const { userId } = session;
    if (!conversationFlow.has(session.currentState)) session.currentState = ChatState.GREETING;
    
    let currentStep = conversationFlow.get(session.currentState);
    let nextState, payload;
    const choice = parseInt(userInput.trim(), 10);
    const selectedOption = (currentStep.options && !isNaN(choice)) ? currentStep.options[choice - 1] : null;

    if (selectedOption) {
        nextState = selectedOption.nextState;
        payload = selectedOption.payload;
    } else if (currentStep.requiresTextInput) {
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            if (!ai) { queueOutbound(userId, { text: "IA indisponível no momento." }); return; }
            try {
                session.aiHistory.push({ role: 'user', parts: [{ text: userInput }] });
                if (session.aiHistory.length > 10) session.aiHistory = session.aiHistory.slice(-10);
                
                const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: session.aiHistory, config: { systemInstruction: departmentSystemInstructions.pt[session.context.department] || "Você é um assistente prestativo." } });
                const aiText = response.text;
                queueOutbound(userId, { text: aiText });
                session.messageLog.push({ sender: 'bot', text: aiText, timestamp: new Date() });
                session.aiHistory.push({ role: 'model', parts: [{ text: aiText }] });
            } catch (error) { console.error(`[AI] Erro:`, error); queueOutbound(userId, { text: translations.pt.error }); }
            return;
        }
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        if (session.currentState !== ChatState.GREETING) queueOutbound(userId, { text: "Opção inválida. Digite apenas o número." });
        const retryMsg = formatFlowStepForWhatsapp(currentStep, session.context);
        queueOutbound(userId, { text: retryMsg });
        return;
    }
    
    if (payload) session.context = { ...session.context, ...payload };
    
    if (nextState === ChatState.END_SESSION) {
        queueOutbound(userId, { text: translations.pt.sessionEnded });
        session.resolvedBy = "Cliente";
        session.resolvedAt = new Date().toISOString();
        archiveSession(session);
        userSessions.delete(userId);
        saveData('userSessions.json', userSessions);
        return;
    }
    
    let currentState = nextState;
    while(currentState) {
        session.currentState = currentState;
        const step = conversationFlow.get(currentState);
        if (currentState === ChatState.ATTENDANT_TRANSFER || currentState === ChatState.SCHEDULING_CONFIRMED) {
            const department = currentState === ChatState.SCHEDULING_CONFIRMED ? 'Agendamento' : session.context.department;
            const details = session.context.history[ChatState.SCHEDULING_NEW_CLIENT_DETAILS] || session.context.history[ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS];
            const reason = currentState === ChatState.SCHEDULING_CONFIRMED ? `Agendamento: ${session.context.clientType} - ${details}` : `Contato para setor ${department}.`;
            addRequestToQueue(session, department, reason);
            session.handledBy = 'bot_queued';
        }
        const reply = formatFlowStepForWhatsapp(step, session.context);
        queueOutbound(userId, { text: reply });
        session.messageLog.push({ sender: 'bot', text: reply, timestamp: new Date() });
        if (step.nextState && !step.requiresTextInput && (!step.options || step.options.length === 0)) {
            currentState = step.nextState;
            await new Promise(r => setTimeout(r, 500));
        } else { currentState = null; }
    }
}

function queueOutbound(userId, content) {
    outboundGatewayQueue.push({ userId, ...content });
}

// --- FUNÇÃO UNIFICADA DE SINCRONIZAÇÃO DE CONTATOS ---
function syncContactsToDisk(contacts) {
    if (!contacts || contacts.length === 0) return;
    
    let hasNew = false;
    for (const contact of contacts) {
        if (contact.id.includes('@g.us') || contact.id === 'status@broadcast') continue;
        
        // Atualiza Store principal
        store.upsert(contact.id, contact);

        // Atualiza syncedContacts (Backup p/ frontend)
        const exists = syncedContacts.find(c => c.userId === contact.id);
        
        // Prioridade CRÍTICA: Agenda ('name') > Apelido ('notify') > ID formatado
        let name = contact.name || contact.notify || contact.verifiedName;
        
        // Se não tiver nome, cria um nome formatado com o número (Fallback)
        // Isso garante que o contato SEMPRE apareça na lista
        if (!name) {
            const num = contact.id.split('@')[0];
            name = `+${num}`;
        }
        
        if (!exists) {
            syncedContacts.push({ userId: contact.id, userName: name });
            hasNew = true;
        } else {
            // SE for um 'name' (Agenda) e o que temos é diferente, atualiza
            if (contact.name && exists.userName !== contact.name) {
                exists.userName = contact.name;
                hasNew = true;
            } 
            // SE não temos nome nenhum (estava só numero), mas veio um notify, atualiza
            else if (exists.userName.startsWith('+') && name !== exists.userName) {
                exists.userName = name;
                hasNew = true;
            }
        }
    }
    
    if (hasNew) {
        saveData('syncedContacts.json', syncedContacts);
        store.save(); // Força salvar store também
        console.log(`[Sync] Atualizados ${contacts.length} contatos no disco.`);
    }
}

async function processIncomingMessage({ userId, userName, userInput, file, replyContext }) {
    if (!userId) return;
    
    // Garante que quem manda msg é salvo como contato
    syncContactsToDisk([{ id: userId, notify: userName }]);
    
    const session = getSession(userId, userName);
    let effectiveInput = userInput;
    const logEntry = { sender: 'user', text: userInput, timestamp: new Date().toISOString() };
    
    // Tratamento de Arquivo: Salvar no Disco e usar URL
    if (file) {
        const url = saveMediaToDisk(file.data, file.type, file.name);
        if (url) {
            logEntry.files = [{
                name: file.name,
                type: file.type,
                url: url // Salva URL, não data
            }];
        }
    }

    if (replyContext) logEntry.replyTo = { text: replyContext.text, sender: replyContext.fromMe ? 'attendant' : 'user', senderName: replyContext.fromMe ? 'Você' : session.userName };
    session.messageLog.push(logEntry);

    if (logEntry.files && logEntry.files[0]?.type?.startsWith('audio/')) {
        const transcription = await transcribeAudio(logEntry.files[0].url, logEntry.files[0].type);
        effectiveInput = transcription;
        session.messageLog.push({ sender: 'system', text: `Transcrição: "${transcription}"`, timestamp: new Date().toISOString() });
    }
    
    if (session.handledBy === 'human' || session.handledBy === 'bot_queued') {
        if (activeChats.has(userId)) saveData('activeChats.json', activeChats);
        else saveData('userSessions.json', userSessions);
        return;
    }
    if (session.handledBy === 'bot') {
       await processMessage(session, effectiveInput, file); 
       saveData('userSessions.json', userSessions);
    }
}

// --- INTEGRAÇÃO WHATSAPP (BAILEYS) ---
const SESSION_FOLDER = path.join(DATA_DIR, 'baileys_auth_info');

async function startWhatsApp() {
    console.log('[WhatsApp] Iniciando serviço...');
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
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 15000,
            emitOwnEvents: false,
            retryRequestDelayMs: 2000,
            defaultQueryTimeoutMs: 60000,
            markOnlineOnConnect: true,
            getMessage: async () => ({ conversation: 'hello' })
        });

        store.bind(sock.ev);

        sock.ev.on('creds.update', saveCreds);

        // --- SINCRONIZAÇÃO DE CONTATOS (EVENTOS MÚLTIPLOS) ---
        
        // 1. Histórico Completo (Sync Inicial)
        sock.ev.on('messaging-history.set', ({ contacts }) => {
            if (contacts) {
                console.log(`[WhatsApp] Histórico recebido: ${contacts.length} contatos.`);
                syncContactsToDisk(contacts);
            }
        });

        // 2. Upsert (Atualizações de lista)
        sock.ev.on('contacts.upsert', (contacts) => {
            // console.log(`[WhatsApp] Upsert de contatos: ${contacts.length}.`);
            syncContactsToDisk(contacts);
        });

        // 3. Set (Backup para carga inicial em algumas versões)
        sock.ev.on('contacts.set', (item) => {
            const contacts = item.contacts || item;
            console.log(`[WhatsApp] Contatos recebidos via set: ${contacts.length || 0}`);
            syncContactsToDisk(contacts);
        });

        // 4. Update (Mudança de nome/foto)
        sock.ev.on('contacts.update', (updates) => {
             syncContactsToDisk(updates);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                gatewayStatus.qrCode = await QRCode.toDataURL(qr);
                gatewayStatus.status = 'QR_CODE_READY';
            }

            if (connection === 'close') {
                const error = lastDisconnect?.error;
                const statusCode = error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                gatewayStatus.status = 'DISCONNECTED';

                if (shouldReconnect) {
                    const delayMs = Math.min(5000 * (reconnectAttempts + 1), 60000);
                    reconnectAttempts++;
                    console.log(`[WhatsApp] Conexão caiu (Código: ${statusCode}). Reconectando em ${delayMs/1000}s...`);
                    setTimeout(startWhatsApp, delayMs);
                } else {
                    console.log(`[WhatsApp] Logout explícito ou sessão inválida. Limpando e reiniciando.`);
                    try {
                        fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                    } catch(e) {}
                    
                    gatewayStatus.qrCode = null;
                    reconnectAttempts = 0;
                    setTimeout(startWhatsApp, 2000);
                }
            } else if (connection === 'open') {
                gatewayStatus.status = 'CONNECTED';
                gatewayStatus.qrCode = null;
                reconnectAttempts = 0;
                console.log('[WhatsApp] CONEXÃO ESTABELECIDA!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.key.fromMe && msg.message) {
                    const userId = msg.key.remoteJid;
                    const userName = msg.pushName || userId.split('@')[0];
                    
                    let file = null;
                    const messageType = Object.keys(msg.message)[0];
                    let text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

                    if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                        try {
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            file = {
                                name: `${messageType}.${messageType.startsWith('audio') ? 'ogg' : 'jpg'}`,
                                type: messageType.startsWith('audio') ? 'audio/ogg' : (messageType.startsWith('image') ? 'image/jpeg' : 'application/octet-stream'),
                                data: buffer.toString('base64')
                            };
                            text = msg.message[messageType].caption || '';
                        } catch (e) { console.error('Erro download mídia:', e); }
                    }

                    let replyContext = null;
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo || msg.message[messageType]?.contextInfo;
                    if (contextInfo && contextInfo.quotedMessage) {
                        const quotedText = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text;
                        replyContext = {
                            text: quotedText || "[Mídia/Arquivo]",
                            fromMe: contextInfo.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net'
                        };
                    }

                    await processIncomingMessage({ userId, userName, userInput: text, file, replyContext });
                }
            }
        });

        sock.ev.on('messages.update', async(updates) => {
           for(const update of updates) {
               if(update.update.status) {
                  const status = update.update.status; 
                  for (const [userId, chat] of activeChats.entries()) {
                       if (userId === update.key.remoteJid) {
                           const lastMsg = chat.messageLog[chat.messageLog.length -1];
                           if(lastMsg && lastMsg.sender === 'attendant') {
                               lastMsg.status = status;
                               saveData('activeChats.json', activeChats);
                           }
                       }
                  }
               }
           }
        });

    } catch (error) {
        console.error('[FATAL] Erro ao iniciar WhatsApp (Sessão Corrompida?):', error);
        try { fs.rmSync(SESSION_FOLDER, { recursive: true, force: true }); } catch(e) {}
        setTimeout(startWhatsApp, 5000);
    }
}

setInterval(async () => {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            
            if (item.files && item.files.length > 0) {
                 for (const file of item.files) {
                    let buffer;
                    if (file.url) {
                        const filePath = path.join(MEDIA_DIR, path.basename(file.url));
                        if(fs.existsSync(filePath)) buffer = fs.readFileSync(filePath);
                        else { console.error('Arquivo de mídia não encontrado no disco:', filePath); continue; }
                    } else if (file.data) {
                        buffer = Buffer.from(file.data, 'base64');
                    } else continue;

                    await sock.sendMessage(jid, { 
                        [file.type.startsWith('image') ? 'image' : 'document']: buffer, 
                        caption: item.text,
                        mimetype: file.type,
                        fileName: file.name
                    });
                 }
            } else {
                 await sock.sendMessage(jid, { text: item.text });
            }

            if(activeChats.has(item.userId)) {
                const chat = activeChats.get(item.userId);
                const lastMsg = chat.messageLog[chat.messageLog.length - 1];
                if(lastMsg && lastMsg.text === item.text) {
                    lastMsg.status = 2; // Enviado
                    saveData('activeChats.json', activeChats);
                }
            }

        } catch (e) {
            console.error('[Outbound] Erro ao enviar:', e.message);
            outboundGatewayQueue.unshift(item);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}, 500); 

// --- API ENDPOINTS ---

app.get('/api/gateway/status', (req, res) => res.json(gatewayStatus));
app.get('/api/attendants', (req, res) => res.json(ATTENDANTS));
app.post('/api/attendants', (req, res) => {
    const newAttendant = { id: `attendant_${nextAttendantId++}`, name: req.body.name };
    ATTENDANTS.push(newAttendant);
    saveData('attendants.json', ATTENDANTS);
    res.json(newAttendant);
});

// Listagem de clientes (COM SUPORTE A TAGS)
app.get('/api/clients', (req, res) => {
    const clientsMap = new Map();
    
    // 1. Pega do STORE (Memória + Disco) - Fonte mais confiável
    const storeContacts = store.getContacts();
    Object.values(storeContacts).forEach(c => {
        if (!c.id.includes('@g.us') && c.id !== 'status@broadcast') {
            const name = c.name || c.notify || c.verifiedName || c.id.split('@')[0];
            const clientTags = contactTags[c.id] || []; // Recupera tags
            clientsMap.set(c.id, { userId: c.id, userName: name, tags: clientTags });
        }
    });

    // 2. Backup do syncedContacts
    syncedContacts.forEach(c => { 
        if (!clientsMap.has(c.userId)) {
            const clientTags = contactTags[c.userId] || [];
            clientsMap.set(c.userId, { ...c, tags: clientTags });
        }
    });
    
    // 3. Completa com chats ativos e arquivados
    const addIfNotExists = (userId, userName) => { 
        if (!clientsMap.has(userId)) {
            const clientTags = contactTags[userId] || [];
            clientsMap.set(userId, { userId, userName, tags: clientTags }); 
        }
    };
    
    activeChats.forEach(c => addIfNotExists(c.userId, c.userName));
    requestQueue.forEach(r => addIfNotExists(r.userId, r.userName));
    archivedChats.forEach((sessions, userId) => { const lastSession = sessions[sessions.length - 1]; if (lastSession) addIfNotExists(userId, lastSession.userName); });
    
    const sortedClients = Array.from(clientsMap.values()).sort((a, b) => (a.userName || '').localeCompare(b.userName || ''));
    res.json(sortedClients);
});

// --- API DE TAGS (LISTAS) ---
app.get('/api/tags', (req, res) => res.json(tags));

app.post('/api/tags', (req, res) => {
    const { name, color } = req.body;
    const newTag = { id: `tag_${Date.now()}`, name, color: color || '#666' };
    tags.push(newTag);
    saveData('tags.json', tags);
    res.json(newTag);
});

app.delete('/api/tags/:id', (req, res) => {
    tags = tags.filter(t => t.id !== req.params.id);
    saveData('tags.json', tags);
    // Opcional: Remover essa tag dos contatos
    for (const userId in contactTags) {
        contactTags[userId] = contactTags[userId].filter(tid => tid !== req.params.id);
    }
    saveData('contactTags.json', contactTags);
    res.json({ success: true });
});

app.post('/api/tags/assign-bulk', (req, res) => {
    const { tagId, userIds } = req.body;
    if (!tagId || !userIds || !Array.isArray(userIds)) return res.status(400).send();
    
    // Verifica se a tag existe
    if (!tags.find(t => t.id === tagId)) return res.status(404).json({error: 'Tag não encontrada'});

    userIds.forEach(uid => {
        if (!contactTags[uid]) contactTags[uid] = [];
        if (!contactTags[uid].includes(tagId)) {
            contactTags[uid].push(tagId);
        }
    });
    
    saveData('contactTags.json', contactTags);
    res.json({ success: true });
});

app.get('/api/requests', (req, res) => res.json(requestQueue));

app.get('/api/chats/active', (req, res) => {
    const activeSummary = Array.from(activeChats.values()).map(c => {
        const lastMsg = c.messageLog[c.messageLog.length - 1];
        return { userId: c.userId, userName: c.userName, attendantId: c.attendantId, logLength: c.messageLog.length, lastMsgStatus: lastMsg ? lastMsg.status : 0, lastMessage: lastMsg };
    });
    res.json(activeSummary);
});

app.get('/api/chats/ai-active', (req, res) => {
    const aiChats = Array.from(userSessions.values()).filter(s => s.handledBy === 'bot' && !activeChats.has(s.userId) && (s.currentState === 'AI_ASSISTANT_SELECT_DEPT' || s.currentState === 'AI_ASSISTANT_CHATTING')).map(c => ({ userId: c.userId, userName: c.userName, logLength: c.messageLog.length }));
    res.json(aiChats);
});

app.get('/api/chats/history', (req, res) => {
    const historySummary = [];
    archivedChats.forEach((sessions, userId) => { if(sessions.length > 0) { const lastSession = sessions[sessions.length - 1]; historySummary.push({ userId, userName: lastSession.userName, resolvedAt: lastSession.resolvedAt }); } });
    res.json(historySummary);
});

app.get('/api/chats/history/:userId', (req, res) => {
    const { userId } = req.params;
    const oldSessions = archivedChats.get(userId) || [];
    const currentSession = activeChats.get(userId) || userSessions.get(userId);
    let fullLog = [];
    oldSessions.forEach(s => { if(s.messageLog) fullLog = fullLog.concat(s.messageLog); });
    if(currentSession && currentSession.messageLog) { fullLog = fullLog.concat(currentSession.messageLog); }
    fullLog.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
    const responseData = currentSession ? JSON.parse(JSON.stringify(currentSession)) : (oldSessions.length > 0 ? JSON.parse(JSON.stringify(oldSessions[oldSessions.length-1])) : { userId, userName: 'Novo Usuário', attendantId: null });
    responseData.messageLog = fullLog;
    res.json(responseData);
});

app.post('/api/chats/takeover/:userId', (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    let session = userSessions.get(userId);
    if (!session) {
         const queueIndex = requestQueue.findIndex(r => r.userId === userId);
         if (queueIndex !== -1) {
             const reqItem = requestQueue[queueIndex];
             session = getSession(userId, reqItem.userName);
             requestQueue.splice(queueIndex, 1);
             saveData('requestQueue.json', requestQueue);
         } else {
             session = getSession(userId);
         }
    } else {
        const qIdx = requestQueue.findIndex(r => r.userId === userId);
        if(qIdx !== -1) {
            requestQueue.splice(qIdx, 1);
            saveData('requestQueue.json', requestQueue);
        }
    }
    const attendantObj = ATTENDANTS.find(a => a.id === attendantId);
    const attendantName = attendantObj ? attendantObj.name : 'um atendente';
    session.handledBy = 'human';
    session.attendantId = attendantId;
    const takeoverMsg = `Olá, eu sou o atendente ${attendantName} e vou dar continuidade em seu atendimento.`;
    session.messageLog.push({ sender: 'attendant', text: takeoverMsg, timestamp: new Date().toISOString(), status: 2 });
    userSessions.delete(userId);
    saveData('userSessions.json', userSessions);
    activeChats.set(userId, session);
    saveData('activeChats.json', activeChats);
    queueOutbound(userId, { text: takeoverMsg });
    res.json(session);
});

app.post('/api/chats/attendant-reply', (req, res) => {
    const { userId, text, attendantId, files, replyTo } = req.body;
    const chat = activeChats.get(userId);
    if (chat) {
        const msg = { sender: 'attendant', text, timestamp: new Date().toISOString(), status: 1 };
        if (files && files.length > 0) {
            msg.files = files.map(f => {
                if (f.data) {
                    const url = saveMediaToDisk(f.data, f.type, f.name);
                    return { name: f.name, type: f.type, url };
                }
                return f;
            }).filter(f => f.url);
        }
        if(replyTo) msg.replyTo = replyTo;
        chat.messageLog.push(msg);
        saveData('activeChats.json', activeChats);
        queueOutbound(userId, { text, files: msg.files });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Chat não encontrado' });
    }
});

app.post('/api/chats/initiate', (req, res) => {
    const { recipientNumber, clientName, message, attendantId, files } = req.body;
    let userId = recipientNumber.includes('@') ? recipientNumber : recipientNumber + '@s.whatsapp.net';
    if(activeChats.has(userId)) return res.json(activeChats.get(userId));
    const qIdx = requestQueue.findIndex(r => r.userId === userId);
    if(qIdx !== -1) { requestQueue.splice(qIdx, 1); saveData('requestQueue.json', requestQueue); }
    const session = getSession(userId, clientName); 
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.currentState = 'HUMAN_INTERACTION_INITIATED'; 
    const msg = { sender: 'attendant', text: message, timestamp: new Date().toISOString(), status: 1 };
    if (files && files.length > 0) {
        msg.files = files.map(f => {
            if (f.data) {
                const url = saveMediaToDisk(f.data, f.type, f.name);
                return { name: f.name, type: f.type, url };
            }
            return f;
        }).filter(f => f.url);
    }
    session.messageLog.push(msg);
    userSessions.delete(userId);
    activeChats.set(userId, session);
    saveData('userSessions.json', userSessions);
    saveData('activeChats.json', activeChats);
    queueOutbound(userId, { text: message, files: msg.files });
    res.json(session);
});

// --- ROTA DE BROADCAST (TRANSMISSÃO EM MASSA) ---
app.post('/api/broadcast', (req, res) => {
    const { recipientIds, message, files, attendantId } = req.body;
    
    if (!recipientIds || !Array.isArray(recipientIds) || recipientIds.length === 0) {
        return res.status(400).json({ error: "Nenhum destinatário selecionado." });
    }

    // Processa arquivos (Disk Storage) uma única vez
    let processedFiles = [];
    if (files && files.length > 0) {
        processedFiles = files.map(f => {
            if (f.data) {
                const url = saveMediaToDisk(f.data, f.type, f.name);
                return { name: f.name, type: f.type, url };
            }
            return f;
        }).filter(f => f.url);
    }

    recipientIds.forEach(userId => {
        // Tenta obter sessão existente ou cria nova (mas não move para ActiveChats para não poluir a aba principal imediatamente)
        let session = activeChats.get(userId);
        let isNewSession = false;

        if (!session) {
            session = userSessions.get(userId);
            if (!session) {
                // Recupera nome se possível
                const storeContacts = store.getContacts();
                const contact = storeContacts[userId] || syncedContacts.find(c => c.userId === userId);
                session = getSession(userId, contact ? (contact.name || contact.notify || contact.userName) : userId.split('@')[0]);
                isNewSession = true;
            }
        }

        const msg = { 
            sender: 'attendant', 
            text: message, 
            files: processedFiles, 
            timestamp: new Date().toISOString(), 
            status: 1 
        };

        session.messageLog.push(msg);

        // Se o chat já está ativo, salva lá. Se não, salva em userSessions (background)
        if (activeChats.has(userId)) {
            saveData('activeChats.json', activeChats);
        } else {
            saveData('userSessions.json', userSessions);
        }

        // Adiciona à fila de envio
        queueOutbound(userId, { text: message, files: processedFiles });
    });

    res.json({ success: true, count: recipientIds.length });
});

// --- ROTA DE BACKUP (ZIP) ---
app.get('/api/system/backup', async (req, res) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    res.attachment(`JZF_Backup_${new Date().toISOString().split('T')[0]}.zip`);
    
    archive.pipe(res);
    
    // Adiciona todos os JSONs da pasta DATA_DIR (exceto a sessão do Baileys para segurança)
    const files = fs.readdirSync(DATA_DIR);
    for (const file of files) {
        if(file.endsWith('.json')) {
            archive.file(path.join(DATA_DIR, file), { name: file });
        }
    }
    
    // Adiciona a pasta de mídia
    archive.directory(MEDIA_DIR, 'media');
    
    await archive.finalize();
});

app.post('/api/chats/resolve/:userId', (req, res) => {
    const { userId } = req.params;
    const chat = activeChats.get(userId);
    if (chat) {
        chat.resolvedBy = 'Atendente';
        chat.resolvedAt = new Date().toISOString();
        archiveSession(chat);
        activeChats.delete(userId);
        saveData('activeChats.json', activeChats);
        queueOutbound(userId, { text: translations.pt.sessionEnded });
        res.json({ success: true });
    } else {
        res.status(404).send();
    }
});

app.post('/api/chats/transfer/:userId', (req, res) => {
    const { userId } = req.params;
    const { newAttendantId } = req.body;
    const chat = activeChats.get(userId);
    if(chat) {
        chat.attendantId = newAttendantId;
        chat.messageLog.push({ sender: 'system', text: `Transferido para outro atendente.`, timestamp: new Date().toISOString() });
        saveData('activeChats.json', activeChats);
        res.json({ success: true });
    } else {
        res.status(404).send();
    }
});

app.post('/api/chats/forward', (req, res) => {
    const { originalMessage, targetUserId } = req.body;
    const targetChat = activeChats.get(targetUserId);
    if (targetChat) {
        const fwdMsg = { sender: 'attendant', text: originalMessage.text, files: originalMessage.files, isForwarded: true, timestamp: new Date().toISOString(), status: 1 };
        targetChat.messageLog.push(fwdMsg);
        saveData('activeChats.json', activeChats);
        queueOutbound(targetUserId, { text: originalMessage.text, files: originalMessage.files });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Chat destino não ativo.' });
    }
});

app.post('/api/chats/edit-message', (req, res) => {
    const { userId, messageTimestamp, newText } = req.body;
    const chat = activeChats.get(userId);
    if(chat) {
        const msg = chat.messageLog.find(m => m.timestamp === messageTimestamp);
        if(msg) { msg.text = newText; msg.edited = true; saveData('activeChats.json', activeChats); res.json({ success: true }); } 
        else { res.status(404).send(); }
    } else { res.status(404).send(); }
});

app.get('/api/internal-chats/summary/:attendantId', (req, res) => res.json({}));

app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) { return res.status(404).json({ error: 'Endpoint API não encontrado' }); }
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) { res.sendFile(indexPath); } 
    else { res.status(500).send('Erro: Build do frontend não encontrado (index.html)'); }
});

startWhatsApp();
app.listen(port, () => console.log(`[Server] Rodando na porta ${port}`));
