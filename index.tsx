import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { conversationFlow, translations, ChatState as ChatStateValues } from './chatbotLogic.js';

// --- START: Merged from types.ts ---
const Sender = {
  USER: 'user',
  BOT: 'bot',
  ATTENDANT: 'attendant',
  SYSTEM: 'system', // Adicionado para mensagens de sistema (ex: transferências)
};

const ChatState = ChatStateValues;
// --- END: Merged from types.ts ---


// --- START: Merged from components/TypingIndicator.tsx ---
const TypingIndicator = () => (
  <div className="flex items-center space-x-1.5 p-4 self-start">
    <span className="sr-only">Bot está digitando</span>
    <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
    <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
    <div className="h-2 w-2 bg-gray-400 rounded-full animate-bounce"></div>
  </div>
);
// --- END: Merged from components/TypingIndicator.tsx ---


// --- START: Merged from components/MessageBubble.tsx ---
const MessageBubble = ({ message }) => {
  const isBot = message.sender === Sender.BOT;
  const isAttendant = message.sender === Sender.ATTENDANT;
  const isSystem = message.sender === Sender.SYSTEM;

  if (isSystem) {
    return (
      <div className="flex justify-center w-full">
        <div className="text-xs text-white bg-gray-500 bg-opacity-70 rounded-full px-3 py-1 my-1">
          {message.text}
        </div>
      </div>
    );
  }

  const bubbleClasses = isBot
    ? 'bg-white text-gray-800 self-start'
    : isAttendant
    ? 'bg-blue-100 text-gray-800 self-end'
    : 'bg-[#dcf8c6] text-gray-800 self-end';

  const justifyClass = isBot ? 'justify-start' : 'justify-end';

  return (
    <div className={`flex w-full ${justifyClass}`}>
      <div
        className={`max-w-md md:max-w-lg lg:max-w-xl p-2 rounded-lg shadow-sm mb-1 flex flex-col ${bubbleClasses}`}
      >
        <div className="text-sm whitespace-pre-wrap">{message.text}</div>
        {message.file && (
            <div className="mt-2 p-2 bg-gray-100 rounded-lg flex items-center space-x-2 border border-gray-200">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" />
                    <path d="M8 8.5a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5zm0 2a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5z" />
                </svg>
                <span className="text-xs text-gray-700 truncate">{message.file.name}</span>
            </div>
        )}
        <div className="text-xs text-gray-400 self-end mt-1">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
};
// --- END: Merged from components/MessageBubble.tsx ---


// --- START: Merged from components/ChatPanel.tsx ---
const ChatPanel = ({
  selectedChat,
  attendant,
  onSendMessage,
  onResolveChat,
  onTransferChat,
  onTakeoverChat, // Nova prop
  isLoading,
  attendants,
}) => {
  const [message, setMessage] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [isTransferModalOpen, setTransferModalOpen] = useState(false);
  const [transferToAttendantId, setTransferToAttendantId] = useState('');
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  
  const chatType = selectedChat?.handledBy === 'bot' ? 'bot' : 'human';


  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [selectedChat?.messageLog, isLoading]);
  
  useEffect(() => {
     setMessage(''); // Limpa o campo de mensagem ao trocar de chat
     setSelectedFile(null);
  }, [selectedChat?.userId]);
  
  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file) {
        if (file.size > 15 * 1024 * 1024) { // Limite de 15MB
            alert("O arquivo é muito grande. O limite é de 15MB.");
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            // FIX: Add a type check to ensure `e.target.result` is a string.
            // The result of FileReader can be an ArrayBuffer, which doesn't have a .split() method.
            if (e.target && typeof e.target.result === 'string') {
                const base64Data = e.target.result.split(',')[1];
                setSelectedFile({
                    name: file.name,
                    type: file.type,
                    data: base64Data
                });
            }
        };
        reader.readAsDataURL(file);
    }
    event.target.value = null; // Reseta para poder selecionar o mesmo arquivo novamente
  };


  const handleSend = () => {
    if ((message.trim() || selectedFile) && selectedChat && attendant) {
      onSendMessage(selectedChat.userId, message.trim(), attendant.id, selectedFile);
      setMessage('');
      setSelectedFile(null);
    }
  };

  const handleTransfer = () => {
    if (transferToAttendantId) {
      onTransferChat(selectedChat.userId, transferToAttendantId);
      setTransferModalOpen(false);
      setTransferToAttendantId('');
    }
  };
  
  if (!selectedChat) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-gray-100 text-gray-500">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <span>Selecione um atendimento na lista para começar.</span>
      </div>
    );
  }
  
  const currentAttendant = attendants.find(a => a.id === selectedChat.attendantId);

  return (
    <div className="flex-1 flex flex-col bg-gray-100">
      {/* Cabeçalho do Chat */}
      <header className="bg-white p-3 border-b border-gray-200 flex justify-between items-center shadow-sm">
        <div>
            <h2 className="font-semibold text-gray-800">{selectedChat.userName || selectedChat.userId}</h2>
            {chatType === 'human' && currentAttendant && <p className="text-xs text-gray-500">Atendido por: {currentAttendant.name}</p>}
            {chatType === 'bot' && <p className="text-xs text-blue-500">Em atendimento com o Assistente Virtual</p>}
        </div>
        
        <div className="flex items-center space-x-2">
            {chatType === 'bot' && attendant && (
                 <button
                  onClick={() => onTakeoverChat(selectedChat.userId)}
                  className="px-3 py-1.5 text-xs font-medium text-center text-white bg-purple-600 rounded-lg hover:bg-purple-700 focus:ring-4 focus:outline-none focus:ring-purple-300 transition-colors"
                  aria-label="Assumir Atendimento"
                >
                  Assumir Atendimento
                </button>
            )}

            {chatType === 'human' && attendant?.id === selectedChat.attendantId && (
                <button
                  onClick={() => setTransferModalOpen(true)}
                  className="px-3 py-1.5 text-xs font-medium text-center text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:ring-4 focus:outline-none focus:ring-blue-300 transition-colors"
                  aria-label="Transferir Atendimento"
                >
                  Transferir
                </button>
            )}

            {((chatType === 'human' && attendant?.id === selectedChat.attendantId) || chatType === 'bot') && attendant && (
                <button
                  onClick={() => onResolveChat(selectedChat.userId)}
                  className="px-3 py-1.5 text-xs font-medium text-center text-white bg-green-600 rounded-lg hover:bg-green-700 focus:ring-4 focus:outline-none focus:ring-green-300 transition-colors"
                  aria-label="Resolver Atendimento"
                >
                  Resolver
                </button>
            )}
        </div>
      </header>

      {/* Corpo do Chat */}
      <div className="flex-1 overflow-y-auto p-4 whatsapp-bg">
        {selectedChat.messageLog.map((msg, index) => (
          <MessageBubble key={index} message={msg} />
        ))}
        {isLoading && <TypingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      {/* Rodapé do Chat (Input) */}
      {chatType === 'human' && attendant?.id === selectedChat.attendantId && (
          <footer className="bg-gray-200 p-3">
             {/* Preview do arquivo selecionado */}
            {selectedFile && (
                <div className="p-2 mb-2 bg-blue-100 rounded-lg flex items-center justify-between text-sm shadow-sm border border-blue-200">
                    <div className="flex items-center space-x-2 truncate">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-blue-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                           <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" />
                        </svg>
                        <span className="text-gray-700 truncate">{selectedFile.name}</span>
                    </div>
                    <button onClick={() => setSelectedFile(null)} className="text-red-500 hover:text-red-700 font-bold text-lg leading-none" aria-label="Remover arquivo">&times;</button>
                </div>
            )}
            <div className="flex items-center bg-white rounded-full shadow-sm px-2">
              <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" />
              <button 
                onClick={() => fileInputRef.current.click()}
                className="p-2 text-gray-500 hover:text-blue-600 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-400"
                aria-label="Anexar arquivo"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              </button>
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Digite sua mensagem..."
                className="w-full p-2 bg-transparent focus:outline-none"
                aria-label="Campo de mensagem"
              />
              <button
                onClick={handleSend}
                disabled={!message.trim() && !selectedFile}
                className="p-2 text-blue-600 hover:text-blue-800 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:text-gray-400"
                aria-label="Enviar mensagem"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              </button>
            </div>
          </footer>
      )}
      
       {/* Modal de Transferência */}
      {isTransferModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" aria-modal="true" role="dialog">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-4">Transferir Atendimento</h3>
            <p className="text-sm text-gray-600 mb-2">Selecione o atendente para quem deseja transferir:</p>
            <select
              value={transferToAttendantId}
              onChange={(e) => setTransferToAttendantId(e.target.value)}
              className="w-full p-2 border border-gray-300 rounded-md mb-4 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="" disabled>Selecione...</option>
              {attendants
                .filter(a => a.id !== attendant.id)
                .map(a => <option key={a.id} value={a.id}>{a.name}</option>)
              }
            </select>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setTransferModalOpen(false)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">Cancelar</button>
              <button onClick={handleTransfer} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">Confirmar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
// --- END: Merged from components/ChatPanel.tsx ---


// --- START: Merged from components/Login.tsx ---
const Login = ({ attendants, onLogin, onRegister }) => {
  const [selectedAttendant, setSelectedAttendant] = useState('');
  const [newAttendantName, setNewAttendantName] = useState('');

  const handleRegister = () => {
    if (newAttendantName.trim()) {
      onRegister(newAttendantName.trim());
      setNewAttendantName('');
    }
  };

  return (
    <div className="flex items-center justify-center w-full h-full bg-gray-100">
      <div className="w-full max-w-md p-8 space-y-6 bg-white rounded-xl shadow-lg">
        <h2 className="text-3xl font-bold text-center text-gray-800">Painel de Atendimento</h2>
        
        {/* Seção de Login */}
        <div className="space-y-4">
          <h3 className="text-xl font-semibold text-gray-700">Entrar como atendente</h3>
          <select
            value={selectedAttendant}
            onChange={(e) => setSelectedAttendant(e.target.value)}
            className="w-full px-4 py-2 text-gray-700 bg-gray-50 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="" disabled>Selecione seu nome</option>
            {attendants.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <button
            onClick={() => onLogin(selectedAttendant)}
            disabled={!selectedAttendant}
            className="w-full px-4 py-2 font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-300 disabled:bg-blue-300"
          >
            Entrar
          </button>
        </div>

        <div className="border-t border-gray-200"></div>

        {/* Seção de Registro */}
        <div className="space-y-4">
          <h3 className="text-xl font-semibold text-gray-700">Novo atendente?</h3>
           <input
            type="text"
            value={newAttendantName}
            onChange={(e) => setNewAttendantName(e.target.value)}
            placeholder="Digite seu nome completo"
            className="w-full px-4 py-2 text-gray-700 bg-gray-50 border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            onClick={handleRegister}
            disabled={!newAttendantName.trim()}
            className="w-full px-4 py-2 font-bold text-white bg-green-600 rounded-lg hover:bg-green-700 focus:outline-none focus:ring-4 focus:ring-green-300 disabled:bg-green-300"
          >
            Registrar-se
          </button>
        </div>
      </div>
    </div>
  );
};
// --- END: Merged from components/Login.tsx ---

// --- START: Merged from App.tsx ---
function App() {
  const [attendant, setAttendant] = useState(null);
  const [attendants, setAttendants] = useState([]);
  const [activeView, setActiveView] = useState('queue'); // 'queue', 'active', 'history', 'internal_chat', 'ai_active'
  
  const [requestQueue, setRequestQueue] = useState([]);
  const [activeChats, setActiveChats] = useState([]);
  const [aiActiveChats, setAiActiveChats] = useState([]); // Novo estado para chats com IA
  const [chatHistory, setChatHistory] = useState([]);
  
  const [selectedChat, setSelectedChat] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const [internalChatPartner, setInternalChatPartner] = useState(null);
  const [internalChatMessages, setInternalChatMessages] = useState([]);
  const internalMessagesEndRef = useRef(null);
  const [internalMessage, setInternalMessage] = useState('');
  
  const sidebarRef = useRef(null); // Ref para a barra lateral rolável

  // Estados para o modal de iniciar chat
  const [isInitiateModalOpen, setInitiateModalOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [initiateStep, setInitiateStep] = useState('select'); // 'select' | 'message'
  const [selectedClient, setSelectedClient] = useState(null);
  const [initiateMessage, setInitiateMessage] = useState('');
  const [clientSearchTerm, setClientSearchTerm] = useState('');

  // --- NOVOS ESTADOS PARA NOTIFICAÇÕES ---
  const [notifications, setNotifications] = useState({ queue: 0, active: new Set(), ai_active: new Set(), internal: new Set() });
  const [internalChatsSummary, setInternalChatsSummary] = useState({});
  const prevData = useRef(null);

  // --- LÓGICA DE NOTIFICAÇÕES ---
  const showBrowserNotification = useCallback((title, options) => {
    if (document.hidden && Notification.permission === 'granted') {
      const notification = new Notification(title, options);
      const audio = new Audio('https://cdn.jsdelivr.net/gh/google/ai-prototyping-sdk/templates/demos/chat-panel/src/notification.mp3');
      audio.play().catch(e => console.error("Erro ao tocar áudio:", e));
    }
  }, []);

  useEffect(() => {
    if (!prevData.current) { // Inicializa na primeira renderização
        prevData.current = { requestQueue, activeChats, aiActiveChats, internalChatsSummary };
        return;
    }
  
    const newNotifications = { ...notifications };
    let changed = false;

    // 1. Fila de Requisições
    if (requestQueue.length > prevData.current.requestQueue.length) {
        const newRequest = requestQueue[0];
        showBrowserNotification("Nova solicitação na fila", { body: `Cliente: ${newRequest.userName}\nMotivo: ${newRequest.message}` });
        newNotifications.queue = requestQueue.length;
        changed = true;
    } else if (requestQueue.length < prevData.current.requestQueue.length) {
        newNotifications.queue = requestQueue.length;
        changed = true;
    }

    // 2. Chats Ativos (Humanos)
    const activeNotifications = new Set(notifications.active);
    activeChats.forEach(chat => {
      const prevChat = prevData.current.activeChats.find(c => c.userId === chat.userId);
      if ( chat.lastMessage?.sender === 'user' && (!prevChat?.lastMessage || new Date(chat.lastMessage.timestamp) > new Date(prevChat.lastMessage.timestamp))) {
        if (selectedChat?.userId !== chat.userId) {
          activeNotifications.add(chat.userId);
          showBrowserNotification(`Nova mensagem de ${chat.userName}`, { body: chat.lastMessage.text });
        }
      }
    });
    if (activeNotifications.size !== notifications.active.size) {
        newNotifications.active = activeNotifications;
        changed = true;
    }

    // 3. Chats Virtuais (IA)
    const aiNotifications = new Set(notifications.ai_active);
    aiActiveChats.forEach(chat => {
      const prevChat = prevData.current.aiActiveChats.find(c => c.userId === chat.userId);
      if ( chat.lastMessage?.sender === 'user' && (!prevChat?.lastMessage || new Date(chat.lastMessage.timestamp) > new Date(prevChat.lastMessage.timestamp))) {
         if (selectedChat?.userId !== chat.userId) {
            aiNotifications.add(chat.userId);
            showBrowserNotification(`Cliente interagiu com IA: ${chat.userName}`, { body: chat.lastMessage.text });
         }
      }
    });
    if (aiNotifications.size !== notifications.ai_active.size) {
        newNotifications.ai_active = aiNotifications;
        changed = true;
    }
    
    // 4. Chat Interno
    const internalNotifications = new Set(notifications.internal);
    Object.keys(internalChatsSummary).forEach(partnerId => {
      const current = internalChatsSummary[partnerId];
      const prev = prevData.current.internalChatsSummary[partnerId];
      if ( current?.lastMessage && current.lastMessage.senderId !== attendant.id && (!prev?.lastMessage || new Date(current.lastMessage.timestamp) > new Date(prev.lastMessage.timestamp))) {
         if (internalChatPartner?.id !== partnerId) {
            internalNotifications.add(partnerId);
            const senderName = attendants.find(a => a.id === current.lastMessage.senderId)?.name || 'Colega';
            showBrowserNotification(`Mensagem interna de ${senderName}`, { body: current.lastMessage.text });
         }
      }
    });
    if (internalNotifications.size !== notifications.internal.size) {
        newNotifications.internal = internalNotifications;
        changed = true;
    }

    if (changed) {
        setNotifications(newNotifications);
    }

    const totalNotifications = newNotifications.queue + newNotifications.active.size + newNotifications.ai_active.size + newNotifications.internal.size;
    document.title = totalNotifications > 0 ? `(${totalNotifications}) JZF Atendimento` : 'JZF Atendimento';

    prevData.current = { requestQueue, activeChats, aiActiveChats, internalChatsSummary };

  }, [requestQueue, activeChats, aiActiveChats, internalChatsSummary]);


  const fetchData = useCallback(async () => {
    if (!attendant) return;
    try {
      const [reqRes, activeRes, historyRes, attendantsRes, aiChatsRes, internalSummaryRes] = await Promise.all([
        fetch('/api/requests'),
        fetch('/api/chats/active'),
        fetch('/api/chats/history'),
        fetch('/api/attendants'),
        fetch('/api/chats/ai-active'),
        fetch(`/api/internal-chats/summary/${attendant.id}`)
      ]);
      if (!reqRes.ok || !activeRes.ok || !historyRes.ok || !attendantsRes.ok || !aiChatsRes.ok || !internalSummaryRes.ok) {
        throw new Error('Falha ao buscar dados do servidor.');
      }
      const reqData = await reqRes.json();
      const activeData = await activeRes.json();
      const historyData = await historyRes.json();
      const attendantsData = await attendantsRes.json();
      const aiChatsData = await aiChatsRes.json();
      const internalSummaryData = await internalSummaryRes.json();

      setRequestQueue(reqData);
      setActiveChats(activeData);
      setChatHistory(historyData);
      setAttendants(attendantsData);
      setAiActiveChats(aiChatsData);
      setInternalChatsSummary(internalSummaryData);
      
    } catch (err) {
      setError(err.message);
      console.error(err);
    }
  }, [attendant]);

  useEffect(() => {
    fetch('/api/attendants').then(res => res.json()).then(setAttendants);
  }, []);

  useEffect(() => {
    if (attendant) {
      fetchData();
      const interval = setInterval(fetchData, 5000); // Atualiza a cada 5 segundos
      return () => clearInterval(interval);
    }
  }, [attendant, fetchData]);
  
  // Efeito para buscar contatos do cliente
  useEffect(() => {
    const fetchClients = async () => {
        try {
            const res = await fetch('/api/clients');
            if (res.ok) {
                const data = await res.json();
                setClients(data);
            }
        } catch (err) {
            console.error("Falha ao buscar clientes:", err);
        }
    };
    if (attendant) {
        fetchClients();
    }
  }, [attendant]);

  // Efeito para buscar histórico de chat interno
  useEffect(() => {
    if (internalChatPartner && attendant) {
      const fetchInternalHistory = async () => {
        try {
          const res = await fetch(`/api/internal-chats/${attendant.id}/${internalChatPartner.id}`);
          if (res.ok) {
            const data = await res.json();
            setInternalChatMessages(data);
          }
        } catch (err) {
          console.error("Falha ao buscar chat interno:", err);
        }
      };
      fetchInternalHistory();
      const interval = setInterval(fetchInternalHistory, 3000);
      return () => clearInterval(interval);
    }
  }, [internalChatPartner, attendant]);

  useEffect(() => {
    internalMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [internalChatMessages]);


  const handleLogin = (attendantId) => {
    const selected = attendants.find(a => a.id === attendantId);
    if (selected) {
      setAttendant(selected);
      localStorage.setItem('attendantId', selected.id);
      if (Notification.permission !== "granted") {
        Notification.requestPermission();
      }
    }
  };

  const handleRegister = async (name) => {
    try {
        const res = await fetch('/api/attendants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        if (res.ok) {
            const newAttendant = await res.json();
            setAttendants([...attendants, newAttendant]);
            alert(`Bem-vindo, ${name}! Agora você pode entrar usando seu nome.`);
        } else {
            const errData = await res.json();
            throw new Error(errData.error || 'Falha ao registrar.');
        }
    } catch (err) {
        alert(err.message);
    }
  };

  const handleLogout = () => {
    setAttendant(null);
    localStorage.removeItem('attendantId');
  };

  const handleSelectChatItem = async (item) => {
    setIsLoading(true);
    setSelectedChat(null);
    try {
        const res = await fetch(`/api/chats/history/${item.userId}`);
        if(res.ok){
            const data = await res.json();
            // Adiciona o campo 'handledBy' com base na view ativa, se não vier da API
            const handledBy = activeView === 'ai_active' ? 'bot' : (activeView === 'active' || activeView === 'history' ? 'human' : null);
            setSelectedChat({ ...item, ...data, handledBy: data.handledBy || handledBy });

            // Limpa a notificação ao selecionar o chat
            const newNotifications = { ...notifications };
            if (newNotifications[activeView]?.has(item.userId)) {
                newNotifications[activeView].delete(item.userId);
                setNotifications(newNotifications);
            }
        } else {
            throw new Error('Falha ao buscar histórico do chat.');
        }
    } catch (err) {
        alert(err.message);
    } finally {
        setIsLoading(false);
    }
  };
  
  const handleTakeoverChat = async (userId) => {
    if (!attendant) return;
    try {
      const res = await fetch(`/api/chats/takeover/${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendantId: attendant.id }),
      });
      if (res.ok) {
        alert('Atendimento assumido com sucesso!');
        await fetchData();
        // Muda para a aba de ativos e seleciona o chat
        const takeoverData = await res.json();
        setActiveView('active');
        handleSelectChatItem(takeoverData);
      } else {
        throw new Error('Falha ao assumir o atendimento.');
      }
    } catch (err) {
      alert(err.message);
    }
  };

  const handleSendMessage = async (userId, text, attendantId, file) => {
      // Slash command para finalizar
      if (text === '/finalizar') {
          handleResolveChat(userId);
          return;
      }
      
      const tempMessage = {
          sender: Sender.ATTENDANT,
          text: text,
          file: file ? { name: file.name } : null, // Para UI otimista
          timestamp: new Date().toISOString()
      };
      // Atualiza a UI imediatamente para feedback rápido
      setSelectedChat(prev => ({ ...prev, messageLog: [...prev.messageLog, tempMessage] }));

      try {
          await fetch('/api/chats/attendant-reply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, text, attendantId, file }),
          });
          // O fetch periódico vai confirmar a mensagem, então não precisamos refetch aqui.
      } catch (err) {
          alert('Falha ao enviar mensagem.');
          // Poderia implementar lógica para remover a mensagem otimista
      }
  };

  const handleResolveChat = async (userId) => {
    if (!attendant) return;
    const sidebarScrollPosition = sidebarRef.current?.scrollTop;
    try {
      const res = await fetch(`/api/chats/resolve/${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendantId: attendant.id }),
      });
      if (res.ok) {
        alert('Atendimento resolvido com sucesso!');
        setSelectedChat(null);
        setActiveView('queue'); // Volta para a fila
        await fetchData(); // Atualiza os dados
        requestAnimationFrame(() => {
            if (sidebarRef.current) sidebarRef.current.scrollTop = sidebarScrollPosition;
        });
      } else {
        throw new Error('Falha ao resolver o atendimento.');
      }
    } catch (err) {
      alert(err.message);
    }
  };
  
  const handleTransferChat = async (userId, newAttendantId) => {
    if (!attendant) return;
    const sidebarScrollPosition = sidebarRef.current?.scrollTop;
    try {
      const res = await fetch(`/api/chats/transfer/${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newAttendantId,
          transferringAttendantId: attendant.id,
        }),
      });
      if (res.ok) {
        const targetAttendant = attendants.find(a => a.id === newAttendantId);
        alert(`Atendimento transferido com sucesso para ${targetAttendant?.name || 'outro atendente'}!`);
        setSelectedChat(null);
        setActiveView('queue'); // Volta para a fila
        await fetchData(); // Atualiza os dados
        requestAnimationFrame(() => {
            if (sidebarRef.current) sidebarRef.current.scrollTop = sidebarScrollPosition;
        });
      } else {
        const errorText = await res.text();
        throw new Error(errorText || 'Falha ao transferir o atendimento.');
      }
    } catch (err) {
      alert(err.message);
    }
  };
  
  const handleSendInternalMessage = async () => {
    if (!internalMessage.trim() || !attendant || !internalChatPartner) return;
    const text = internalMessage.trim();
    setInternalMessage('');
    
    const tempMessage = {
      senderId: attendant.id,
      senderName: attendant.name,
      text,
      timestamp: new Date().toISOString()
    };
    setInternalChatMessages(prev => [...prev, tempMessage]);

    try {
      await fetch('/api/internal-chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: attendant.id,
          recipientId: internalChatPartner.id,
          text,
        }),
      });
    } catch (err) {
      console.error("Falha ao enviar mensagem interna:", err);
      // Poderia adicionar lógica de retry ou remoção da UI
    }
  };

  const handleInitiateChat = async () => {
    if (!initiateMessage.trim() || !attendant || !selectedClient) return;
    try {
        const res = await fetch('/api/chats/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipientNumber: selectedClient.userId,
                message: initiateMessage.trim(),
                attendantId: attendant.id
            })
        });
        if (res.ok) {
            const newChat = await res.json();
            handleCloseInitiateModal();
            await fetchData(); // Atualiza todas as listas
            setActiveView('active');
            // Espera um pouco para o React atualizar o DOM antes de selecionar
            setTimeout(() => {
                handleSelectChatItem(newChat);
            }, 100);
        } else {
            const errorText = await res.text();
            throw new Error(errorText || "Falha ao iniciar conversa.");
        }
    } catch (err) {
        alert(err.message);
    }
  };

  const handleCloseInitiateModal = () => {
      setInitiateModalOpen(false);
      setInitiateStep('select');
      setSelectedClient(null);
      setInitiateMessage('');
      setClientSearchTerm('');
  };

  const clearNotificationsForView = (view) => {
    if (view === 'queue' && notifications.queue > 0) {
      setNotifications(prev => ({...prev, queue: 0}));
    } else if (notifications[view]?.size > 0) {
      setNotifications(prev => ({...prev, [view]: new Set()}));
    }
  };


  useEffect(() => {
    const savedAttendantId = localStorage.getItem('attendantId');
    if (savedAttendantId && attendants.length > 0) {
      handleLogin(savedAttendantId);
    }
  }, [attendants]);


  if (!attendant) {
    return <Login attendants={attendants} onLogin={handleLogin} onRegister={handleRegister} />;
  }

  const filteredClients = clients.filter(c =>
    c.userName.toLowerCase().includes(clientSearchTerm.toLowerCase()) ||
    c.userId.includes(clientSearchTerm)
  );

  // Componente para item da lista lateral
  // FIX: Add default props for isSelected and children to fix usage errors.
  const ListItem = ({ item, onClick, isSelected = false, children = null }) => (
    <li
      onClick={onClick}
      className={`p-3 cursor-pointer border-b border-gray-200 hover:bg-gray-200 transition-colors ${isSelected ? 'bg-blue-100' : 'bg-white'}`}
    >
      <p className="font-semibold text-gray-800 truncate">{item.userName || item.name || item.id}</p>
      {children}
    </li>
  );

  const NavButton = ({ view, label, count, children }) => (
    <button onClick={() => { setActiveView(view); setSelectedChat(null); setInternalChatPartner(null); clearNotificationsForView(view); }} className={`relative flex-1 p-2 text-sm font-semibold rounded-md ${activeView === view ? 'bg-white shadow' : 'text-gray-600'}`}>
        {label || children} {count > 0 && <span className="absolute top-0 right-0 -mt-1 -mr-1 px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full">{count}</span>}
    </button>
  );

  return (
    <div className="flex h-screen font-sans bg-gray-100 text-gray-800">
      {/* Sidebar */}
      <aside className="w-80 bg-white border-r border-gray-200 flex flex-col shadow-lg">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-xl font-bold text-gray-800">JZF Atendimento</h1>
          <div className="mt-2 text-sm text-gray-600">
             <div className="flex items-center justify-between">
                <p>Atendente: <span className="font-semibold">{attendant.name}</span></p>
                <div>
                  <button onClick={() => setInitiateModalOpen(true)} className="text-xs font-semibold text-blue-600 hover:underline mr-3">Novo Chat</button>
                  <button onClick={handleLogout} className="text-xs text-red-500 hover:underline">Sair</button>
                </div>
            </div>
          </div>
        </div>
        
        {/* Abas de Navegação */}
        <nav className="flex p-1 bg-gray-100">
            <NavButton view="queue" label="Fila" count={notifications.queue} />
            <NavButton view="active" label="Ativos" count={notifications.active.size} />
            <NavButton view="ai_active" label="Virtual" count={notifications.ai_active.size} />
            <NavButton view="history" label="Histórico" count={0} />
            <NavButton view="internal_chat" label="Chat Interno" count={notifications.internal.size} />
        </nav>

        <div ref={sidebarRef} className="flex-1 overflow-y-auto">
          <ul>
            {activeView === 'queue' && requestQueue.map(req => (
              <ListItem key={req.id} item={req} onClick={() => handleTakeoverChat(req.userId)}>
                <p className="text-xs text-gray-500">{req.department} - {new Date(req.timestamp).toLocaleTimeString()}</p>
                <p className="text-xs text-gray-600 mt-1 truncate italic">"{req.message}"</p>
              </ListItem>
            ))}
            
            {activeView === 'active' && activeChats.map(chat => (
              <ListItem key={chat.userId} item={chat} onClick={() => handleSelectChatItem(chat)} isSelected={selectedChat?.userId === chat.userId}>
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-gray-500">Atendido por: {attendants.find(a => a.id === chat.attendantId)?.name || '...'}</p>
                    {notifications.active.has(chat.userId) && <span className="h-2 w-2 bg-blue-500 rounded-full"></span>}
                  </div>
              </ListItem>
            ))}

            {activeView === 'ai_active' && aiActiveChats.map(chat => (
                <ListItem key={chat.userId} item={chat} onClick={() => handleSelectChatItem(chat)} isSelected={selectedChat?.userId === chat.userId}>
                    <div className="flex justify-between items-center">
                        <p className="text-xs text-gray-500">Departamento: {chat.department}</p>
                        {notifications.ai_active.has(chat.userId) && <span className="h-2 w-2 bg-blue-500 rounded-full"></span>}
                    </div>
                </ListItem>
            ))}
            
            {activeView === 'history' && chatHistory.map(chat => (
              <ListItem key={chat.userId} item={chat} onClick={() => handleSelectChatItem(chat)} isSelected={selectedChat?.userId === chat.userId}>
                  <p className="text-xs text-gray-500">Resolvido por: {chat.resolvedBy} em {new Date(chat.resolvedAt).toLocaleString()}</p>
              </ListItem>
            ))}

            {activeView === 'internal_chat' && attendants.filter(a => a.id !== attendant.id).map(a => {
                const summary = internalChatsSummary[a.id];
                const lastMessage = summary?.lastMessage;
                const hasUnread = notifications.internal.has(a.id);
                return (
                   <ListItem key={a.id} item={a} onClick={() => {
                        setInternalChatPartner(a);
                        if (hasUnread) {
                            const newInternal = new Set(notifications.internal);
                            newInternal.delete(a.id);
                            setNotifications(p => ({ ...p, internal: newInternal }));
                        }
                   }} isSelected={internalChatPartner?.id === a.id}>
                       {lastMessage && (
                           <p className={`text-xs truncate mt-1 ${hasUnread ? 'text-gray-800 font-bold' : 'text-gray-500'}`}>
                               {lastMessage.senderId === attendant.id && 'Você: '}{lastMessage.text}
                           </p>
                       )}
                   </ListItem>
                );
            })}
          </ul>
        </div>
      </aside>

      {/* Painel Principal */}
      <main className="flex-1 flex flex-col">
        {activeView !== 'internal_chat' && (
          <ChatPanel
            selectedChat={selectedChat}
            attendant={attendant}
            onSendMessage={handleSendMessage}
            onResolveChat={handleResolveChat}
            onTransferChat={handleTransferChat}
            onTakeoverChat={handleTakeoverChat} // Passa a nova função
            isLoading={isLoading}
            attendants={attendants}
          />
        )}
        
        {activeView === 'internal_chat' && (
           <div className="flex-1 flex flex-col bg-gray-100">
            {!internalChatPartner ? (
                <div className="flex-1 flex items-center justify-center text-gray-500">
                    <span>Selecione um atendente para iniciar uma conversa.</span>
                </div>
            ) : (
                <>
                    <header className="bg-white p-3 border-b border-gray-200">
                        <h2 className="font-semibold">{internalChatPartner.name}</h2>
                    </header>
                    <div className="flex-1 overflow-y-auto p-4 whatsapp-bg">
                        {internalChatMessages.map((msg, index) => {
                            const isMe = String(msg.senderId) === String(attendant.id);
                            return (
                                <div key={index} className={`flex w-full ${isMe ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-md p-2 rounded-lg shadow-sm mb-1 flex flex-col ${isMe ? 'bg-blue-100' : 'bg-white'}`}>
                                        {!isMe && <p className="text-xs font-semibold text-purple-600">{msg.senderName}</p>}
                                        <div className="text-sm whitespace-pre-wrap">{msg.text}</div>
                                        <div className="text-xs text-gray-400 self-end mt-1">
                                          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        <div ref={internalMessagesEndRef} />
                    </div>
                    <footer className="bg-gray-200 p-3">
                        <div className="flex items-center bg-white rounded-full shadow-sm px-2">
                            <input
                                type="text"
                                value={internalMessage}
                                onChange={e => setInternalMessage(e.target.value)}
                                onKeyPress={e => e.key === 'Enter' && handleSendInternalMessage()}
                                placeholder={`Mensagem para ${internalChatPartner.name}...`}
                                className="w-full p-2 bg-transparent focus:outline-none"
                            />
                            <button onClick={handleSendInternalMessage} disabled={!internalMessage.trim()} className="p-2 text-blue-600 rounded-full disabled:text-gray-400">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg>
                            </button>
                        </div>
                    </footer>
                </>
            )}
           </div>
        )}
      </main>

      {/* Modal para Iniciar Chat */}
      {isInitiateModalOpen && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-lg flex flex-col" style={{height: '80vh'}}>
                  {initiateStep === 'select' && (
                      <>
                          <h3 className="text-lg font-semibold mb-4">Iniciar Nova Conversa</h3>
                          <p className="text-sm text-gray-600 mb-4">Selecione um contato para enviar uma mensagem.</p>
                          <input
                              type="text"
                              placeholder="Buscar por nome ou número..."
                              value={clientSearchTerm}
                              onChange={e => setClientSearchTerm(e.target.value)}
                              className="w-full p-2 border border-gray-300 rounded-md mb-4"
                          />
                          <div className="flex-1 overflow-y-auto border rounded-md">
                              <ul>
                                  {filteredClients.length > 0 ? filteredClients.map(client => (
                                      <li
                                          key={client.userId}
                                          onClick={() => {
                                              setSelectedClient(client);
                                              setInitiateStep('message');
                                          }}
                                          className="p-3 cursor-pointer hover:bg-gray-100 border-b"
                                      >
                                          <p className="font-semibold">{client.userName}</p>
                                          <p className="text-xs text-gray-500">{client.userId.split('@')[0]}</p>
                                      </li>
                                  )) : <li className="p-4 text-center text-gray-500">Nenhum contato encontrado.</li>}
                              </ul>
                          </div>
                          <div className="flex justify-end mt-4">
                              <button onClick={handleCloseInitiateModal} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">Cancelar</button>
                          </div>
                      </>
                  )}
                  {initiateStep === 'message' && (
                      <>
                          <h3 className="text-lg font-semibold mb-4">Enviar Mensagem</h3>
                          <p className="text-sm text-gray-600 mb-4">
                              Para: <span className="font-semibold">{selectedClient?.userName} ({selectedClient?.userId.split('@')[0]})</span>
                          </p>
                          <textarea
                              value={initiateMessage}
                              onChange={e => setInitiateMessage(e.target.value)}
                              placeholder="Digite sua primeira mensagem..."
                              className="w-full flex-1 p-2 border border-gray-300 rounded-md mb-4 resize-none"
                          ></textarea>
                          <div className="flex justify-between">
                              <button onClick={() => setInitiateStep('select')} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">Voltar</button>
                              <div>
                                  <button onClick={handleCloseInitiateModal} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 mr-2">Cancelar</button>
                                  <button onClick={handleInitiateChat} disabled={!initiateMessage.trim()} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-blue-300">Enviar e Iniciar</button>
                              </div>
                          </div>
                      </>
                  )}
              </div>
          </div>
      )}

    </div>
  );
}
// --- END: Merged from App.tsx ---

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
