import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    downloadMediaMessage 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

// --- CONFIGURAÇÃO ---
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
// CRÍTICO: Usamos um nome de pasta novo para limpar qualquer sessão antiga travada e forçar novo QR
const SESSION_FOLDER = path.join(process.cwd(), 'baileys_session_clean_v6');

// --- HELPER: Atualizar Status no Backend ---
async function updateBackendStatus(status, qrCode = null) {
    try {
        console.log(`[Gateway] Enviando status para backend: ${status}`);
        await fetch(`${BACKEND_URL}/api/gateway/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, qrCode }),
        });
    } catch (error) {
        // Ignora erros de conexão se o backend estiver reiniciando
        if (error.code !== 'ECONNREFUSED') console.error('[Gateway] Aviso: Backend indisponível momentaneamente.');
    }
}

// --- FUNÇÃO PRINCIPAL ---
async function startSock() {
    console.log('---------------------------------------------------');
    console.log('[Gateway] Iniciando nova instância do WhatsApp (Baileys) [VANILLA MODE]...');
    console.log(`[Gateway] Diretório de sessão: ${SESSION_FOLDER}`);
    
    await updateBackendStatus('LOADING');

    // Prepara autenticação da forma mais simples possível (igual ao CAR CLASS)
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log(`[Gateway] Versão do Baileys: v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        // Mantendo a configuração de browser EXATAMENTE igual ao exemplo que funciona
        browser: ['CARCLASS', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('[Gateway] QR CODE RECIBIDO DO BAILEYS');
            try {
                const url = await QRCode.toDataURL(qr);
                await updateBackendStatus('QR_CODE_READY', url);
                console.log('[Gateway] QR Code enviado para o frontend.');
            } catch (err) {
                console.error('[Gateway] Erro ao processar imagem QR:', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`[Gateway] Conexão fechada. Reconectar: ${shouldReconnect}`);
            
            await updateBackendStatus('DISCONNECTED');
            
            if (shouldReconnect) {
                setTimeout(startSock, 3000);
            } else {
                console.log('[Gateway] Desconectado. Limpando sessão...');
                fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
                setTimeout(startSock, 1000);
            }
        } else if (connection === 'open') {
            console.log('[Gateway] >>> CONECTADO AO WHATSAPP! <<<');
            await updateBackendStatus('CONNECTED');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const userId = msg.key.remoteJid;
            const userName = msg.pushName || userId.split('@')[0];
            
            let userInput = '';
            let filePayload = null;
            let replyContext = null;

            const messageType = Object.keys(msg.message)[0];
            const messageContent = msg.message[messageType];

            if (messageType === 'conversation') {
                userInput = msg.message.conversation;
            } else if (messageType === 'extendedTextMessage') {
                userInput = msg.message.extendedTextMessage.text;
                const contextInfo = msg.message.extendedTextMessage.contextInfo;
                if (contextInfo && contextInfo.quotedMessage) {
                     const quoted = contextInfo.quotedMessage;
                     const quotedBody = quoted.conversation || quoted.extendedTextMessage?.text || (quoted.imageMessage ? '[Imagem]' : '[Mídia]');
                     replyContext = {
                         text: quotedBody,
                         fromMe: contextInfo.participant === sock.user.id.split(':')[0] + '@s.whatsapp.net' 
                     };
                }
            } else if (['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].includes(messageType)) {
                userInput = messageContent.caption || '';
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', { logger: pino({ level: 'silent' }) });
                    filePayload = {
                        name: `${messageType}.${messageContent.mimetype.split('/')[1] || 'bin'}`,
                        type: messageContent.mimetype,
                        data: buffer.toString('base64')
                    };
                } catch (err) {
                    console.error('[Gateway] Erro ao baixar mídia:', err);
                    userInput = '[Erro ao baixar mídia]';
                }
            }

            if (!userInput && !filePayload) continue;

            try {
                await fetch(`${BACKEND_URL}/api/whatsapp-webhook`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, userName, userInput, file: filePayload, replyContext })
                });
            } catch (err) {
                console.error('[Gateway] Erro webhook:', err.message);
            }
        }
    });

    // Polling simples
    setInterval(async () => {
        try {
            const res = await fetch(`${BACKEND_URL}/api/gateway/poll-outbound`);
            if (res.status === 200) {
                const messages = await res.json();
                for (const msg of messages) {
                    try {
                        await new Promise(r => setTimeout(r, 500));
                        
                        if (msg.type === 'edit') {
                             await sock.sendMessage(msg.userId, { 
                                 text: msg.newText, 
                                 edit: { remoteJid: msg.userId, fromMe: true, id: msg.messageId } 
                             });
                        } else if (msg.file && msg.file.data) {
                            const buffer = Buffer.from(msg.file.data, 'base64');
                            const mimetype = msg.file.type;
                            const options = { caption: msg.text };
                            
                            if (mimetype.startsWith('image/')) await sock.sendMessage(msg.userId, { image: buffer, ...options });
                            else if (mimetype.startsWith('video/')) await sock.sendMessage(msg.userId, { video: buffer, ...options });
                            else if (mimetype.startsWith('audio/')) await sock.sendMessage(msg.userId, { audio: buffer, mimetype });
                            else await sock.sendMessage(msg.userId, { document: buffer, mimetype, fileName: msg.file.name, ...options });
                        } else if (msg.text) {
                            const sent = await sock.sendMessage(msg.userId, { text: msg.text });
                            if (sent && msg.tempId) {
                                await fetch(`${BACKEND_URL}/api/gateway/ack-message`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ tempId: msg.tempId, messageId: sent.key.id, userId: msg.userId }),
                                });
                            }
                        }
                    } catch (e) {
                        console.error(`[Gateway] Falha no envio:`, e.message);
                    }
                }
            }
        } catch (error) { }
    }, 1000);
}

startSock();
