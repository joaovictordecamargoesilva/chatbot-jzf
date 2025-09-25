
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

// --- NOVO COMPONENTE: FileRenderer ---
// Helper para renderizar diferentes tipos de arquivo de forma inteligente
const FileRenderer = ({ file }) => {
    // Fallback para arquivos antigos sem dados base64
    if (!file || !file.type || !file.data) {
        return (
             <div className="mt-2 p-2 bg-gray-100 rounded-lg flex items-center space-x-2 border border-gray-200">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" />
                </svg>
                <span className="text-xs text-gray-700 truncate">{file.name || 'Arquivo'}</span>
            </div>
        );
    }

    const fileSrc = `data:${file.type};base64,${file.data}`;

    if (file.type.startsWith('image/')) {
        return <img src={fileSrc} alt={file.name} className="mt-2 rounded-lg max-w-xs md:max-w-sm max-h-80 object-contain cursor-pointer" onClick={() => window.open(fileSrc, '_blank')} />;
    }
    if (file.type.startsWith('audio/')) {
        return <audio controls src={fileSrc} className="mt-2 w-full max-w-xs"></audio>;
    }
    if (file.type.startsWith('video/')) {
        return <video controls src={fileSrc} className="mt-2 rounded-lg max-w-xs md:max-w-sm max-h-80"></video>;
    }
    // Para PDFs e outros documentos, fornece um link de download
    return (
        <a href={fileSrc} download={file.name} className="mt-2 p-2 bg-gray-100 rounded-lg flex items-center space-x-2 border border-gray-200 hover:bg-gray-200 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            <div className="flex flex-col overflow-hidden">
                 <span className="text-sm font-medium text-gray-800 truncate">{file.name}</span>
                 <span className="text-xs text-gray-500">Clique para baixar</span>
            </div>
        </a>
    );
};


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
  
  // ATUALIZAÇÃO: Suporta `message.files` (array) ou `message.file` (single)
  const files = message.files || (message.file ? [message.file] : []);

  return (
    <div className={`flex w-full ${justifyClass} my-1`}>
      <div className={`rounded-lg px-3 py-2 max-w-[80%] shadow-sm ${bubbleClasses} flex flex-col`}>
        {message.text && <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>}
        {files.length > 0 && (
          <div className="mt-1 flex flex-col gap-2">
            {files.map((file, index) => (
              <FileRenderer key={index} file={file} />
            ))}
          </div>
        )}
        <div className="text-right text-[10px] text-gray-500 mt-1 self-end">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
};
// --- END: Merged from components/MessageBubble.tsx ---

