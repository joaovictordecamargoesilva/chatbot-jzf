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


const SERVER_VERSION = "19.0.0_FULL_HISTORY_AND_REPLY";
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
const pendingEdits = new Map(); // NOVO: Armazena edições que aguardam confirmação de envio


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
    // Pega o histórico existente ou cria um novo array
    const userHistory = archivedChats.get(session.userId) || [];
    // Adiciona a sessão atual ao histórico
    userHistory.push({ ...session });
    archivedChats.set(session.userId, userHistory);

    // Gerenciamento de memória: se o total de usuários arquivados exceder o limite, remove o mais antigo.
    if (archivedChats.size > MAX_ARCHIVED_CHATS) {
        const oldestKey = archivedChats.keys().next().value;
        archivedChats.delete(oldestKey);
        console.log(`[Memory] Limite de arquivos atingido. Histórico do usuário mais antigo (${oldestKey}) removido.`);
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
    const { userId, userName, userInput, file, gatewayError, replyContext } = body;
    
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

    // Cria a entrada de log
    const logEntry = {
        sender: 'user',
        text: userInput,
        timestamp: new Date().toISOString(),
    };

    // Adiciona informações do arquivo se existir
    if (file) {
        logEntry.file = { ...file };
    }

    // Adiciona o contexto da resposta se existir
    if (replyContext) {
        logEntry.replyTo = {
            text: replyContext.text,
            sender: replyContext.fromMe ? 'attendant' : 'user',
            senderName: replyContext.fromMe ? 'Você' : session.userName,
        };
    }

    // Salva a entrada completa no log
    session.messageLog.push(logEntry);

    // Lida com a transcrição de áudio após o log
    if (file && file.type && file.type.startsWith('audio/')) {
        const transcription = await transcribeAudio(file);
        effectiveInput = transcription; // Usa a transcrição como a entrada do usuário
        session.messageLog.push({ sender: 'system', text: `Transcrição do áudio: "${transcription}"`, timestamp: new Date().toISOString() });
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
    // Mapeia o histórico de cada usuário, pegando a última sessão para criar um resumo
    const history = Array.from(archivedChats.values()).map(sessionHistory => {
        // Pega a sessão mais recente do histórico deste usuário
        const lastSession = sessionHistory[sessionHistory.length - 1];
        return {
            userId: lastSession.userId,
            userName: lastSession.userName,
            attendantId: lastSession.attendantId,
            lastMessage: lastSession.messageLog[lastSession.messageLog.length - 1] || null,
            resolvedAt: lastSession.resolvedAt,
            resolvedBy: lastSession.resolvedBy
        };
    }).sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    res.status(200).json(history);
}));

