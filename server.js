// --- SERVIDOR DE API INTEGRADO COM WHATSAPP (BAILEYS) ---
// Versão Monolítica: Express + Lógica de Negócio + Conexão WhatsApp no mesmo processo.

import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module'; // Import necessário para compatibilidade

import {
  ChatState,
  conversationFlow,
  departmentSystemInstructions,
  translations
} from './chatbotLogic.js';

// --- IMPORTAÇÕES DO BAILEYS ---
// Usamos createRequire para importar CommonJS dentro de ESM
const require = createRequire(import.meta.url);
const pkg = require('@whiskeysockets/baileys');

// Extração manual segura das exportações do Baileys
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
  console.error(`[FATAL - RECOVERED] Exceção não capturada: ${err.message}`, { stack: err.stack, origin });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL - RECOVERED] Rejeição de Promise não tratada:', reason);
});

const SERVER_VERSION = "21.9.3_IA_FILTER_FIX";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- PERSISTÊNCIA DE DADOS ---
const DATA_DIR = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  console.log(`[Persistence] Criando diretório de dados em: ${DATA_DIR}`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper functions
const serializeMap = (map) => Array.from(map.entries());
const deserializeMap = (arr) => new Map(arr);

const saveData = (filename, data) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    const tempPath = `${filePath}.tmp`;
    
    let dataToSave = data;
    if (data instanceof Map) dataToSave = serializeMap(data);
    
    fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error(`[Persistence] ERRO CRÍTICO ao salvar dados em ${filename}:`, error);
  }
};

const loadData = (filename, defaultValue) => {
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf8');
      if (fileContent.trim() === '') return defaultValue;
      const parsedData = JSON.parse(fileContent);
      if (defaultValue instanceof Map && Array.isArray(parsedData)) return deserializeMap(parsedData);
      return parsedData;
    }
  } catch (error) {
    console.error(`[Persistence] ERRO ao carregar ${filename}. Usando valor padrão.`, error);
  }
  return defaultValue;
};

// --- CUSTOM STORE IMPLEMENTATION (Para substituir makeInMemoryStore) ---
const makeCustomStore = () => {
    let contacts = {};

    return {
        contacts,
        upsert: (id, data) => {
            if (!id) return;
            // Se o contato já existe, mescla os dados. Se não, cria.
            // Importante: preserva o nome antigo se o novo vier vazio.
            const existing = contacts[id] || {};
            const newName = data.name || data.notify || data.verifiedName;
            
            contacts[id] = { 
                ...existing, 
                ...data,
                // Prioridade para nomes: Novo (se existir) > Antigo > ID
                name: newName || existing.name || existing.notify || existing.verifiedName 
            };
        },
        readFromFile: (filepath) => {
            try {
                if (fs.existsSync(filepath)) {
                    const content = fs.readFileSync(filepath, 'utf-8');
                    if(content) {
                        const data = JSON.parse(content);
                        if (data.contacts) {
                            contacts = data.contacts;
                            console.log(`[Store] Carregados ${Object.keys(contacts).length} contatos do arquivo.`);
                        }
                    }
                }
            } catch (e) {
                console.error('[Store] Falha ao ler arquivo:', e.message);
                // Se falhar a leitura, inicia vazio para não quebrar o app
                contacts = {};
            }
        },
        writeToFile: (filepath) => {
            try {
                fs.writeFileSync(filepath, JSON.stringify({ contacts }, null, 2), 'utf-8');
            } catch (e) {
                console.error('[Store] Falha ao escrever arquivo:', e);
            }
        },
        bind: (ev) => {
            // Sincronização inicial e histórico
            ev.on('messaging-history.set', ({ contacts: newContacts }) => {
                if (newContacts) {
                    console.log(`[Store] Recebido histórico com ${newContacts.length} contatos.`);
                    newContacts.forEach(c => {
                        store.upsert(c.id, c);
                    });
                    // Força salvamento imediato após carga de histórico
                    try {
                        const storePath = path.join(DATA_DIR, 'baileys_store.json');
                        fs.writeFileSync(storePath, JSON.stringify({ contacts }, null, 2), 'utf-8');
                    } catch(e) { console.error('[Store] Erro ao salvar histórico:', e); }
                }
            });

            // Novos contatos ou atualizações em massa
            ev.on('contacts.upsert', (newContacts) => {
                newContacts.forEach(c => {
                   store.upsert(c.id, c);
                });
                
                // Se receber muitos contatos de uma vez (boot inicial), salva logo
                if (newContacts.length > 5) {
                     console.log(`[Store] Sync em massa detectado (${newContacts.length} contatos). Salvando imediatamente.`);
                     try {
                        const storePath = path.join(DATA_DIR, 'baileys_store.json');
                        fs.writeFileSync(storePath, JSON.stringify({ contacts }, null, 2), 'utf-8');
                     } catch(e) { console.error('[Store] Erro ao salvar upsert:', e); }
                }
            });

            // Atualizações parciais
            ev.on('contacts.update', (updates) => {
                updates.forEach(u => {
                    store.upsert(u.id, u);
                });
            });
        }
    };
};

