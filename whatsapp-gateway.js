// --- WHATSAPP GATEWAY UNIFICADO ---
// Este arquivo conecta-se ao WhatsApp usando @wppconnect e atua como uma ponte para o nosso servidor.

import wppconnect from '@wppconnect-team/wppconnect';
import fetch from 'node-fetch';

// IMPORTANTE: A URL do backend agora é configurada via variáveis de ambiente para segurança e flexibilidade.
// No ambiente da Render, crie uma variável de ambiente chamada BACKEND_URL com o valor da URL do seu serviço.
// Exemplo: 'https://chatbot-jzf-server.onrender.com'
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

if (!process.env.BACKEND_URL) {
  console.warn('AVISO: A variável de ambiente BACKEND_URL não está definida. Usando http://localhost:3000 como padrão. Isso pode não funcionar em produção.');
}

console.log(`Gateway iniciado. Tentando conectar ao backend em: ${BACKEND_URL}`);

// --- NOVA FUNÇÃO: Atualizar status no backend ---
async function updateBackendStatus(status, qrCode = null) {
    try {
        await fetch(`${BACKEND_URL}/api/gateway/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status, qrCode }),
        });
        console.log(`[Gateway] Status atualizado no backend: ${status}`);
    } catch (error) {
        // Ignora erros de conexão se o servidor principal ainda estiver subindo
        if (error.code !== 'ECONNREFUSED') {
            console.error('[Gateway] FALHA ao atualizar o status no backend:', error.message);
        }
    }
}


// Função para sincronizar contatos de forma robusta
const syncContacts = async (client) => {
  try {
    console.log('[Gateway] Iniciando sincronização de contatos do WhatsApp...');
    const allContacts = await client.getAllContacts();
    const formattedContacts = allContacts
      .filter(c => c.isUser && !c.isMe && c.id.server === 'c.us') // Apenas contatos de usuários
      .map(c => ({
        userId: c.id._serialized,
        userName: c.name || c.pushname || c.id.user,
      }));
    
    console.log(`[Gateway] Encontrados ${allContacts.length} contatos no total, ${formattedContacts.length} são usuários válidos para sincronização.`);

    const syncResponse = await fetch(`${BACKEND_URL}/api/gateway/sync-contacts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: formattedContacts })
    });
    
    if (syncResponse.ok) {
        console.log(`[Gateway] Sincronização BEM-SUCEDIDA de ${formattedContacts.length} contatos com o servidor.`);
    } else {
        console.error(`[Gateway] FALHA ao sincronizar contatos com o servidor. Status: ${syncResponse.status} - ${syncResponse.statusText}`);
    }

  } catch (error) {
    console.error('[Gateway] Erro CRÍTICO durante a sincronização de contatos:', error.message);
  }
};

// Avisa o backend que estamos iniciando o processo (status: LOADING)
updateBackendStatus('LOADING');

console.log('[Gateway] Inicializando wppconnect (criando sessão jzf-session-v2)...');

wppconnect
  .create({
    session: 'jzf-session-v2', // Nome alterado para forçar limpeza de cache e nova geração de QR
    catchQR: (base64Qr, asciiQR) => {
      console.log('[Gateway] >>> QR CODE GERADO COM SUCESSO <<<');
      console.log('[Gateway] Enviando QR Code para o painel...');
      updateBackendStatus('QR_CODE_READY', base64Qr);
    },
    statusFind: (statusSession, session) => {
        console.log(`[Gateway] Status da Sessão: ${statusSession}`);
        if (statusSession === 'isLogged' || statusSession === 'inChat' || statusSession === 'qrReadSuccess') {
            updateBackendStatus('CONNECTED');
        }
        if (statusSession === 'browserClose' || statusSession === 'autocloseCalled') {
            updateBackendStatus('DISCONNECTED');
        }
    },
    headless: true, // Mantém headless true para servidores
    devtools: false,
    useChrome: false,
    debug: false,
    logQR: false, // Desativado no terminal para não poluir, já que vai pro frontend
    browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // Adicionado para maior estabilidade em contêineres pequenos
        '--disable-gpu'
    ],
    disableWelcome: true,
    updatesLog: false,
    autoClose: 0,
  })
  .then((client) => {
    console.log('[Gateway] Cliente conectado com sucesso!');
    updateBackendStatus('CONNECTED');
    start(client);
    
    client.onStateChange((state) => {
        console.log('[Gateway] Estado da conexão mudou:', state);
        if (['CONFLICT', 'UNPAIRED', 'UNLAUNCHED'].includes(state)) {
            updateBackendStatus('DISCONNECTED');
            console.log('[Gateway] Conexão perdida. Fechando cliente...');
            client.close();
        }
    });

  })
  .catch((error) => {
      console.error('[Gateway] ERRO FATAL AO CRIAR CLIENTE:', error);
      updateBackendStatus('ERROR');
  });