apiRouter.get('/chats/history/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const currentSession = activeChats.get(userId) || userSessions.get(userId);
    const userHistory = archivedChats.get(userId) || [];

    if (!currentSession && userHistory.length === 0) {
        return res.status(404).send('Chat não encontrado.');
    }

    // Combina os logs de mensagens de todas as sessões (arquivadas e atual)
    const allSessions = [...userHistory, ...(currentSession ? [currentSession] : [])];
    let combinedLog = [];
    allSessions.forEach(s => {
        if (s && s.messageLog) {
            combinedLog = combinedLog.concat(s.messageLog);
        }
    });

    // Ordena as mensagens cronologicamente
    combinedLog.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Cria um objeto de sessão representativo para a resposta
    const representativeSession = currentSession || userHistory[userHistory.length - 1] || {};
    
    const responseData = {
        ...representativeSession,
        messageLog: combinedLog,
    };

    res.status(200).json(responseData);
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
    const { userId, text, attendantId, replyTo } = req.body;
    let { files } = req.body;
    
    // **FIX: Garante que 'files' seja sempre um array para evitar crashes.**
    if (files && !Array.isArray(files)) {
        files = [files];
    }
    
    if (!userId || (!text && (!files || files.length === 0))) {
        return res.status(400).send('userId e um texto ou arquivos são obrigatórios.');
    }

    const session = activeChats.get(userId);
    if (!session || session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para responder a este chat.');
    }

    const timestamp = new Date().toISOString();
    const fileLogs = files ? files.map(f => ({ ...f })) : [];

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

    if (files && files.length > 0) {
        files.forEach(file => {
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
    if (!session || session.handledBy !== 'human' || session.attendantId !== attendantId) {
        return res.status(403).send('Permissão negada para editar mensagens neste chat.');
    }

    const messageIndex = session.messageLog.findIndex(
        msg => msg.timestamp === messageTimestamp && msg.sender === 'attendant'
    );

    if (messageIndex > -1) {
        const messageToEdit = session.messageLog[messageIndex];
        
        const originalText = messageToEdit.text;
        messageToEdit.text = newText;
        messageToEdit.edited = true;
        
        if (messageToEdit.whatsappId) {
            outboundGatewayQueue.push({
                type: 'edit',
                userId,
                messageId: messageToEdit.whatsappId,
                newText,
            });
            console.log(`[Edit] Comando de edição enfileirado para a mensagem ${messageToEdit.whatsappId}.`);
            return res.status(200).send('Comando de edição enfileirado.');
        } else if (messageToEdit.tempId) {
            pendingEdits.set(messageToEdit.tempId, {
                newText,
                userId,
                timestamp: Date.now()
            });
            console.log(`[Edit] Edição para TempID ${messageToEdit.tempId} está pendente de confirmação de envio.`);
            return res.status(202).send('Edição pendente da confirmação de envio.');
        } else {
            messageToEdit.text = originalText;
            messageToEdit.edited = false;
            console.warn(`[Edit] Tentativa de editar mensagem sem ID (temp ou wpp) para ${userId}. Timestamp: ${messageTimestamp}`);
            return res.status(409).send('Não é possível editar esta mensagem pois seu ID de envio não foi encontrado.');
        }
    } else {
        console.warn(`[Edit] Tentativa de editar mensagem não encontrada para ${userId}. Timestamp: ${messageTimestamp}`);
        return res.status(404).send('Mensagem original não encontrada para edição.');
    }
}));


apiRouter.post('/chats/transfer/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { newAttendantId, transferringAttendantId } = req.body;

    const session = activeChats.get(userId);
    if (!session || session.attendantId !== transferringAttendantId) {
        return res.status(403).send('Permissão negada para transferir este chat.');
    }
    const newAttendant = ATTENDANTS.find(a => a.id === newAttendantId);
    if (!newAttendant) return res.status(404).send('Novo atendente não encontrado.');
    
    const oldAttendantName = ATTENDANTS.find(a => a.id === transferringAttendantId)?.name || 'Atendente anterior';

    session.attendantId = newAttendantId;
    const transferMessage = `Atendimento transferido de ${oldAttendantName} para ${newAttendant.name}.`;
    session.messageLog.push({ sender: 'system', text: transferMessage, timestamp: new Date().toISOString() });
    
    outboundGatewayQueue.push({ userId, text: `Você foi transferido para o atendente ${newAttendant.name}.` });
    
    res.status(200).json(session);
}));

apiRouter.post('/chats/resolve/:userId', asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { attendantId } = req.body;
    const session = activeChats.get(userId) || userSessions.get(userId);
    if (!session) return res.status(404).send('Chat não encontrado.');

    const attendant = ATTENDANTS.find(a => a.id === attendantId);

    session.resolvedAt = new Date().toISOString();
    session.resolvedBy = attendant ? attendant.name : 'Sistema';
    archiveSession(session);
    activeChats.delete(userId);
    userSessions.delete(userId);
    
    // Remove da fila, se estiver lá
    const queueIndex = requestQueue.findIndex(r => r.userId === userId);
    if (queueIndex > -1) requestQueue.splice(queueIndex, 1);
    
    outboundGatewayQueue.push({ userId, text: translations.pt.sessionEnded });
    console.log(`[Resolve] Chat com ${userId} foi resolvido e arquivado.`);
    res.status(200).send('Chat resolvido.');
}));

apiRouter.post('/chats/initiate', asyncHandler(async (req, res) => {
    const { recipientNumber, attendantId, message } = req.body;
    if (!recipientNumber || !attendantId || !message) {
        return res.status(400).send('Dados insuficientes para iniciar o chat.');
    }
    // O cliente pode não estar na lista de contatos, então usamos o número diretamente.
    const client = syncedContacts.find(c => c.userId === recipientNumber) || { userId: recipientNumber, userName: recipientNumber.split('@')[0] };

    const session = getSession(client.userId, client.userName);
    session.handledBy = 'human';
    session.attendantId = attendantId;
    
    const attendantName = ATTENDANTS.find(a => a.id === attendantId)?.name || 'Atendente';

    session.messageLog.push({ sender: 'system', text: `Conversa iniciada por ${attendantName}.`, timestamp: new Date().toISOString() });
    session.messageLog.push({ sender: 'attendant', text: message, timestamp: new Date().toISOString() });
    
    activeChats.set(client.userId, session);
    
    outboundGatewayQueue.push({ userId: client.userId, text: message });
    res.status(201).json({
        userId: session.userId,
        userName: session.userName,
        attendantId: session.attendantId,
    });
}));

