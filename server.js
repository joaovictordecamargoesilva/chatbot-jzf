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


const SERVER_VERSION = "18.3.0_DEPLOY_FIX";
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
const updateListeners = new Map(); // Para long-polling


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
function notifyUpdates(attendantId = null) {
  // Notifica um atendente específico ou todos
  const attendantIdsToNotify = attendantId ? [attendantId] : Array.from(updateListeners.keys());

  for (const id of attendantIdsToNotify) {
      const listeners = updateListeners.get(id) || [];
      const data = {
          activeChats: Array.from(activeChats.values()),
          archivedChats: Array.from(archivedChats.values()),
          internalChats: Array.from(internalChats.values()),
          timestamp: Date.now()
      };
      while (listeners.length > 0) {
          const res = listeners.pop();
          res.json(data);
      }
      updateListeners.set(id, []);
  }
}

function addMessageToLog(userId, message) {
    if (activeChats.has(userId)) {
        const chat = activeChats.get(userId);
        chat.messageLog.push(message);
        chat.lastUpdate = Date.now();
        notifyUpdates(chat.attendantId);
    }
}

// --- ROTAS DE API PARA O FRONTEND ---

// Endpoint de long-polling para atualizações em tempo real
app.get('/api/chats/updates', (req, res) => {
    const { attendantId } = req.query;
    if (!attendantId) {
        return res.status(400).json({ error: 'attendantId é obrigatório' });
    }

    if (!updateListeners.has(attendantId)) {
        updateListeners.set(attendantId, []);
    }
    updateListeners.get(attendantId).push(res);

    // Timeout para fechar a conexão se nada acontecer
    res.on('close', () => {
        const listeners = updateListeners.get(attendantId) || [];
        const index = listeners.indexOf(res);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    });
});

app.get('/api/attendants', (req, res) => {
    res.json(ATTENDANTS);
});

app.get('/api/chats', (req, res) => {
    res.json(Array.from(activeChats.values()));
});

app.get('/api/archived-chats', (req, res) => {
    res.json(Array.from(archivedChats.values()));
});

app.post('/api/chats/attendant-login', (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Nome do atendente é obrigatório.' });
    }
    let attendant = ATTENDANTS.find(a => a.name.toLowerCase() === name.toLowerCase());
    if (!attendant) {
        attendant = { id: String(nextAttendantId++), name };
        ATTENDANTS.push(attendant);
    }
    res.status(200).json(attendant);
});

app.post('/api/chats/attendant-reply', (req, res) => {
    const { userId, text, attendantId, files, replyTo } = req.body;
    if (!userId || !attendantId) return res.status(400).json({ error: 'Faltam dados essenciais.' });

    const tempId = `temp_${Date.now()}_${Math.random()}`;
    const message = {
        sender: 'attendant',
        text: text,
        timestamp: Date.now(),
        files: files || [],
        replyTo: replyTo || null,
        tempId: tempId
    };

    addMessageToLog(userId, message);

    // Correção de bug: Certifica-se de que `files` é um array antes de mapear.
    const filesToSend = Array.isArray(files) ? files.map(f => ({ name: f.name, type: f.type, data: f.data })) : [];

    outboundGatewayQueue.push({
        type: 'send',
        userId,
        text,
        file: filesToSend[0], // Gateway atual suporta um arquivo por vez
        tempId
    });

    res.status(200).json({ success: true });
});

app.post('/api/chats/edit-message', async (req, res) => {
    const { userId, messageTimestamp, newText } = req.body;
    if (!userId || !messageTimestamp || !newText) return res.status(400).send();

    const chat = activeChats.get(userId);
    if (!chat) return res.status(404).send();

    const messageIndex = chat.messageLog.findIndex(m => m.timestamp === messageTimestamp);
    if (messageIndex === -1) return res.status(404).send();
    
    const message = chat.messageLog[messageIndex];
    if (message.sender !== 'attendant' || !message.id) {
        return res.status(403).json({ error: "Só é possível editar mensagens enviadas por você que já foram confirmadas pelo WhatsApp." });
    }

    chat.messageLog[messageIndex].text = newText;
    chat.messageLog[messageIndex].edited = true;
    chat.lastUpdate = Date.now();

    outboundGatewayQueue.push({
        type: 'edit',
        userId,
        messageId: message.id,
        newText
    });
    
    notifyUpdates(chat.attendantId);
    res.status(200).json({ success: true });
});