async function start(client) {
  console.log('[Gateway] Loop principal iniciado.');
  
  // Sincroniza os contatos ao iniciar e depois periodicamente
  await syncContacts(client);
  setInterval(() => syncContacts(client), 15 * 60 * 1000); // Sincroniza a cada 15 minutos

  // Polling para buscar mensagens enviadas pelo atendente
  setInterval(async () => {
    try {
        const response = await fetch(`${BACKEND_URL}/api/gateway/poll-outbound`);
        if (response.status === 200) {
            const messages = await response.json();
            for (const msg of messages) {
                try {
                    if (msg.type === 'edit') {
                        console.log(`[Gateway] Editando mensagem ${msg.messageId} para ${msg.userId}`);
                        await client.editMessage(msg.userId, msg.messageId, msg.newText);
                    } else { // Trata 'send' e mensagens legadas sem tipo
                        let sentMessage;
                        if (msg.file && msg.file.data) {
                            console.log(`[Gateway] Enviando ARQUIVO para ${msg.userId}`);
                            const base64Data = `data:${msg.file.type};base64,${msg.file.data}`;
                            sentMessage = await client.sendFile(msg.userId, base64Data, msg.file.name, msg.text || '');
                        } else if (msg.text) {
                            console.log(`[Gateway] Enviando mensagem de texto para ${msg.userId}`);
                            sentMessage = await client.sendText(msg.userId, msg.text);
                        }

                        // Se a mensagem tinha um tempId, confirma o envio com o ID real do WhatsApp
                        if (sentMessage && msg.tempId) {
                            await fetch(`${BACKEND_URL}/api/gateway/ack-message`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    tempId: msg.tempId,
                                    messageId: sentMessage.id,
                                    userId: msg.userId,
                                }),
                            });
                        }
                    }
                } catch (e) {
                    console.error(`[Gateway] Erro ao processar comando de saída para ${msg.userId}:`, e.message);
                }
                await new Promise(r => setTimeout(r, 250)); // Pequeno delay entre envios
            }
        }
    } catch (error) {
        // Silencia erros de timeout ou conexão, pois são esperados em polling
        if (error.code !== 'ECONNRESET' && error.code !== 'ETIMEDOUT' && error.code !== 'ECONNREFUSED') {
           console.error('[Gateway] Erro ao buscar mensagens de saída:', error.message);
        }
    }
  }, 3000); // Verifica a cada 3 segundos

  client.onMessage(async (message) => {
    const hasContent = message.body || message.hasMedia || ['image', 'audio', 'ptt', 'video', 'document'].includes(message.type);
    if (message.isGroupMsg || message.from === 'status@broadcast' || !hasContent || message.fromMe) {
        return;
    }

    const userId = message.from;
    const userName = message.notifyName || message.sender.pushname || userId;
    
    let userInput = message.body || '';
    let filePayload = null;
    let gatewayError = false;
    let replyContext = null;

    if (message.quotedMsg) {
        replyContext = {
            text: message.quotedMsg.body || (message.quotedMsg.hasMedia ? `[Mídia: ${message.quotedMsg.type}]` : ''),
            fromMe: message.quotedMsg.fromMe,
        };
    }
    
    const isMedia = message.hasMedia || ['image', 'audio', 'ptt', 'video', 'document'].includes(message.type);

    if (isMedia) {
        userInput = message.caption || '';
        console.log(`[Gateway] Mídia detectada (${message.type}). Decriptando para ${userName}...`);
        try {
            const mediaBuffer = await client.decryptFile(message);
            
            if (mediaBuffer) {
                const base64Data = mediaBuffer.toString('base64');
                filePayload = {
                    name: message.filename || `${message.type}-${Date.now()}.${message.mimetype.split('/')[1] || 'bin'}`,
                    type: message.mimetype,
                    data: base64Data
                };
                console.log(`[Gateway] Mídia decriptada com sucesso: ${filePayload.name}`);
            } else {
                throw new Error("A descriptografia retornou um buffer vazio ou nulo.");
            }
        } catch (e) {
            console.error(`[Gateway] Erro CRÍTICO ao decriptar mídia de ${userName}:`, e.message);
            gatewayError = true;
            userInput = `[Mídia (${message.type}) não pôde ser carregada]`;
            filePayload = null;
        }
    }
    else if (typeof userInput === 'string' && userInput.startsWith('/9j/')) {
        console.warn(`[Gateway] Detectado vazamento de thumbnail em mensagem de texto para ${userName}. Bloqueando.`);
        userInput = `[Mídia (imagem) não pôde ser carregada]`;
        gatewayError = true;
        filePayload = null;
    }

    const payload = {
        userId,
        userName,
        userInput,
        file: filePayload,
        gatewayError,
        replyContext,
    };

    console.log(`Mensagem de ${userName} (${userId}) recebida. Encaminhando para o backend...`);
    
    try {
      const response = await fetch(`${BACKEND_URL}/api/whatsapp-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Erro no backend: ${response.status} ${response.statusText}. Resposta: ${errorBody}`);
      }
      
      const data = await response.json();
      
      if (data.replies && data.replies.length > 0) {
        console.log(`Backend respondeu. Enviando ${data.replies.length} mensagem(ns) para ${userId}...`);
        for (const replyText of data.replies) {
          await client.sendText(userId, replyText);
          await new Promise(r => setTimeout(r, 750)); 
        }
      }

    } catch (error) {
      console.error('Erro ao comunicar com o servidor de backend:', error);
    }
  });
}