// --- ROTAS DO CHAT INTERNO ---
apiRouter.get('/internal-chats/summary/:attendantId', asyncHandler(async (req, res) => {
    const { attendantId } = req.params;
    const summary = {};
    for (const [key, chat] of internalChats.entries()) {
        const participants = key.split('--');
        if (participants.includes(attendantId)) {
            const partnerId = participants.find(p => p !== attendantId);
            if (chat.length > 0) {
                summary[partnerId] = {
                    lastMessage: chat[chat.length - 1]
                };
            }
        }
    }
    res.status(200).json(summary);
}));

apiRouter.get('/internal-chats/:attendant1Id/:attendant2Id', asyncHandler(async (req, res) => {
    const { attendant1Id, attendant2Id } = req.params;
    const key = [attendant1Id, attendant2Id].sort().join('--');
    const chat = internalChats.get(key) || [];
    res.status(200).json(chat);
}));

apiRouter.post('/internal-chats', asyncHandler(async (req, res) => {
    const { senderId, recipientId, text, replyTo } = req.body;
    let { files } = req.body;

    // **FIX: Garante que 'files' seja sempre um array para evitar crashes.**
    if (files && !Array.isArray(files)) {
        files = [files];
    }
    
    if (!senderId || !recipientId || (!text && (!files || files.length === 0))) {
        return res.status(400).send('Dados insuficientes para enviar mensagem interna.');
    }
    const key = [senderId, recipientId].sort().join('--');
    if (!internalChats.has(key)) {
        internalChats.set(key, []);
    }
    const sender = ATTENDANTS.find(a => a.id === senderId);
    const newMessage = {
        senderId,
        senderName: sender?.name || 'Desconhecido',
        text,
        files,
        replyTo,
        timestamp: new Date().toISOString()
    };
    internalChats.get(key).push(newMessage);
    res.status(201).send('Mensagem interna enviada.');
}));

apiRouter.post('/internal-chats/edit-message', asyncHandler(async (req, res) => {
    const { senderId, recipientId, messageTimestamp, newText } = req.body;
    if (!senderId || !recipientId || !messageTimestamp || newText === undefined) {
        return res.status(400).send('Dados insuficientes para editar a mensagem.');
    }
    const key = [senderId, recipientId].sort().join('--');
    const chat = internalChats.get(key);
    if (!chat) {
        return res.status(404).send('Chat interno não encontrado.');
    }
    const messageIndex = chat.findIndex(m => m.timestamp === messageTimestamp && m.senderId === senderId);
    if (messageIndex > -1) {
        chat[messageIndex].text = newText;
        chat[messageIndex].edited = true;
        res.status(200).send('Mensagem interna editada.');
    } else {
        res.status(404).send('Mensagem interna para editar não encontrada.');
    }
}));


// --- ROTAS DO GATEWAY ---
apiRouter.post('/gateway/ack-message', asyncHandler(async (req, res) => {
    const { tempId, messageId, userId } = req.body;
    if (!tempId || !messageId || !userId) {
        return res.sendStatus(400);
    }
    
    const session = activeChats.get(userId);
    if (session) {
        for (let i = session.messageLog.length - 1; i >= 0; i--) {
            if (session.messageLog[i].tempId === tempId) {
                session.messageLog[i].whatsappId = messageId;
                console.log(`[ACK] Mensagem confirmada para ${userId}. TempID ${tempId} -> WppID ${messageId}`);
                
                if (pendingEdits.has(tempId)) {
                    const edit = pendingEdits.get(tempId);
                    outboundGatewayQueue.push({
                        type: 'edit',
                        userId: edit.userId,
                        messageId: messageId,
                        newText: edit.newText,
                    });
                    console.log(`[ACK] Executando edição pendente para TempID ${tempId}`);
                    pendingEdits.delete(tempId);
                }
                break;
            }
        }
    }
    res.sendStatus(200);
}));