// Inicializa a Store Customizada
const store = makeCustomStore();
const STORE_FILE = path.join(DATA_DIR, 'baileys_store.json');

// Carrega dados existentes
store.readFromFile(STORE_FILE);

// Salva periodicamente (backup)
setInterval(() => {
    store.writeToFile(STORE_FILE);
}, 30_000); // Aumentado para 30s para evitar IO excessivo em loop


// --- ESTADO DO SISTEMA ---
let ATTENDANTS = loadData('attendants.json', []);
let nextAttendantId = ATTENDANTS.length > 0 ? Math.max(...ATTENDANTS.map(a => parseInt(a.id.split('_')[1]))) + 1 : 1;

const userSessions = loadData('userSessions.json', new Map());
let requestQueue = loadData('requestQueue.json', []);
const activeChats = loadData('activeChats.json', new Map());
const archivedChats = loadData('archivedChats.json', new Map());
const internalChats = loadData('internalChats.json', new Map());

let nextRequestId = requestQueue.length > 0 && requestQueue.every(r => typeof r.id === 'number') ? Math.max(...requestQueue.map(r => r.id)) + 1 : 1;

const MAX_SESSIONS = 10000;
const MAX_ARCHIVED_CHATS = 2000;

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

async function transcribeAudio(file) {
    if (!ai) return "[Áudio não transcrito - IA indisponível]";
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [{ inlineData: { mimeType: file.type, data: file.data } }, { text: "Transcreva este áudio em português do Brasil de forma literal." }] }],
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
    userHistory.push(JSON.parse(JSON.stringify(session)));
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