app.post('/api/chats/resolve', (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send();
    if (activeChats.has(userId)) {
        const chat = activeChats.get(userId);
        archivedChats.set(userId, chat);
        activeChats.delete(userId);
        userSessions.delete(userId); // Limpa a sessão do bot
        notifyUpdates(chat.attendantId);
    }
    res.status(200).json({ success: true });
});

// ... outras rotas como transfer, takeover ...

// --- ROTAS PARA O GATEWAY ---

app.post('/api/gateway/sync-contacts', (req, res) => {
    const { contacts } = req.body;
    if (Array.isArray(contacts)) {
        syncedContacts = contacts;
        console.log(`[Server] Contatos sincronizados: ${contacts.length} contatos recebidos.`);
        res.status(200).json({ success: true, count: contacts.length });
    } else {
        res.status(400).json({ error: 'Formato de contatos inválido.' });
    }
});

app.get('/api/gateway/poll-outbound', (req, res) => {
    if (outboundGatewayQueue.length > 0) {
        const messages = [...outboundGatewayQueue];
        outboundGatewayQueue.length = 0; // Esvazia a fila
        res.status(200).json(messages);
    } else {
        res.status(204).send(); // No content
    }
});

app.post('/api/gateway/ack-message', (req, res) => {
    const { tempId, messageId, userId } = req.body;
    if (activeChats.has(userId)) {
        const chat = activeChats.get(userId);
        const message = chat.messageLog.find(m => m.tempId === tempId);
        if (message) {
            delete message.tempId;
            message.id = messageId;
            notifyUpdates(chat.attendantId);
        }
    }
    res.status(200).send();
});


// --- WEBHOOK PRINCIPAL DO WHATSAPP ---
app.post('/api/whatsapp-webhook', async (req, res) => {
    // A lógica de processamento de mensagens do webhook vai aqui...
    // Esta é uma implementação simplificada para garantir que a rota exista.
    const { userId, userName, userInput, file } = req.body;

    console.log(`[Webhook] Mensagem recebida de ${userName} (${userId})`);

    if (!activeChats.has(userId)) {
        activeChats.set(userId, {
            userId,
            userName,
            messageLog: [],
            lastUpdate: Date.now(),
            handledBy: 'bot', // Começa com o bot
            attendantId: null,
        });
    }

    const message = {
        sender: 'user',
        text: userInput,
        timestamp: Date.now(),
        files: file ? [file] : [],
    };
    addMessageToLog(userId, message);

    // Simula uma resposta do bot para teste
    const botReply = {
        sender: 'bot',
        text: `Recebi sua mensagem: "${userInput}". O bot está em desenvolvimento.`,
        timestamp: Date.now(),
        files: [],
    };
    addMessageToLog(userId, botReply);

    res.status(200).json({ replies: [] }); // Responde sem enviar nada de volta pelo webhook
});


// --- SERVIR ARQUIVOS ESTÁTICOS DO FRONTEND (VITE BUILD) ---
// Essencial para o deploy em produção.

// 1. Define o caminho para a pasta 'dist' onde os arquivos do build estão.
const staticFilesPath = path.join(__dirname, 'dist');

// 2. Usa o middleware do Express para servir os arquivos estáticos (JS, CSS, imagens).
app.use(express.static(staticFilesPath));

// 3. Rota "catch-all" para Single Page Applications (SPA).
// Qualquer requisição que não corresponda a uma API ou a um arquivo estático,
// serve o 'index.html' principal. Isso permite que o roteamento do React funcione.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});


// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`[JZF Chatbot Server] Servidor rodando na porta ${port}`);
  console.log(`[JZF Chatbot Server] Aponte o Gateway para: http://localhost:${port}`);
});
