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


const SERVER_VERSION = "18.2.0_MESSAGE_EDIT_FIX";
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
function archiveSession(session