async function processIncomingMessage({ userId, userName, userInput, file, replyContext }) {
    if (!userId) return;
    const session = getSession(userId, userName);
    let effectiveInput = userInput;
    const logEntry = { sender: 'user', text: userInput, timestamp: new Date().toISOString() };
    if (file) logEntry.files = [file];
    if (replyContext) logEntry.replyTo = { text: replyContext.text, sender: replyContext.fromMe ? 'attendant' : 'user', senderName: replyContext.fromMe ? 'Você' : session.userName };
    session.messageLog.push(logEntry);

    if (file?.type?.startsWith('audio/')) {
        const transcription = await transcribeAudio(file);
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
        syncFullHistory: true, // Força pedido de histórico completo
        getMessage: async () => ({ conversation: 'hello' })
    });

    store.bind(sock.ev);

    // --- BACKUP DE SINCRONIZAÇÃO DE CONTATOS ---
    sock.ev.on('contacts.upsert', (contacts) => {
        // Filtra grupos e status broadcast
        const validContacts = contacts.filter(c => !c.id.includes('@g.us') && c.id !== 'status@broadcast');
        
        if (validContacts.length > 0) {
            // console.log(`[Backup Sync] Recebidos ${validContacts.length} contatos via listener explícito.`);
            
            validContacts.forEach(c => {
                store.upsert(c.id, c);
            });

            // Se for carga inicial (muitos contatos), força salvamento imediato
            if (validContacts.length > 5) {
                try {
                    store.writeToFile(STORE_FILE);
                    console.log(`[Backup Sync] Persistência imediata realizada.`);
                } catch(e) {
                    console.error(`[Backup Sync] Erro ao salvar:`, e);
                }
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('[WhatsApp] Novo QR Code gerado.');
            gatewayStatus.qrCode = await QRCode.toDataURL(qr);
            gatewayStatus.status = 'QR_CODE_READY';
        }

        if (connection === 'close') {
            const error = lastDisconnect?.error;
            const statusCode = error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`[WhatsApp] Conexão fechada. Status: ${statusCode}, Deve Reconectar: ${shouldReconnect}`);
            gatewayStatus.status = 'DISCONNECTED';

            if (shouldReconnect) {
                const delay = Math.min(5000 * (reconnectAttempts + 1), 60000);
                reconnectAttempts++;
                console.log(`[WhatsApp] Reconectando em ${delay/1000}s... (Tentativa ${reconnectAttempts})`);
                setTimeout(startWhatsApp, delay);
            } else {
                console.log(`[WhatsApp] Desconectado permanentemente (Logout). Limpando sessão.`);
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                gatewayStatus.qrCode = null;
                reconnectAttempts = 0;
                setTimeout(startWhatsApp, 2000);
            }
        } else if (connection === 'open') {
            gatewayStatus.status = 'CONNECTED';
            gatewayStatus.qrCode = null;
            reconnectAttempts = 0;
            console.log('[WhatsApp] CONEXÃO ESTABELECIDA COM SUCESSO!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.key.fromMe && msg.message) {
                const userId = msg.key.remoteJid;
                const userName = msg.pushName || userId.split('@')[0];

                // FIX: Garantir que o contato seja salvo no Store ao receber msg
                store.upsert(userId, { id: userId, name: userName });
                
                // Mídia
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
}

// Loop de envio de mensagens (Outbound)
setInterval(async () => {
    if (outboundGatewayQueue.length > 0 && sock && gatewayStatus.status === 'CONNECTED') {
        const item = outboundGatewayQueue.shift();
        try {
            const jid = item.userId.includes('@') ? item.userId : item.userId + '@s.whatsapp.net';
            
            if (item.files && item.files.length > 0) {
                 for (const file of item.files) {
                    const buffer = Buffer.from(file.data, 'base64');
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
            console.error('[Outbound] Erro ao enviar (colocando de volta na fila):', e.message);
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

// Listagem de clientes (COMBINADA: Store + Chats + Fila + Histórico)
app.get('/api/clients', (req, res) => {
    const clientsMap = new Map();
    
    // 1. Store oficial (Customizada) - Fonte primária
    if (store && store.contacts) {
        for (const id in store.contacts) {
            if (id.endsWith('@g.us') || id === 'status@broadcast') continue;

            const c = store.contacts[id];
            // Tenta pegar o nome mais amigável possível
            // Se não tiver nome, usa o ID formatado como nome provisório
            const name = c.name || c.notify || c.verifiedName || id.split('@')[0];
            
            clientsMap.set(id, { userId: id, userName: name });
        }
    }

    // Função helper para adicionar se não existir
    const addIfNotExists = (userId, userName) => {
        if (!clientsMap.has(userId)) {
            clientsMap.set(userId, { userId, userName });
        }
    };

    // 2. Chats Ativos
    activeChats.forEach(c => addIfNotExists(c.userId, c.userName));
    
    // 3. Fila de Espera
    requestQueue.forEach(r => addIfNotExists(r.userId, r.userName));

    // 4. Histórico (Arquivados)
    archivedChats.forEach((_, userId) => {
        if (!clientsMap.has(userId)) {
            // Tenta pegar do store para ter o nome atualizado, senão usa ID
            const stored = store.contacts[userId];
            const name = stored?.name || stored?.notify || userId.split('@')[0];
            addIfNotExists(userId, name);
        }
    });
    
    // Ordenar alfabeticamente
    const sortedClients = Array.from(clientsMap.values()).sort((a, b) => 
        a.userName.localeCompare(b.userName)
    );
    
    res.json(sortedClients);
});

app.get('/api/requests', (req, res) => res.json(requestQueue));

app.get('/api/chats/active', (req, res) => {
    const activeSummary = Array.from(activeChats.values()).map(c => {
        const lastMsg = c.messageLog[c.messageLog.length - 1];
        return {
            userId: c.userId,
            userName: c.userName,
            attendantId: c.attendantId,
            logLength: c.messageLog.length,
            lastMsgStatus: lastMsg ? lastMsg.status : 0,
            lastMessage: lastMsg
        };
    });
    res.json(activeSummary);
});

// Endpoint de IA ATIVOS (Corrigido para evitar duplicação e contatos aleatórios)
app.get('/api/chats/ai-active', (req, res) => {
    const aiChats = Array.from(userSessions.values())
        .filter(s => {
            // 1. Deve ser gerenciado pelo bot
            if (s.handledBy !== 'bot') return false;

            // 2. NÃO deve estar em chats ativos (humano) - previne duplicação
            if (activeChats.has(s.userId)) return false;

            // 3. Deve estar em um estado ESPECÍFICO de IA (Assistente Virtual)
            // Importa valores de ChatState conceitualmente
            return (
                s.currentState === 'AI_ASSISTANT_SELECT_DEPT' ||
                s.currentState === 'AI_ASSISTANT_CHATTING'
            );
        })
        .map(c => ({ 
            userId: c.userId, 
            userName: c.userName,
            logLength: c.messageLog.length 
        }));
    res.json(aiChats);
});

app.get('/api/chats/history', (req, res) => {
    const historySummary = [];
    archivedChats.forEach((sessions, userId) => {
        if(sessions.length > 0) {
            const lastSession = sessions[sessions.length - 1];
            historySummary.push({
                userId,
                userName: lastSession.userName,
                resolvedAt: lastSession.resolvedAt
            });
        }
    });
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
        const msg = { sender: 'attendant', text, files, timestamp: new Date().toISOString(), status: 1 };
        if(replyTo) msg.replyTo = replyTo;
        chat.messageLog.push(msg);
        saveData('activeChats.json', activeChats);
        queueOutbound(userId, { text, files });
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
    if(qIdx !== -1) {
        requestQueue.splice(qIdx, 1);
        saveData('requestQueue.json', requestQueue);
    }
    
    const session = getSession(userId, clientName); 
    
    // Configuração para garantir que o BOT não responda
    session.handledBy = 'human';
    session.attendantId = attendantId;
    session.currentState = 'HUMAN_INTERACTION_INITIATED'; 
    
    const msg = { sender: 'attendant', text: message, timestamp: new Date().toISOString(), status: 1 };
    if (files && files.length > 0) msg.files = files;

    session.messageLog.push(msg);
    userSessions.delete(userId);
    activeChats.set(userId, session);
    
    saveData('userSessions.json', userSessions);
    saveData('activeChats.json', activeChats);
    
    queueOutbound(userId, { text: message, files });
    res.json(session);
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
        const fwdMsg = {
            sender: 'attendant',
            text: originalMessage.text,
            files: originalMessage.files,
            isForwarded: true,
            timestamp: new Date().toISOString(),
            status: 1
        };
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
        if(msg) {
            msg.text = newText;
            msg.edited = true;
            saveData('activeChats.json', activeChats);
            res.json({ success: true });
        } else {
            res.status(404).send();
        }
    } else {
        res.status(404).send();
    }
});

app.get('/api/internal-chats/summary/:attendantId', (req, res) => res.json({}));

app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ error: 'Endpoint API não encontrado' });
    }
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(500).send('Erro: Build do frontend não encontrado (index.html)');
    }
});

startWhatsApp();
app.listen(port, () => console.log(`[Server] Rodando na porta ${port}`));
