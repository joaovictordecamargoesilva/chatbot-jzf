import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    downloadMediaMessage, 
    makeCacheableSignalKeyStore 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fetch from 'node-fetch';
import fs from 'fs';

// --- CONFIGURAÇÃO ---
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const SESSION_FOLDER = 'baileys_auth_info';

// --- HELPER: Atualizar Status no Backend ---
async function updateBackendStatus(status, qrCode = null) {
    try {
        await fetch(`${BACKEND_URL}/api/gateway/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, qrCode }),
        });
        console.log(`[Gateway] Status atualizado: ${status}`);
    } catch (error) {
        if (error.code !== 'ECONNREFUSED') console.error('[Gateway] Falha ao atualizar status:', error.message);
    }
}

// --- FUNÇÃO PRINCIPAL ---
async function startSock() {
    // Avisa que está carregando
    updateBackendStatus('LOADING');

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`[Gateway] Iniciando Baileys v${version.join('.')}...`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Reduz logs no terminal
        printQRInTerminal: true, // Útil para debug local
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: ['JZF Atendimento', 'Chrome', '1.0.0'], // Nome que aparece no WhatsApp do celular
        generateHighQualityLinkPreview: true,
    });

    // Salva as credenciais sempre que atualizarem (login, novas chaves, etc)
    sock.ev.on('creds.update', saveCreds);

    // Gerencia a conexão e QR Code
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('[Gateway] QR Code recebido do WhatsApp.');
            try {
                const url = await QRCode.toDataURL(qr);
                updateBackendStatus('QR_CODE_READY', url);
            } catch (err) {
                console.error('[Gateway] Erro ao gerar imagem do QR Code:', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[Gateway] Conexão fechada. Reconectar?', shouldReconnect);
            updateBackendStatus('DISCONNECTED');
            
            if (shouldReconnect) {
                setTimeout(startSock, 2000); // Tenta reconectar em 2s
            } else {
                console.log('[Gateway] Desconectado pelo celular. Limpando sessão...');
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                setTimeout(startSock, 2000); // Reinicia para gerar novo QR
            }
        } else if (connection === 'open') {
            console.log('[Gateway] CONEXÃO ESTABELECIDA COM SUCESSO!');
            updateBackendStatus('CONNECTED');
        }
    });

    // Gerencia Mensagens Recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.fromMe) continue; // Ignora mensagens enviadas por mim (via celular)

            const userId = msg.key.remoteJid;
            const userName = msg.pushName || userId.split('@')[0];
            
            let userInput = '';
            let filePayload = null;
            let gatewayError = false;
            let replyContext = null;

            // Identifica o tipo de mensagem
            const messageType = Object.keys(msg.message)[0];
            const messageContent = msg.message[messageType];

            // Extrai texto e contexto
            if (messageType === 'conversation') {
                userInput = msg.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                userInput = msg.message.extendedTextMessage.text;
                
                // Verifica se é uma resposta a outra mensagem
                const contextInfo = msg.message.extendedTextMessage.contextInfo;
                if (contextInfo && contextInfo.quotedMessage) {
                     const quoted = contextInfo.quotedMessage;
                     const quotedBody = quoted.conversation || quoted.extendedTextMessage?.text || (quoted.imageMessage ? '[Imagem]' : '[Mídia]');
                     replyContext = {
                         text: quotedBody,
                         fromMe: contextInfo.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net' 
                     };
                }
            } else if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(messageType)) {
                // Mídia recebida
                userInput = messageContent.caption || ''; // Legenda da imagem/vídeo
                try {
                    console.log(`[Gateway] Baixando mídia (${messageType}) de ${userName}...`);
                    const buffer = await downloadMediaMessage(
                        msg,
                        'buffer',
                        { logger: pino({ level: 'silent' }) }
                    );
                    filePayload = {
                        name: `${messageType}.${messageContent.mimetype.split('/')[1] || 'bin'}`,
                        type: messageContent.mimetype,
                        data: buffer.toString('base64')
                    };
                } catch (err) {
                    console.error('[Gateway] Erro ao baixar mídia:', err);
                    gatewayError = true;
                    userInput = '[Erro ao baixar mídia]';
                }
            }

            if (!userInput && !filePayload) continue; // Ignora mensagens vazias/desconhecidas

            const payload = {
                userId,
                userName,
                userInput,
                file: filePayload,
                gatewayError,
                replyContext
            };

            // Envia para o webhook do servidor
            try {
                const response = await fetch(`${BACKEND_URL}/api/whatsapp-webhook`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                // Processa respostas imediatas (se houver)
                const data = await response.json();
                if (data.replies && data.replies.length > 0) {
                    for (const replyText of data.replies) {
                        await sock.sendMessage(userId, { text: replyText });
                    }
                }
            } catch (err) {
                console.error('[Gateway] Erro ao enviar para webhook:', err.message);
            }
        }
    });

    // --- POLLING DE MENSAGENS DE SAÍDA ---
    // Busca periodicamente mensagens que o backend quer enviar
    setInterval(async () => {
        try {
            const response = await fetch(`${BACKEND_URL}/api/gateway/poll-outbound`);
            if (response.status === 200) {
                const messages = await response.json();
                
                for (const msg of messages) {
                    try {
                        let sentMsg;
                        
                        // 1. Edição de Mensagem
                        if (msg.type === 'edit') {
                             // O Baileys precisa do ID original para editar
                             await sock.sendMessage(msg.userId, { 
                                 text: msg.newText, 
                                 edit: { remoteJid: msg.userId, fromMe: true, id: msg.messageId } 
                             });
                        
                        // 2. Envio de Mídia (Arquivo/Imagem/Áudio)
                        } else if (msg.file && msg.file.data) {
                            const buffer = Buffer.from(msg.file.data, 'base64');
                            const mimetype = msg.file.type;

                            if (mimetype.startsWith('image/')) {
                                sentMsg = await sock.sendMessage(msg.userId, { image: buffer, caption: msg.text });
                            } else if (mimetype.startsWith('video/')) {
                                sentMsg = await sock.sendMessage(msg.userId, { video: buffer, caption: msg.text });
                            } else if (mimetype.startsWith('audio/')) {
                                sentMsg = await sock.sendMessage(msg.userId, { audio: buffer, mimetype });
                            } else {
                                sentMsg = await sock.sendMessage(msg.userId, { 
                                    document: buffer, 
                                    mimetype, 
                                    fileName: msg.file.name,
                                    caption: msg.text 
                                });
                            }

                        // 3. Envio de Texto Simples
                        } else if (msg.text) {
                            sentMsg = await sock.sendMessage(msg.userId, { text: msg.text });
                        }

                        // Confirmação de envio (ACK) para o Backend
                        if (sentMsg && msg.tempId) {
                            await fetch(`${BACKEND_URL}/api/gateway/ack-message`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    tempId: msg.tempId,
                                    messageId: sentMsg.key.id,
                                    userId: msg.userId,
                                }),
                            });
                        }
                    } catch (e) {
                        console.error(`[Gateway] Erro ao enviar mensagem para ${msg.userId}:`, e.message);
                    }
                    await new Promise(r => setTimeout(r, 300)); // Delay suave para evitar bloqueio
                }
            }
        } catch (error) {
             // Erros de polling são normais se o backend reiniciar
        }
    }, 1000); // Verifica a cada 1 segundo para resposta rápida
}

// Inicia o Gateway
startSock();