// --- MAIN APP COMPONENT ---
const App = () => {
    const [attendants, setAttendants] = useState([]);
    const [currentAttendantId, setCurrentAttendantId] = useState(null);
    const [requests, setRequests] = useState([]);
    const [activeChats, setActiveChats] = useState([]);
    const [selectedChat, setSelectedChat] = useState(null);
    const [messages, setMessages] = useState([]);
    const [inputText, setInputText] = useState('');
    const [attachedFiles, setAttachedFiles] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);

    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const notificationAudioRef = useRef(null);

    // Sound notification logic
    const playNotification = useCallback(() => {
        if (notificationAudioRef.current) {
            notificationAudioRef.current.play().catch(e => console.error("Erro ao tocar áudio:", e));
        }
    }, []);

    const fetchData = useCallback(async () => {
        if (!currentAttendantId) return;
        try {
            const [requestsRes, activeChatsRes] = await Promise.all([
                fetch('/api/requests'),
                fetch('/api/chats/active')
            ]);
            const newRequests = await requestsRes.json();
            const newActiveChats = await activeChatsRes.json();

            // Check for new requests to play notification
            if (newRequests.length > requests.length) {
                playNotification();
            }

            setRequests(newRequests);

            // Filter active chats for the current attendant
            const myActiveChats = newActiveChats.filter(c => c.attendantId === currentAttendantId);
            setActiveChats(myActiveChats);

        } catch (err) {
            console.error("Failed to fetch data", err);
            setError("Falha ao buscar dados. Verifique a conexão com o servidor.");
        }
    }, [currentAttendantId, requests.length, playNotification]);

    // Fetch initial attendants
    useEffect(() => {
        const fetchAttendants = async () => {
            try {
                const res = await fetch('/api/attendants');
                const data = await res.json();
                setAttendants(data);
                if (data.length > 0) {
                    // Automatically select the first attendant for simplicity
                    setCurrentAttendantId(data[0].id);
                }
            } catch (err) {
                 console.error("Failed to fetch attendants", err);
                 setError("Falha ao buscar atendentes. O servidor está rodando?");
            } finally {
                setIsLoading(false);
            }
        };
        fetchAttendants();
        // Initialize the audio element
        notificationAudioRef.current = new Audio('https://cdn.freesound.org/previews/573/573381_7037-lq.mp3');
        notificationAudioRef.current.volume = 0.5;
    }, []);

    // Polling for new data
    useEffect(() => {
        if (currentAttendantId) {
            const interval = setInterval(fetchData, 5000); // Poll every 5 seconds
            return () => clearInterval(interval);
        }
    }, [currentAttendantId, fetchData]);

    // Scroll to bottom of messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Fetch message history when a chat is selected
    useEffect(() => {
        const fetchChatHistory = async () => {
            if (selectedChat) {
                setIsLoading(true);
                try {
                    const res = await fetch(`/api/chats/history/${selectedChat.userId}`);
                    const data = await res.json();
                    setMessages(data.messageLog || []);
                } catch (err) {
                    console.error(`Failed to fetch history for ${selectedChat.userId}`, err);
                    setError("Falha ao carregar histórico do chat.");
                } finally {
                    setIsLoading(false);
                }
            }
        };
        fetchChatHistory();
    }, [selectedChat]);

    const handleSelectChat = (chat) => {
        setSelectedChat(chat);
        setMessages([]); // Clear previous messages
    };

    const handleTakeover = async (request) => {
        if (!currentAttendantId) return;
        try {
            const res = await fetch(`/api/chats/takeover/${request.userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ attendantId: currentAttendantId }),
            });
            if (res.ok) {
                const newActiveChat = await res.json();
                setActiveChats(prev => [...prev.filter(c => c.userId !== newActiveChat.userId), newActiveChat]);
                setRequests(prev => prev.filter(r => r.id !== request.id));
                handleSelectChat(newActiveChat);
            } else {
                throw new Error('Failed to take over chat');
            }
        } catch (err) {
            console.error("Takeover error:", err);
            setError("Não foi possível assumir o atendimento.");
        }
    };
    
    // Utility to convert file to base64
    const toBase64 = file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]); // remove the data url prefix
        reader.onerror = error => reject(error);
    });

    const handleSendMessage = async () => {
        if (!selectedChat || (!inputText.trim() && attachedFiles.length === 0)) return;

        const filesPayload = await Promise.all(
            attachedFiles.map(async (file) => ({
                name: file.name,
                type: file.type,
                data: await toBase64(file),
            }))
        );

        const messagePayload = {
            userId: selectedChat.userId,
            text: inputText.trim(),
            attendantId: currentAttendantId,
            files: filesPayload,
        };
        
        // Optimistic UI update
        const optimisticMessage = {
          sender: Sender.ATTENDANT,
          text: inputText.trim(),
          files: filesPayload.map(f => ({...f})), // Create a copy
          timestamp: new Date().toISOString()
        };
        setMessages(prev => [...prev, optimisticMessage]);
        setInputText('');
        setAttachedFiles([]);
        
        try {
            await fetch('/api/chats/attendant-reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(messagePayload),
            });
        } catch (err) {
            console.error("Send message error:", err);
            setError("Falha ao enviar mensagem.");
            // Revert optimistic update on failure
            setMessages(prev => prev.filter(m => m !== optimisticMessage));
        }
    };
    
    const handleResolveChat = async () => {
        if (!selectedChat) return;
        try {
            await fetch(`/api/chats/resolve/${selectedChat.userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ attendantId: currentAttendantId }),
            });
            setActiveChats(prev => prev.filter(c => c.userId !== selectedChat.userId));
            setSelectedChat(null);
            setMessages([]);
        } catch (err) {
            console.error("Resolve chat error:", err);
            setError("Não foi possível resolver o atendimento.");
        }
    };
    
    const handleFileSelect = (event) => {
      if (event.target.files) {
        setAttachedFiles(prev => [...prev, ...Array.from(event.target.files)]);
      }
    };

    const removeAttachedFile = (indexToRemove) => {
        setAttachedFiles(prev => prev.filter((_, index) => index !== indexToRemove));
    };

    if (isLoading && !currentAttendantId) {
        return <div className="flex items-center justify-center h-screen"><p>Carregando painel...</p></div>;
    }

    if (!currentAttendantId) {
        return (
            <div className="flex items-center justify-center h-screen bg-gray-200">
                <div className="bg-white p-8 rounded-lg shadow-md text-center">
                    <h1 className="text-xl font-bold mb-4">Bem-vindo ao Painel de Atendimento</h1>
                    <p className="text-gray-600">Nenhum atendente foi encontrado ou cadastrado no sistema.</p>
                    <p className="text-sm text-gray-500 mt-2">Por favor, inicie o servidor com atendentes ou implemente uma tela de login.</p>
                </div>
            </div>
        );
    }
    
    const currentAttendant = attendants.find(a => a.id === currentAttendantId);

    return (
        <div className="flex h-screen bg-gray-100 font-sans">
            <aside className="w-1/4 bg-white border-r border-gray-200 flex flex-col min-w-[300px]">
                <header className="p-4 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
                    <h1 className="text-xl font-bold text-gray-800">JZF Atendimento</h1>
                    <div className="text-right">
                      <p className="font-semibold text-sm">{currentAttendant?.name}</p>
                      <p className="text-xs text-gray-500">Atendente</p>
                    </div>
                </header>
                
                <div className="flex-grow overflow-y-auto">
                    <section className="p-4">
                        <h2 className="text-sm font-semibold text-gray-600 mb-2">Fila de Atendimento ({requests.length})</h2>
                        <div className="space-y-2">
                            {requests.map(req => (
                                <div key={req.id} className="p-3 bg-yellow-100 rounded-lg shadow-sm cursor-pointer hover:bg-yellow-200 transition-colors" onClick={() => handleTakeover(req)}>
                                    <p className="font-bold text-sm text-yellow-800">{req.userName}</p>
                                    <p className="text-xs text-yellow-700 truncate">{req.department}: {req.message}</p>
                                    <p className="text-[10px] text-yellow-600 mt-1">{new Date(req.timestamp).toLocaleString()}</p>
                                </div>
                            ))}
                            {requests.length === 0 && <p className="text-xs text-gray-400 py-2">Nenhuma solicitação na fila.</p>}
                        </div>
                    </section>

                    <section className="p-4 border-t border-gray-200">
                        <h2 className="text-sm font-semibold text-gray-600 mb-2">Meus Atendimentos ({activeChats.length})</h2>
                        <div className="space-y-2">
                            {activeChats.map(chat => (
                                <div key={chat.userId} className={`p-3 rounded-lg cursor-pointer transition-colors ${selectedChat?.userId === chat.userId ? 'bg-blue-500 text-white shadow-md' : 'bg-gray-50 hover:bg-gray-200'}`} onClick={() => handleSelectChat(chat)}>
                                    <p className={`font-bold text-sm ${selectedChat?.userId === chat.userId ? '' : 'text-gray-800'}`}>{chat.userName}</p>
                                    <p className={`text-xs truncate ${selectedChat?.userId === chat.userId ? 'text-blue-200' : 'text-gray-600'}`}>
                                       {chat.lastMessage ? `${chat.lastMessage.sender === 'user' ? 'Cliente: ' : 'Você: '}${chat.lastMessage.text || 'Mídia'}` : 'Nenhuma mensagem recente'}
                                    </p>
                                </div>
                            ))}
                            {activeChats.length === 0 && <p className="text-xs text-gray-400 py-2">Nenhum atendimento ativo.</p>}
                        </div>
                    </section>
                </div>
            </aside>

            <main className="flex-1 flex flex-col bg-gray-200">
                {selectedChat ? (
                    <>
                        <header className="bg-white p-4 border-b border-gray-200 flex justify-between items-center flex-shrink-0">
                            <h2 className="text-lg font-semibold">{selectedChat.userName}</h2>
                            <button onClick={handleResolveChat} className="px-4 py-2 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600 transition-colors">
                                Resolver Atendimento
                            </button>
                        </header>
                        
                        <div className="flex-1 overflow-y-auto p-4 whatsapp-bg">
                            {isLoading ? <div className="flex justify-center items-center h-full"><p>Carregando mensagens...</p></div> : (
                              <div className="flex flex-col space-y-2">
                                 {messages.map((msg, index) => <MessageBubble key={index} message={msg} />)}
                                 <div ref={messagesEndRef} />
                              </div>
                            )}
                        </div>

                        <footer className="bg-gray-100 p-4 border-t border-gray-200 flex-shrink-0">
                            {attachedFiles.length > 0 && (
                                <div className="mb-2 p-2 bg-white rounded-lg border flex flex-wrap gap-2">
                                   {attachedFiles.map((file, index) => (
                                        <div key={index} className="flex items-center gap-2 bg-gray-200 rounded-full px-3 py-1 text-sm">
                                            <span className="max-w-[150px] truncate">{file.name}</span>
                                            <button onClick={() => removeAttachedFile(index)} className="text-red-500 hover:text-red-700 font-bold">&times;</button>
                                        </div>
                                   ))}
                                </div>
                            )}
                            <div className="flex items-center bg-white rounded-full p-2 shadow-sm">
                                <input type="file" multiple onChange={handleFileSelect} ref={fileInputRef} className="hidden" />
                                <button onClick={() => fileInputRef.current.click()} className="p-2 text-gray-500 hover:text-gray-700">
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                </button>
                                <input
                                    type="text"
                                    value={inputText}
                                    onChange={(e) => setInputText(e.target.value)}
                                    onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                                    placeholder="Digite sua mensagem..."
                                    className="flex-1 bg-transparent px-4 py-2 border-none focus:outline-none text-sm"
                                />
                                <button onClick={handleSendMessage} className="p-2 bg-blue-500 text-white rounded-full hover:bg-blue-600 disabled:bg-gray-300 transition-colors" disabled={!inputText.trim() && attachedFiles.length === 0}>
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg>
                                </button>
                            </div>
                        </footer>
                    </>
                ) : (
                    <div className="flex-1 flex items-center justify-center whatsapp-bg">
                        <div className="text-center text-gray-500 bg-white bg-opacity-70 p-8 rounded-lg">
                            <h2 className="text-xl font-semibold">Painel de Atendimento</h2>
                            <p>Selecione um atendimento na barra lateral para começar.</p>
                             {error && <p className="text-red-500 mt-4">{error}</p>}
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};


// --- RENDER ---
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