apiRouter.post('/gateway/sync-contacts', asyncHandler(async (req, res) => {
    const { contacts } = req.body;
    if (Array.isArray(contacts)) {
        syncedContacts = contacts;
        console.log(`[Gateway] Contatos sincronizados: ${contacts.length} recebidos.`);
        res.status(200).send('Contatos sincronizados.');
    } else {
        res.status(400).send('Formato de contatos inválido.');
    }
}));

apiRouter.get('/gateway/poll-outbound', asyncHandler(async (req, res) => {
    if (outboundGatewayQueue.length > 0) {
        const messagesToSend = [...outboundGatewayQueue];
        outboundGatewayQueue.length = 0; // Limpa a fila
        res.status(200).json(messagesToSend);
    } else {
        res.status(204).send(); // No content
    }
}));

// --- ROTA DE WEBHOOK ---
apiRouter.post('/whatsapp-webhook', (req, res) => {
    res.status(200).json({ replies: [] });
    processIncomingMessage(req.body).catch(err => {
        console.error(`[FATAL] Erro não capturado no processamento de fundo do webhook para o usuário ${req.body?.userId}:`, err);
    });
});


app.use('/api', apiRouter);
console.log('[Server Setup] Rotas da API registradas em /api');

// --- VERIFICAÇÃO DE BUILD E SERVIR ARQUIVOS ESTÁTICOS ---
const staticFilesPath = path.resolve(__dirname, 'dist');
const indexPath = path.join(staticFilesPath, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('[FATAL STARTUP ERROR] O arquivo principal do frontend (dist/index.html) não foi encontrado.');
  console.error('Isso geralmente significa que o comando `npm run build` (ou `vite build`) falhou.');
  console.error('Verifique os logs de build para encontrar o erro e corrija-o antes de tentar o deploy novamente.');
  process.exit(1); // Encerra o processo com um código de erro.
}

app.use(express.static(staticFilesPath));
console.log(`[Server Setup] Servindo arquivos estáticos de: ${staticFilesPath}`);

// --- ROTA "CATCH-ALL" PARA SPA (Single Page Application) ---
app.get('*', (req, res) => {
    if (!req.originalUrl.startsWith('/api')) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Rota de API não encontrada.');
    }
});


// --- ERROR HANDLING E INICIALIZAÇÃO DO SERVIDOR ---
app.use((err, req, res, next) => {
  console.error("[FATAL ERROR HANDLER] Erro não tratado na rota:", {
      path: req.path,
      method: req.method,
      error: err.message,
      stack: err.stack,
  });
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'Algo deu terrivelmente errado no servidor!' });
});

// --- VERIFICADOR DE TIMEOUT DA FILA DE ATENDIMENTO ---
const checkRequestQueueTimeout = () => {
    const now = new Date();
    const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos

    for (let i = requestQueue.length - 1; i >= 0; i--) {
        const request = requestQueue[i];
        const requestAge = now - new Date(request.timestamp);

        if (requestAge > TIMEOUT_MS) {
            console.log(`[Timeout] A solicitação de ${request.userName} (${request.userId}) expirou.`);
            
            requestQueue.splice(i, 1); // Remove da fila

            const session = userSessions.get(request.userId);
            if (session) {
                // Notifica o usuário e reseta o estado dele
                const timeoutMessage = "Nossos atendentes parecem estar ocupados no momento. Enquanto você aguarda, você pode tentar falar com nosso assistente virtual ou escolher uma das opções abaixo novamente.";
                outboundGatewayQueue.push({ userId: request.userId, text: timeoutMessage });
                
                // Reseta a sessão e envia o menu de boas-vindas
                session.currentState = ChatState.GREETING;
                session.context = { history: {} };
                const greetingStep = conversationFlow.get(ChatState.GREETING);
                const formattedReply = formatFlowStepForWhatsapp(greetingStep, session.context);
                outboundGatewayQueue.push({ userId: request.userId, text: formattedReply });
            }
        }
    }
};

// Inicia o verificador de timeout
setInterval(checkRequestQueueTimeout, 30 * 1000); 
console.log('[Server Setup] Verificador de timeout da fila de atendimento iniciado.');

app.listen(port, () => {
    console.log(`[JZF Chatbot Server] Servidor escutando na porta ${port}.`);
    console.log('[JZF Chatbot Server] Servidor ONLINE e pronto para receber requisições.');
});
