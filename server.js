// --- SERVIDOR DE API EXCLUSIVO PARA RENDER ---
// Versão para deploy limpo. Nenhuma lógica do wppconnect deve estar aqui.

import express from 'express';
// @google/genai-ts FIX: Use the correct class name as per the new SDK guidelines.
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  ChatState,
  conversationFlow,
  departmentSystemInstructions,
  translations
} from './chatbotLogic.js';

// --- MANIPULADORES GLOBAIS DE ERRO DE PROCESSO ---
// Essencial para produção: captura exceções não tratadas e rejeições de promise
// para evitar que o servidor trave silenciosamente, o que causa erros 502.
process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL] Exceção não capturada: ${err.message}`, {
    stack: err.stack,
    origin: origin,
  });
  // Para erros graves, é mais seguro encerrar o processo e deixar o orquestrador (Render) reiniciá-lo.
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Rejeição de Promise não tratada:', {
    reason: reason,
    promise: promise,
  });
  // Encerrar o processo em caso de rejeições não tratadas também é uma prática segura.
  process.exit(1);
});


const SERVER_VERSION = "18.3.0_STABLE_COMPLETE";
console.log(`[JZF Chatbot Server] Iniciando... Versão: ${SERVER_VERSION}`);

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = process.env.PORT || 3000;
const { API_KEY } = process.env;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- DADOS EM MEMÓRIA ---
// AVISO DE PRODUÇÃO: Os dados em memória são voláteis e serão perdidos a cada reinicialização
// ou deploy do servidor. Para uma aplicação real, substitua por um banco de dados
// persistente (ex: PostgreSQL, MongoDB) e um cache (ex: Redis).
const ATTENDANTS = [];
let nextAttendantId = 1; // Inicia o contador em 1
const userSessions = new Map();
const requestQueue = [];
const activeChats = new Map();
const archivedChats = new Map();
const MAX_SESSIONS = 2000; // Limite de segurança para sessões em memória
const MAX_ARCHIVED_CHATS = 500; // Cap para prevenir vazamento de memória
const outboundGatewayQueue = [];
const internalChats = new Map();
let syncedContacts = [];
let nextRequestId = 1;


// --- MIDDLEWARE DE LOG GLOBAL ---
app.use((req, res, next) => {
  console.log(`[Request Logger] Recebida: ${req.method} ${req.originalUrl}`);
  next();
});

// --- PARSERS E CONFIGURAÇÕES BÁSICAS ---
app.use(express.json({ limit: '50mb' }));

// --- INICIALIZAÇÃO RESILIENTE DO CLIENTE DE IA ---
let ai = null;
if (API_KEY) {
    try {
        ai = new GoogleGenAI({apiKey: API_KEY});
        console.log("[JZF Chatbot Server] Cliente Google GenAI inicializado com sucesso.");
    } catch (error) {
        console.error("[JZF Chatbot Server] ERRO: Falha ao inicializar o cliente Google GenAI.", error);
    }
} else {
    console.warn("[JZF Chatbot Server] AVISO: API_KEY não definida. Funcionalidades de IA estarão desativadas.");
}

// --- FUNÇÃO DE TRANSCRIÇÃO DE ÁUDIO COM GEMINI AI ---
async function transcribeAudio(file) {
    if (!ai) {
        console.warn("[Transcribe] Tentativa de transcrever áudio, mas a IA não está inicializada.");
        return "[Áudio não pôde ser transcrito - IA indisponível]";
    }
    if (!file || !file.data || !file.type) {
        console.error("[Transcribe] Dados de áudio inválidos fornecidos.");
        return "[Erro na transcrição: dados de áudio ausentes]";
    }

    try {
        console.log(`[Transcribe] Iniciando transcrição para arquivo do tipo ${file.type}...`);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ 
                parts: [
                    { inlineData: { mimeType: file.type, data: file.data } },
                    { text: "Transcreva este áudio em português do Brasil de forma literal." }
                ]
            }],
        });

        const transcription = response?.text?.trim();
        
        if (transcription) {
            console.log(`[Transcribe] Transcrição concluída: "${transcription}"`);
            return transcription;
        } else {
            console.warn(`[Transcribe] A transcrição da IA retornou um texto vazio para o arquivo: ${file.name || 'desconhecido'}`);
            return "[Transcrição falhou ou o áudio estava em silêncio.]";
        }

    } catch (error) {
        console.error("[Transcribe] Erro CRÍTICO durante a chamada da API Gemini para transcrição:", error);
        return `[Não foi possível transcrever o áudio]`;
    }
}


// --- FUNÇÕES DE GERENCIAMENTO DE SESSÃO E DADOS ---
function archiveSession(session) {
    if (!session || !session.userId) {
        console.error('[archiveSession] Tentativa de arquivar sessão inválida.');
        return;
    }
    archivedChats.delete(session.userId);
    archivedChats.set(session.userId, { ...session });
    
    if (archivedChats.size > MAX_ARCHIVED_CHATS) {
        const oldestKey = archivedChats.keys().next().value;
        archivedChats.delete(oldestKey);
        console.log(`[Memory] Limite de arquivos atingido. Chat arquivado mais antigo (${oldestKey}) removido.`);
    }
}

function getSession(userId, userName = null) {
    // MODIFICAÇÃO CHAVE: Busca primeiro nos chats ativos, depois nas sessões do bot.
    // Isso previne que uma nova sessão de bot seja criada para um chat já em atendimento.
    let session = activeChats.get(userId) || userSessions.get(userId);

    if (!session) {
        // CONTROLE DE MEMÓRIA: Remove a sessão mais antiga se o limite for atingido.
        if (userSessions.size >= MAX_SESSIONS) {
            const oldestKey = userSessions.keys().next().value;
            userSessions.delete(oldestKey);
            console.warn(`[Memory] Limite de ${MAX_SESSIONS} sessões atingido. Sessão mais antiga (${oldestKey}) removida.`);
        }
        session = {
            userId: userId,
            userName: userName,
            currentState: ChatState.GREETING,
            context: { history: {} },
            aiHistory: [],
            messageLog: [],
            handledBy: 'bot', // 'bot' | 'human' | 'bot_queued'
            attendantId: null,
            createdAt: new Date().toISOString(),
        };
        userSessions.set(userId, session);
    } else {
        // Se a sessão já existe, apenas atualiza o nome se necessário.
        if (userName && session.userName !== userName) {
            session.userName = userName;
        }
    }
    return session;
}

function addRequestToQueue(session, department, message) {
    const { userId, userName } = session;
    if (requestQueue.some(r => r.userId === userId) || activeChats.has(userId)) {
        console.log(`[Queue] Bloqueada adição de ${userId} à fila pois já existe uma solicitação.`);
        return;
    }
    const request = {
        id: nextRequestId++,
        userId,
        userName,
        department,
        message,
        timestamp: new Date().toISOString(),
    };
    requestQueue.unshift(request);
    console.log(`[Queue] Nova solicitação adicionada: ID ${request.id} (${userName}) para o setor ${department}`);
}

// --- PROCESSAMENTO PRINCIPAL DO CHATBOT (Lógica do WhatsApp) ---

function formatFlowStepForWhatsapp(step, context) {
    let messageText = '';
    const textTemplate = translations.pt[step.textKey];
    if (textTemplate) { messageText = typeof textTemplate === 'function' ? textTemplate(context) : textTemplate; }
    if (step.options && step.options.length > 0) {
        const optionsText = step.options.map((opt, index) => `*${index + 1}*. ${translations.pt[opt.textKey] || opt.textKey}`).join('\n');
        messageText += `\n\n${optionsText}`;
    }
    return messageText;
}

async function processMessage(session, userInput, file) { // file is part of signature but unused in this logic
    const { userId } = session;
    
    // SAFEGUARD: Se o estado for inválido, reseta para o início.
    if (!conversationFlow.has(session.currentState)) {
        console.error(`[Flow] Estado inválido ou desconhecido: "${session.currentState}" para o usuário ${userId}. Reiniciando a sessão.`);
        session.currentState = ChatState.GREETING;
    }
    
    let currentStep = conversationFlow.get(session.currentState);
    let nextState, payload;

    const choice = parseInt(userInput.trim(), 10);
    const selectedOption = (currentStep.options && !isNaN(choice)) ? currentStep.options[choice - 1] : null;

    if (selectedOption) {
        nextState = selectedOption.nextState;
        payload = selectedOption.payload;
    } else if (currentStep.requiresTextInput) {
        // Lógica para chat com IA foi movida para cá para centralização
        if (session.currentState === ChatState.AI_ASSISTANT_CHATTING) {
            if (!ai) {
                const errorMsg = "Desculpe, o assistente de IA está temporariamente indisponível.";
                outboundGatewayQueue.push({ userId, text: errorMsg });
                session.messageLog.push({ sender: 'bot', text: errorMsg, timestamp: new Date() });
            } else {
                try {
                    session.aiHistory.push({ role: 'user', parts: [{ text: userInput }] });
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: session.aiHistory,
                        config: { systemInstruction: departmentSystemInstructions.pt[session.context.department] || "Você é um assistente prestativo." }
                    });
                    const aiResponseText = response.text;
                    
                    outboundGatewayQueue.push({ userId, text: aiResponseText });
                    session.messageLog.push({ sender: 'bot', text: aiResponseText, timestamp: new Date() });
                    session.aiHistory.push({ role: 'model', parts: [{ text: aiResponseText }] });
                } catch (error) {
                    console.error(`[AI Chat] Erro CRÍTICO ao processar AI para ${userId}:`, error);
                    const errorMsg = translations.pt.error;
                    outboundGatewayQueue.push({ userId, text: errorMsg });
                    session.messageLog.push({ sender: 'bot', text: errorMsg, timestamp: new Date() });
                }
            }
            return; // Permanece no modo de chat com IA
        }
        // Para outros inputs de texto (ex: agendamento)
        nextState = currentStep.nextState;
        session.context.history[session.currentState] = userInput;
    } else {
        // LÓGICA ATUALIZADA: No estado GREETING, qualquer texto inválido reenvia a saudação.
        if (session.currentState === ChatState.GREETING) {
            const stepFormatted = formatFlowStepForWhatsapp(currentStep, session.context);
            outboundGatewayQueue.push({ userId, text: stepFormatted });
            session.messageLog.push({ sender: 'bot', text: stepFormatted, timestamp: new Date() });
            return;
        } else {
            const invalidOptionMsg = "Opção inválida. Por favor, digite apenas o número da opção desejada.";
            outboundGatewayQueue.push({ userId, text: invalidOptionMsg });
            session.messageLog.push({ sender: 'bot', text: invalidOptionMsg, timestamp: new Date() });
            const stepFormatted = formatFlowStepForWhatsapp(currentStep, session.context);
            outboundGatewayQueue.push({ userId, text: stepFormatted });
            session.messageLog.push({ sender: 'bot', text: stepFormatted, timestamp: new Date() });
            return;
        }
    }
    
    if (payload) {
        session.context = { ...session.context, ...payload };
    }
    
    if (nextState === ChatState.END_SESSION) {
        const endMsg = translations.pt.sessionEnded;
        outboundGatewayQueue.push({ userId, text: endMsg });
        session.messageLog.push({ sender: 'bot', text: endMsg, timestamp: new Date() });
        session.resolvedBy = "Cliente";
        session.resolvedAt = new Date().toISOString();
        archiveSession(session);
        userSessions.delete(userId);
        console.log(`[Flow] Sessão para ${userId} finalizada pelo cliente e arquivada.`);
        return;
    }
    
    let currentState = nextState;
    while(currentState) {
        session.currentState = currentState;
        const step = conversationFlow.get(currentState);
        if (!step) {
            console.error(`[Flow] Estado inválido no loop: ${currentState}. Reiniciando sessão para ${userId}.`);
            currentState = ChatState.GREETING;
            continue;
        }

        if (currentState === ChatState.ATTENDANT_TRANSFER || currentState === ChatState.SCHEDULING_CONFIRMED) {
            const department = currentState === ChatState.SCHEDULING_CONFIRMED ? 'Agendamento' : session.context.department;
            const details = session.context.history[ChatState.SCHEDULING_NEW_CLIENT_DETAILS] || session.context.history[ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS];
            const reason = currentState === ChatState.SCHEDULING_CONFIRMED
                ? `Solicitação de agendamento.\n- Tipo: ${session.context.clientType}\n- Detalhes: ${details}`
                : `Cliente pediu para falar com o setor ${department}.`;
            addRequestToQueue(session, department, reason);
            session.handledBy = 'bot_queued';
        }
        const formattedReply = formatFlowStepForWhatsapp(step, session.context);
        outboundGatewayQueue.push({ userId, text: formattedReply });
        session.messageLog.push({ sender: 'bot', text: formattedReply, timestamp: new Date() });
        
        if (step.nextState && !step.requiresTextInput && (!step.options || step.options.length === 0)) {
            currentState = step.nextState;
            await new Promise(r => setTimeout(r, 500));
        } else {
            currentState = null; // Interrompe o loop
        }
    }
}


// --- PROCESSADOR DE MENSAGENS EM SEGUNDO PLANO ---
async function processIncomingMessage(body) {
    const { userId, userName, userInput, file, gatewayError } = body;
    
    // Validação essencial
    if (!userId) {
        console.error('[Background Processor] Ignorando mensagem sem userId.');
        return;
    }

    const session = getSession(userId, userName);
    let effectiveInput = userInput;

    if (gatewayError) {
        session.messageLog.push({ sender: 'system', text: `Erro no gateway: ${userInput}`, timestamp: new Date().toISOString() });
        return; // Não processa mais se houve erro no gateway
    }

    // Log da mensagem do usuário
    if (file) {
        session.messageLog.push({ sender: 'user', text: userInput, file: { ...file }, timestamp: new Date().toISOString() });
        if (file.type && file.type.startsWith('audio/')) {
            const transcription = await transcribeAudio(file);
            effectiveInput = transcription; // Usa a transcrição como a entrada do usuário
            session.messageLog.push({ sender: 'system', text: `Transcrição do áudio: "${transcription}"`, timestamp: new Date().toISOString() });
        }
    } else {
        session.messageLog.push({ sender: 'user', text: userInput, timestamp: new Date().toISOString() });
    }

    // Se o chat já está com um atendente humano ou na fila, não faz nada.
    if (session.handledBy === 'human' || session.handledBy === 'bot_queued') {
        console.log(`[Background Processor] Mensagem de ${userId} recebida para chat já em atendimento humano/fila. Apenas registrando.`);
        return;
    }
    
    // Se a sessão está com o bot, processa a mensagem
    if (session.handledBy === 'bot') {
       await processMessage(session, effectiveInput, file);
    }
}


// --- ROTAS DA API ---
const apiRouter = express.Router();

// Helper para envolver rotas async e capturar erros
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);


// --- ROTAS DO PAINEL DE ATENDIMENTO ---

// Rota de Health Check - essencial para plataformas de deploy
apiRouter.get('/health', (req, res) => {
  res.status(200).send('OK');
});

apiRouter.get('/attendants', asyncHandler(async (req, res) => {
    res.status(200).json(ATTENDANTS);
}));

apiRouter.post('/attendants', asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).send('Nome do atendente é inválido.');
    }
    const normalizedName = name.trim();
    if (ATTENDANTS.some(a => a.name.toLowerCase() === normalizedName.toLowerCase())) {
        return res.status(409).send('Um atendente com este nome já existe.');
    }
    const newAttendant = {
        id: `attendant_${nextAttendantId++}`,
        name: normalizedName
    };
    ATTENDANTS.push(newAttendant);
    console.log(`[Auth] Novo atendente registrado: ${normalizedName} (ID: ${newAttendant.id})`);
    res.status(201).json(newAttendant);
}));

apiRouter.get('/requests', asyncHandler(async (req, res) => {
    res.status(200).json(requestQueue);
}));

apiRouter.get('/chats/active', asyncHandler(async (req, res) => {
    const chats = Array.from(activeChats.values()).map(session => ({
        userId: session.userId,
        userName: session.userName,
        attendantId: session.attendantId,
        lastMessage: session.messageLog[session.messageLog.length - 1] || null
    }));
    res.status(200).json(chats);
}));

apiRouter.get('/chats/ai-active', asyncHandler(async (req, res) => {
    const aiChats = Array.from(userSessions.values())
        .filter(s => s.handledBy === 'bot' && !requestQueue.some(r => r.userId === s.userId) && s.currentState !== ChatState.GREETING)
        .map(session => ({
            userId: session.userId,
            userName: session.userName,
            department: session.context?.department,
            lastMessage: session.messageLog[session.messageLog.length - 1] || null
        }));
    res.status(200).json(aiChats);
}));

apiRouter.get('/clients', asyncHandler(async (req, res) => {
    res.status(200).json(syncedContacts);
}));

apiRouter.get('/chats/history', asyncHandler(async (req, res) => {
    const history = Array.from(archivedChats.values()).map(session => ({
        userId: session.userId,
        userName: session.userName,
        attendantId: session.attendantId,
        lastMessage: session.messageLog[session.messageLog.length - 1] || null,
        resolvedAt: session.resolvedAt,
        resolvedBy: session.resolvedBy
    })).sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    res.status(200).json(history);
}));

apiRouter.get('/chats/history/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const session = activeChats.get(userId) || userSessions.get(userId) || archivedChats.get(userId);
    if (session) {
        res.status(200).json(session);
    } else {
        res.status(404).send('Chat não encontrado.');
    }
}));

apiRouter.post('/chats/takeover/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;

    const attendant = ATTENDANTS.find(a => a.id === attendantId);
    if (!attendant) return res.status(404).send('Atendente não encontrado.');

    let session;
    let requestIndex = requestQueue.findIndex(r => r.userId === userId);

    if (requestIndex !== -1) {
        const request = requestQueue.splice(requestIndex, 1)[0];
        session = getSession(userId, request.userName);
    } else {
        session = getSession(userId);
    }
    
    if (!session) return res.status(404).send('Sessão do usuário não encontrada.');

    if (activeChats.has(userId)) {
        return res.status(409).send('Este chat já foi assumido por outro atendente.');
    }

    session.handledBy = 'human';
    session.attendantId = attendantId;
    activeChats.set(userId, session);
    userSessions.delete(userId); // Move de sessões de bot para ativas

    // ADAPTADO: Adiciona a mensagem de boas-vindas da lógica do usuário.
    const takeoverMessage = `Olá! Meu nome é *${attendant.name}* e vou continuar seu atendimento.`;
    outboundGatewayQueue.push({ userId, text: takeoverMessage });
    session.messageLog.push({ sender: 'system', text: `Atendimento assumido por ${attendant.name}.`, timestamp: new Date().toISOString() });
    session.messageLog.push({ sender: 'attendant', text: takeoverMessage.replace(/\*/g, ''), timestamp: new Date().toISOString() });

    console.log(`[Takeover] Atendente ${attendant.name} assumiu o chat com ${userId}.`);
    res.status(200).json({ 
        userId: session.userId, 
        userName: session.userName, 
        attendantId: session.attendantId 
    });
}));

apiRouter.post('/chats/attendant-reply', asyncHandler(async (req, res) => {
    const { userId, text, attendantId, files, replyTo } = req.body;

    // Validação robusta para prevenir crashes no servidor.
    const isValidFile = (f) => f && typeof f === 'object' && f.name && f.type && f.data;
    const validFiles = Array.isArray(files) ? files.filter(isValidFile) : [];

    if (!userId || (!text && validFiles.length === 0)) {
        return res.status(400).send('userId e um texto ou arquivos válidos são obrigatórios.');
    }

    const session = activeChats.get(userId);
    if (!session || session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para responder a este chat.');
    }

    const timestamp = new Date().toISOString();
    const fileLogs = validFiles.map(f => ({ ...f }));

    const newMessage = {
        sender: 'attendant',
        text,
        files: fileLogs,
        timestamp,
        replyTo,
        tempId: null, // Será definido se for uma mensagem de texto editável
    };

    // Lógica: Se houver texto, ele é enviado como uma mensagem separada e rastreável.
    if (text) {
        const tempId = `temp_${timestamp}`;
        newMessage.tempId = tempId; // Associa tempId à mensagem registrada
        outboundGatewayQueue.push({
            type: 'send',
            tempId,
            userId,
            text,
        });
    }

    if (validFiles.length > 0) {
        validFiles.forEach(file => {
            outboundGatewayQueue.push({
                type: 'send',
                tempId: null, // Arquivos não são rastreados para edição por enquanto
                userId,
                file,
                text: file.name
            });
        });
    }

    session.messageLog.push(newMessage);

    res.status(200).send('Mensagem(ns) enfileirada(s) para envio.');
}));


apiRouter.post('/chats/edit-message', asyncHandler(async (req, res) => {
    const { userId, attendantId, messageTimestamp, newText } = req.body;

    if (!userId || !attendantId || !messageTimestamp || newText === undefined) {
        return res.status(400).send('Dados insuficientes para editar a mensagem.');
    }

    const session = activeChats.get(userId);
    if (!session) {
        return res.status(404).send('Sessão do usuário não encontrada em chats ativos.');
    }
    if (session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para editar mensagens neste chat.');
    }

    const messageIndex = session.messageLog.findIndex(
        msg => msg.timestamp === messageTimestamp && msg.sender === 'attendant'
    );

    if (messageIndex > -1) {
        const messageToEdit = session.messageLog[messageIndex];
        
        // Atualização local para uma UI responsiva
        messageToEdit.text = newText;
        messageToEdit.edited = true;
        
        // Se temos o ID do WhatsApp, enfileiramos um comando de edição para o gateway
        if (messageToEdit.whatsappId) {
            outboundGatewayQueue.push({
                type: 'edit',
                userId,
                messageId: messageToEdit.whatsappId,
                newText,
            });
            console.log(`[Edit] Comando de edição enfileirado para a mensagem ${messageToEdit.whatsappId} do usuário ${userId}.`);
            res.status(200).send('Mensagem editada e atualização enfileirada.');
        } else {
            console.warn(`[Edit] Mensagem para ${userId} (timestamp: ${messageTimestamp}) editada localmente, mas não foi encontrado whatsappId. Pode ainda não ter sido enviada ou a confirmação falhou.`);
            res.status(200).send('Mensagem editada localmente (pode não ter sido enviada ainda).');
        }
    } else {
        console.warn(`[Edit] Tentativa de editar mensagem não encontrada para ${userId}. Timestamp: ${messageTimestamp}`);
        res.status(404).send('Mensagem original não encontrada para edição.');
    }
}));


apiRouter.post('/chats/transfer/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { newAttendantId, transferringAttendantId } = req.body;

    const session = activeChats.get(userId);
    if (!session || session.attendantId !== transferringAttendantId) {
        return res.status(403).send('Permissão negada ou chat não encontrado.');
    }
    const newAttendant = ATTENDANTS.find(a => a.id === newAttendantId);
    if (!newAttendant) return res.status(404).send('Atendente de destino não encontrado.');
    const oldAttendant = ATTENDANTS.find(a => a.id === transferringAttendantId);

    session.attendantId = newAttendantId;
    
    const transferMessage = `Atendimento transferido de ${oldAttendant?.name || 'atendente anterior'} para ${newAttendant.name}.`;
    session.messageLog.push({ sender: 'system', text: transferMessage, timestamp: new Date().toISOString() });
    
    // Notifica o cliente
    outboundGatewayQueue.push({ userId, text: `Você foi transferido(a) para o atendente *${newAttendant.name}*.` });

    console.log(`[Transfer] Chat ${userId} transferido de ${oldAttendant?.name} para ${newAttendant.name}.`);
    res.status(200).send('Transferência realizada com sucesso.');
}));

apiRouter.post('/chats/resolve/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    
    const session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) return res.status(404).send('Chat não encontrado.');

    const attendant = ATTENDANTS.find(a => a.id === attendantId);
    if (!attendant && session.handledBy === 'human') return res.status(404).send('Atendente não encontrado.');

    session.resolvedBy = attendant ? attendant.name : 'Sistema';
    session.resolvedAt = new Date().toISOString();
    
    archiveSession(session);
    activeChats.delete(userId);
    userSessions.delete(userId);
    
    const requestIndex = requestQueue.findIndex(r => r.userId === userId);
    if (requestIndex > -1) requestQueue.splice(requestIndex, 1);

    // Envia mensagem de finalização para o cliente
    outboundGatewayQueue.push({ userId, text: translations.pt.sessionEnded });

    console.log(`[Resolve] Chat com ${userId} resolvido por ${session.resolvedBy}.`);
    res.status(200).send('Chat resolvido com sucesso.');
}));

apiRouter.post('/chats/initiate', asyncHandler(async (req, res) => {
    const { recipientNumber, message, attendantId } = req.body;

    if (!recipientNumber || !message || !attendantId) {
        return res.status(400).send('Dados insuficientes para iniciar a conversa.');
    }
    
    const attendant = ATTENDANTS.find(a => a.id === attendantId);
    if (!attendant) return res.status(404).send('Atendente não encontrado.');

    if (activeChats.has(recipientNumber) || requestQueue.some(r => r.userId === recipientNumber)) {
        return res.status(409).send('Já existe uma conversa ativa ou na fila com este número.');
    }

    const userName = syncedContacts.find(c => c.userId === recipientNumber)?.userName || recipientNumber.split('@')[0];
    const session = getSession(recipientNumber, userName);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    const initMessage = { sender: 'attendant', text: message, timestamp: new Date().toISOString() };
    session.messageLog.push(initMessage);
    
    activeChats.set(recipientNumber, session);
    userSessions.delete(recipientNumber);

    outboundGatewayQueue.push({ userId: recipientNumber, text: message });
    console.log(`[Initiate] Atendente ${attendant.name} iniciou chat com ${recipientNumber}.`);
    
    res.status(201).json({
        userId: session.userId,
        userName: session.userName,
        attendantId: session.attendantId,
    });
}));

// --- ROTAS DE CHAT INTERNO ---
apiRouter.get('/internal-chats/summary/:attendantId', asyncHandler(async (req, res) => {
    const { attendantId } = req.params;
    const summary = {};

    internalChats.forEach((messages, chatKey) => {
        if (chatKey.includes(attendantId)) {
            const partnerId = chatKey.split('-').find(id => id !== attendantId);
            if (partnerId && messages.length > 0) {
                summary[partnerId] = {
                    lastMessage: messages[messages.length - 1]
                };
            }
        }
    });
    res.status(200).json(summary);
}));

apiRouter.get('/internal-chats/:senderId/:recipientId', asyncHandler(async (req, res) => {
    const { senderId, recipientId } = req.params;
    const chatKey1 = `${senderId}-${recipientId}`;
    const chatKey2 = `${recipientId}-${senderId}`;
    const messages = internalChats.get(chatKey1) || internalChats.get(chatKey2) || [];
    res.status(200).json(messages);
}));

apiRouter.post('/internal-chats', asyncHandler(async (req, res) => {
    const { senderId, recipientId, text, files, replyTo } = req.body;
    
    // FIX: Added robust validation for files to prevent crashes from malformed data.
    const isValidFile = (f) => f && typeof f === 'object' && f.name && f.type && f.data;
    const validFiles = Array.isArray(files) ? files.filter(isValidFile) : [];

    if (!senderId || !recipientId || (!text && validFiles.length === 0)) {
        return res.status(400).send('Dados da mensagem interna inválidos.');
    }

    const chatKey1 = `${senderId}-${recipientId}`;
    const chatKey2 = `${recipientId}-${senderId}`;
    const chatKey = internalChats.has(chatKey1) ? chatKey1 : chatKey2;
    
    if (!internalChats.has(chatKey)) {
        internalChats.set(chatKey, []);
    }
    
    const sender = ATTENDANTS.find(a => a.id === senderId);
    const newMessage = {
        senderId,
        senderName: sender ? sender.name : 'Desconhecido',
        text,
        files: validFiles,
        replyTo,
        timestamp: new Date().toISOString(),
    };
    internalChats.get(chatKey).push(newMessage);
    res.status(201).send('Mensagem interna enviada.');
}));

apiRouter.post('/internal-chats/edit-message', asyncHandler(async (req, res) => {
    const { senderId, recipientId, messageTimestamp, newText } = req.body;
    if (!senderId || !recipientId || !messageTimestamp || newText === undefined) {
        return res.status(400).send('Dados insuficientes para editar a mensagem interna.');
    }
    
    const chatKey1 = `${senderId}-${recipientId}`;
    const chatKey2 = `${recipientId}-${senderId}`;
    const chatKey = internalChats.has(chatKey1) ? chatKey1 : chatKey2;
    
    const messages = internalChats.get(chatKey);
    if (!messages) {
        return res.status(404).send('Chat interno não encontrado.');
    }
    
    const message = messages.find(m => m.timestamp === messageTimestamp && m.senderId === senderId);
    if (message) {
        message.text = newText;
        message.edited = true;
        res.status(200).send('Mensagem interna editada.');
    } else {
        res.status(404).send('Mensagem interna original não encontrada.');
    }
}));


// --- ROTAS DO GATEWAY ---
apiRouter.post('/whatsapp-webhook', asyncHandler(async (req, res) => {
    // A lógica de processamento agora é assíncrona e não bloqueia a resposta.
    processIncomingMessage(req.body).catch(err => {
        console.error('[FATAL] Erro não tratado no processamento de mensagem em segundo plano:', err);
    });
    // Responde imediatamente para o gateway não dar timeout
    res.status(200).json({ status: "received" });
}));


apiRouter.get('/gateway/poll-outbound', asyncHandler(async (req, res) => {
    if (outboundGatewayQueue.length > 0) {
        res.status(200).json(outboundGatewayQueue.splice(0)); // Envia e limpa a fila
    } else {
        res.status(204).send(); // No Content
    }
}));


apiRouter.post('/gateway/ack-message', asyncHandler(async (req, res) => {
    const { tempId, messageId, userId } = req.body;
    if (!tempId || !messageId || !userId) {
        return res.status(400).send('Dados de confirmação incompletos.');
    }
    const session = activeChats.get(userId);
    if (session) {
        const message = session.messageLog.find(msg => msg.tempId === tempId);
        if (message) {
            message.whatsappId = messageId;
            delete message.tempId;
            console.log(`[ACK] Mensagem para ${userId} confirmada com ID do WhatsApp: ${messageId}`);
        }
    }
    res.status(200).send('OK');
}));

apiRouter.post('/gateway/sync-contacts', asyncHandler(async (req, res) => {
    const { contacts } = req.body;
    if (Array.isArray(contacts)) {
        syncedContacts = contacts;
        console.log(`[Sync] Lista de contatos atualizada com ${contacts.length} contatos.`);
        res.status(200).send('Contatos sincronizados.');
    } else {
        res.status(400).send('Formato de contatos inválido.');
    }
}));

// --- REGISTRO DO ROTEADOR DA API ---
app.use('/api', apiRouter);

// --- SERVINDO ARQUIVOS ESTÁTICOS DA UI (Vite Build) ---
// Essencial para o modo de produção
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    // Rota Curinga: Redireciona todas as outras requisições para o index.html.
    // Isso é CRUCIAL para que o roteamento do lado do cliente (SPA) funcione corretamente.
    app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
    });
    console.log(`[Server] Servindo arquivos estáticos do diretório: ${distPath}`);
} else {
    console.warn(`[Server] AVISO: Diretório 'dist' não encontrado. A UI não será servida. Execute 'npm run build'.`);
}

// --- Middleware de Tratamento de Erros Global ---
// Deve ser o último middleware adicionado.
app.use((err, req, res, next) => {
  console.error(`[Error Handler] Ocorreu um erro na rota ${req.originalUrl}:`, err);
  res.status(500).send('Ocorreu um erro interno no servidor.');
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor rodando na porta ${port}. Versão: ${SERVER_VERSION}`);
    console.log(`[JZF Chatbot Server] Ambiente: ${process.env.NODE_ENV || 'development'}`);
});
