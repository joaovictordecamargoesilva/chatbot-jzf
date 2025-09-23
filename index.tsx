


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
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-xs text-gray-700 font-medium truncate">{message.file.name}</span>
            </div>
        )}
        {message.timestamp && (
            <div className="text-right text-[10px] text-gray-500 mt-1">
                {new Date(message.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
            </div>
        )}
      </div>
    </div>
  );
};
// --- END: Merged from components/MessageBubble.tsx ---


// --- START: Merged from components/ChatInput.tsx ---
const ChatInput = ({ onUserInput, options, requiresTextInput, isBotTyping, onFileChange, selectedFile, placeholderText = "Mensagem" }) => {
  const [inputValue, setInputValue] = useState('');
  const fileInputRef = useRef(null);

  const handleSend = () => {
    if (inputValue.trim() || selectedFile) {
      onUserInput(inputValue.trim());
      setInputValue('');
    }
  };
  
  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e) => {
    onFileChange(e.target.files?.[0] ?? null);
    if(fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  if (isBotTyping && options?.length === 0 && !requiresTextInput) {
    return <div className="h-24 bg-gray-100" />; // Placeholder to maintain height for bot typing
  }
  
  return (
    <div className="p-2 bg-gray-100 border-t border-gray-200">
      {options && options.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
          {options.map((option) => (
            <button
              key={option.text}
              onClick={() => onUserInput(option.text, option)}
              disabled={isBotTyping}
              className="w-full bg-white text-blue-600 font-semibold py-2 px-4 rounded-lg border border-blue-500 hover:bg-blue-50 transition duration-200 disabled:bg-gray-300 disabled:text-gray-500 disabled:border-gray-300"
            >
              {option.text}
            </button>
          ))}
        </div>
      )}
      {requiresTextInput && (
        <>
        {selectedFile && (
            <div className="mb-2 p-2 bg-green-100 border border-green-200 rounded-lg flex items-center justify-between text-sm">
                <div className="flex items-center space-x-2 truncate">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                    <span className="text-gray-700 truncate">{selectedFile.name}</span>
                </div>
                <button onClick={() => onFileChange(null)} className="text-gray-500 hover:text-gray-700">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        )}
        <div className="flex items-center space-x-2">
            {onFileChange && (
              <button
                  onClick={handleFileClick}
                  disabled={isBotTyping}
                  className="text-gray-500 p-2 rounded-full hover:bg-gray-200 transition duration-200 disabled:text-gray-300"
                  aria-label="Anexar arquivo"
              >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
              </button>
            )}
             <input 
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelected}
                className="hidden"
                accept=".pdf,.xml,.csv,.txt,.json,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp"
            />
            <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={selectedFile ? "Descreva o arquivo..." : placeholderText}
                disabled={isBotTyping}
                className="flex-grow p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#005e54]"
                autoFocus
            />
            <button
                onClick={handleSend}
                disabled={isBotTyping || (!inputValue.trim() && !selectedFile)}
                className="bg-[#005e54] text-white p-3 rounded-full hover:bg-[#004c45] transition duration-200 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center"
                aria-label="Enviar mensagem"
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
            </button>
        </div>
        </>
      )}
    </div>
  );
};
// --- END: Merged from components/ChatInput.tsx ---


// --- START: Merged from components/ChatWindow.tsx ---
const ChatWindow = ({ messages, isBotTyping, children }) => {
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isBotTyping]);

  return (
    <div className="flex-1 p-4 overflow-y-auto whatsapp-bg">
       <div className="flex flex-col space-y-2">
        {messages.map((msg, index) => (
          <MessageBubble key={msg.id || `${msg.timestamp}-${index}`} message={msg} />
        ))}
        {isBotTyping && <TypingIndicator />}
        {children}
        <div ref={chatEndRef} />
      </div>
    </div>
  );
};
// --- END: Merged from components/ChatWindow.tsx ---


// --- START: Merged from components/AttendantPanel.tsx ---
const AttendantPanel = () => {
  const [currentAttendant, setCurrentAttendant] = useState(null);
  const [attendants, setAttendants] = useState([]);
  const [panelView, setPanelView] = useState('queue'); // queue, active, history, newChat
  const [activeChat, setActiveChat] = useState(null); // { userId, userName, ... }
  const [chatMessages, setChatMessages] = useState([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [requests, setRequests] = useState([]);
  const [activeChats, setActiveChats] = useState([]);
  const [archivedChats, setArchivedChats] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const notificationAudioRef = useRef(null);
  const titleIntervalRef = useRef(null);
  
  // State for "New Chat" feature
  const [clients, setClients] = useState([]);
  const [newChatSearch, setNewChatSearch] = useState('');
  const [selectedRecipient, setSelectedRecipient] = useState(null);


  // Fetch attendants on mount
  useEffect(() => {
    const fetchAttendants = async () => {
      try {
        const res = await fetch('/api/attendants');
        if (!res.ok) throw new Error("Failed to fetch attendants");
        const data = await res.json();
        setAttendants(data);
      } catch (err) {
        console.error(err);
        setError("Não foi possível carregar a lista de atendentes.");
      }
    };
    fetchAttendants();
    notificationAudioRef.current = new Audio('https://cdn.jsdelivr.net/gh/google/ai-studio-files/examples/uber_notification.mp3');
  }, []);

  const stopTitleBlinking = () => {
    if (titleIntervalRef.current) {
        clearInterval(titleIntervalRef.current);
        titleIntervalRef.current = null;
    }
    document.title = "Assistente Virtual | JZF Contabilidade";
  };
  
  // Polling for queue and active chats
  const fetchData = useCallback(async () => {
    if (!currentAttendant) return;
    try {
      const [reqRes, activeRes] = await Promise.all([
        fetch('/api/requests'),
        fetch('/api/chats/active')
      ]);
      if (!reqRes.ok || !activeRes.ok) throw new Error('Falha ao buscar dados.');
      
      const newRequests = await reqRes.json();
      const newActiveChats = await activeRes.json();

      if(newRequests.length > requests.length && requests.length > 0) {
        if(notificationAudioRef.current) notificationAudioRef.current.play().catch(e => console.log("Audio play failed", e));
        if (!titleIntervalRef.current) {
            let toggle = false;
            titleIntervalRef.current = setInterval(() => {
                document.title = toggle ? "!! NOVO ATENDIMENTO !!" : "Assistente Virtual | JZF Contabilidade";
                toggle = !toggle;
            }, 1000);
        }
      }

      setRequests(newRequests);
      setActiveChats(newActiveChats);
      if (error) setError(null);
    } catch (err) {
      console.error(err);
      setError('Não foi possível conectar ao servidor.');
    } finally {
      setIsLoading(false);
    }
  }, [currentAttendant, error, requests.length]);

  useEffect(() => {
    if(panelView === 'queue' || panelView === 'active') {
       fetchData();
       const intervalId = setInterval(fetchData, 5000);
       return () => {
           clearInterval(intervalId);
           stopTitleBlinking();
       };
    }
  }, [fetchData, panelView]);
  
  // Polling for active chat history
  useEffect(() => {
    if (!activeChat) return;

    const fetchHistory = async () => {
        try {
            const response = await fetch(`/api/chats/history/${activeChat.userId}`);
            if (!response.ok) throw new Error('Falha ao buscar histórico.');
            const data = await response.json();
            setChatMessages(data);
        } catch (err) {
            console.error(err);
            setError('Não foi possível carregar o histórico da conversa.');
        } finally {
            setIsChatLoading(false);
        }
    };
    
    setIsChatLoading(true);
    fetchHistory();
    const intervalId = setInterval(fetchHistory, 3000);
    return () => clearInterval(intervalId);
  }, [activeChat]);

  // Fetch data based on panel view
  useEffect(() => {
    if (panelView === 'history') {
      const fetchArchived = async () => {
        setIsLoading(true);
        try {
          const res = await fetch('/api/chats/history');
          if (!res.ok) throw new Error('Falha ao buscar histórico.');
          const data = await res.json();
          setArchivedChats(data);
        } catch (err) {
          console.error(err);
          setError("Não foi possível carregar o histórico.");
        } finally {
          setIsLoading(false);
        }
      };
      fetchArchived();
    } else if (panelView === 'newChat') {
      const fetchClients = async () => {
        try {
          const res = await fetch('/api/clients');
          if (!res.ok) throw new Error('Falha ao buscar clientes.');
          const data = await res.json();
          setClients(data);
        } catch (err) {
          console.error(err);
          setError("Não foi possível carregar a lista de clientes.");
        }
      };
      fetchClients();
    }
  }, [panelView]);

  const handleLogin = (attendantId) => {
    const attendant = attendants.find(a => a.id === attendantId);
    setCurrentAttendant(attendant);
  };
  
  const handleTakeover = async (req) => {
    try {
      const response = await fetch(`/api/chats/takeover/${req.userId}`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendantId: currentAttendant.id })
      });
      if (!response.ok) throw new Error('Falha ao iniciar atendimento.');
      setActiveChat(req);
    } catch (err) {
      console.error(err);
      alert('Ocorreu um erro ao tentar iniciar o atendimento.');
    }
  };

  const handleOpenActiveChat = (chat) => {
    setActiveChat(chat);
  };
  
  const handleSendAttendantMessage = async (text) => {
      if (!text.trim() || !activeChat) return;
      const optimisticMessage = { sender: Sender.ATTENDANT, text, timestamp: new Date().toISOString() };
      setChatMessages(prev => [...prev, optimisticMessage]);
      try {
          await fetch('/api/chats/attendant-reply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: activeChat.userId, text, attendantId: currentAttendant.id }),
          });
      } catch (err) {
          console.error(err);
          alert('Ocorreu um erro ao enviar a sua mensagem.');
      }
  };
  
  const handleResolveChat = async () => {
      if (!activeChat) return;
      if (!confirm('Tem certeza que deseja resolver e fechar este atendimento?')) return;
      try {
          await fetch(`/api/chats/resolve/${activeChat.userId}`, { 
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attendantId: currentAttendant.id })
          });
          alert("Atendimento finalizado e arquivado com sucesso!");
          setActiveChat(null);
          setChatMessages([]);
          setPanelView('queue');
          await fetchData();
      } catch (err) {
          console.error(err);
          alert('Ocorreu um erro ao tentar resolver o atendimento.');
      }
  };

  const handleTransferChat = async (newAttendantId) => {
    if (!activeChat || !newAttendantId) return;
    try {
        await fetch(`/api/chats/transfer/${activeChat.userId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // FIX: Ensure the newAttendantId is a string, as expected by the server.
            body: JSON.stringify({ newAttendantId: String(newAttendantId), transferringAttendantId: currentAttendant.id }),
        });
        alert("Atendimento transferido com sucesso!");
        setActiveChat(null);
        setChatMessages([]);
        setPanelView('queue');
        await fetchData();
    } catch (err) {
        console.error(err);
        alert('Ocorreu um erro ao tentar transferir o atendimento.');
    }
  };

  const handleInitiateChat = async (event) => {
    event.preventDefault();
    const message = event.target.elements.message.value;
    const recipient = selectedRecipient ? selectedRecipient.userId : newChatSearch;

    if (!recipient || !message) {
      alert("Por favor, selecione um cliente ou digite um número, e preencha a mensagem.");
      return;
    }

    try {
        const response = await fetch('/api/chats/initiate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipientNumber: recipient, message, attendantId: currentAttendant.id }),
        });
        if(!response.ok) throw new Error(await response.text());
        const newChat = await response.json();
        alert("Conversa iniciada com sucesso!");
        setActiveChat(newChat); // Open the new chat immediately
        // Reset form
        setNewChatSearch('');
        setSelectedRecipient(null);
        event.target.elements.message.value = '';
    } catch (err) {
        console.error(err);
        alert(`Ocorreu um erro ao iniciar a conversa: ${err.message}`);
    }
  };

  // Handlers for New Chat autocomplete
  const handleSearchChange = (e) => {
      setNewChatSearch(e.target.value);
      setSelectedRecipient(null); // Clear selection when user types
  };
  const handleSelectClient = (client) => {
      setNewChatSearch(client.userName);
      setSelectedRecipient(client);
  };
  const filteredClients = newChatSearch && !selectedRecipient 
    ? clients.filter(c => 
        (c.userName && c.userName.toLowerCase().includes(newChatSearch.toLowerCase())) || 
        c.userId.includes(newChatSearch)
      ).slice(0, 5) // Limit results for performance
    : [];

  // Login Screen
  if (!currentAttendant) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-gray-100 p-4">
        <div className="w-full max-w-sm bg-white p-8 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold text-center text-gray-700 mb-2">Painel de Atendimento</h2>
          <p className="text-center text-gray-500 mb-6">Selecione seu usuário para continuar</p>
          <select 
            onChange={(e) => handleLogin(e.target.value)}
            defaultValue=""
            className="w-full p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[#005e54] mb-4"
          >
            <option value="" disabled>Selecione um atendente...</option>
            {attendants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {error && <p className="text-red-500 text-sm mt-2">{error}</p>}
        </div>
      </div>
    );
  }

  // Active Chat View
  if (activeChat) {
    const isMyChat = activeChat.attendantId === currentAttendant.id;
    return (
        <div className="flex flex-col h-full bg-gray-100">
            <header className="p-3 bg-white border-b border-gray-200 flex items-center justify-between flex-shrink-0">
                <div>
                  <button onClick={() => setActiveChat(null)} className="text-blue-600 hover:underline text-sm">&larr; Voltar</button>
                  <p className="font-semibold text-lg text-gray-800">{activeChat.userName || activeChat.userId}</p>
                </div>
                {isMyChat && (
                    <div className="flex items-center space-x-2">
                        <div className="relative group">
                            <button className="bg-yellow-500 text-white text-xs font-bold py-2 px-3 rounded-md hover:bg-yellow-600 transition-colors">
                                Transferir
                            </button>
                            <div className="absolute right-0 mt-1 w-48 bg-white rounded-md shadow-lg py-1 z-10 hidden group-hover:block">
                                {attendants.filter(a => a.id !== currentAttendant.id).map(a => (
                                    // FIX: The type error indicates a.id (string) is passed to a function expecting a number. Convert a.id to a number.
                                    <a href="#" key={a.id} onClick={() => handleTransferChat(Number(a.id))} className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">{a.name}</a>
                                ))}
                            </div>
                        </div>
                        <button onClick={handleResolveChat} className="bg-green-500 text-white text-xs font-bold py-2 px-3 rounded-md hover:bg-green-600 transition-colors">
                            Resolver
                        </button>
                    </div>
                )}
            </header>
            <ChatWindow messages={chatMessages} isBotTyping={isChatLoading}>
              {isChatLoading && chatMessages.length === 0 && (
                <div className="text-center text-gray-500 p-4">Carregando histórico...</div>
              )}
            </ChatWindow>
            {isMyChat ? (
                <ChatInput 
                    onUserInput={handleSendAttendantMessage} options={[]}
                    requiresTextInput={true} isBotTyping={false}
                    onFileChange={() => alert('Envio de arquivos pelo atendente não implementado.')}
                    selectedFile={null} placeholderText="Digite sua mensagem..."
                />
            ) : (
                <div className="p-4 bg-gray-200 text-center text-sm text-gray-600">
                    Este chat está sendo atendido por <strong>{attendants.find(a => a.id === activeChat.attendantId)?.name || 'outro atendente'}</strong>. (Modo Leitura)
                </div>
            )}
        </div>
    );
  }

  // Main Panel View (Queue, History, etc.)
  return (
    <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-white border-b border-gray-200 flex justify-between items-center pr-4">
             <nav className="flex">
                <button onClick={() => setPanelView('queue')} className={`px-4 py-3 text-sm font-medium ${panelView === 'queue' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>
                   Fila <span className="ml-1 bg-red-500 text-white text-xs font-bold rounded-full px-2">{requests.length}</span>
                </button>
                 <button onClick={() => setPanelView('active')} className={`px-4 py-3 text-sm font-medium ${panelView === 'active' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>
                   Ativos <span className="ml-1 bg-blue-500 text-white text-xs font-bold rounded-full px-2">{activeChats.length}</span>
                </button>
                <button onClick={() => setPanelView('history')} className={`px-4 py-3 text-sm font-medium ${panelView === 'history' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>Histórico</button>
                <button onClick={() => setPanelView('newChat')} className={`px-4 py-3 text-sm font-medium ${panelView === 'newChat' ? 'border-b-2 border-blue-500 text-blue-600' : 'text-gray-500 hover:text-gray-700'}`}>Nova Conversa</button>
             </nav>
             <div className="text-sm text-gray-600">
                Logado como: <strong className="font-semibold">{currentAttendant.name}</strong>
                <button onClick={() => setCurrentAttendant(null)} className="ml-2 text-blue-600 hover:underline text-xs">(Sair)</button>
             </div>
        </div>
        <div className="flex-1 overflow-y-auto bg-gray-100 p-4">
            {error && <div className="p-4 text-center text-red-500 bg-red-50 rounded-lg mb-4">{error}</div>}
            {panelView === 'queue' && (
                isLoading ? <div className="text-center text-gray-500 p-4">Carregando...</div> :
                requests.length === 0 ? <div className="text-center text-gray-500 mt-16">Nenhuma solicitação na fila.</div> :
                <div className="space-y-3">
                    {requests.map(req => (
                        <div key={req.id} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
                            <div className="flex justify-between items-start">
                                <div>
                                    <span className="text-xs font-semibold uppercase text-white bg-blue-500 px-2 py-1 rounded-full">{req.department}</span>
                                    <p className="font-semibold text-lg text-gray-800 mt-2">{req.userName || req.userId}</p>
                                </div>
                                <span className="text-xs text-gray-400">{new Date(req.timestamp).toLocaleTimeString('pt-BR')}</span>
                            </div>
                            <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap border-l-4 border-gray-200 pl-3">{req.message}</p>
                            <div className="text-right mt-3">
                                <button onClick={() => { stopTitleBlinking(); handleTakeover(req); }} className="bg-blue-500 text-white text-sm font-bold py-2 px-4 rounded-md hover:bg-blue-600">Atender</button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
             {panelView === 'active' && (
                isLoading ? <div className="text-center text-gray-500 p-4">Carregando...</div> :
                activeChats.length === 0 ? <div className="text-center text-gray-500 mt-16">Nenhum chat ativo no momento.</div> :
                <div className="space-y-3">
                    {activeChats.map(chat => (
                        <div key={chat.userId} onClick={() => handleOpenActiveChat(chat)} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 cursor-pointer hover:bg-gray-50">
                            <div className="flex justify-between items-start">
                                <div>
                                    <p className="font-semibold text-lg text-gray-800">{chat.userName || chat.userId}</p>
                                    <p className="text-sm text-gray-500">Atendido por: <strong>{attendants.find(a => a.id === chat.attendantId)?.name || 'Desconhecido'}</strong></p>
                                </div>
                                <span className="text-xs text-gray-400">{new Date(chat.timestamp).toLocaleTimeString('pt-BR')}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {panelView === 'history' && (
                 isLoading ? <div className="text-center text-gray-500 p-4">Carregando...</div> :
                 archivedChats.length === 0 ? <div className="text-center text-gray-500 mt-16">Nenhum chat no histórico.</div> :
                 <div className="space-y-3">
                    {archivedChats.map(chat => (
                        <div key={chat.userId} onClick={() => {
                            const historicChat = { userId: chat.userId, userName: chat.userName, attendantId: chat.resolvedBy };
                            setActiveChat(historicChat);
                        }} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 cursor-pointer hover:bg-gray-50">
                            <p className="font-semibold text-gray-800">{chat.userName || chat.userId}</p>
                            <div className="text-xs text-gray-500 mt-1">
                                <span>Resolvido por <strong>{attendants.find(a => a.id === chat.resolvedBy)?.name || 'N/A'}</strong> em {new Date(chat.resolvedAt).toLocaleString('pt-BR')}</span>
                            </div>
                        </div>
                    ))}
                 </div>
            )}
             {panelView === 'newChat' && (
                <div>
                    <h3 className="text-lg font-bold text-gray-700 mb-3">Iniciar Nova Conversa</h3>
                    <form onSubmit={handleInitiateChat} className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 space-y-4">
                        <div className="relative">
                            <label htmlFor="recipient" className="block text-sm font-medium text-gray-700">Cliente</label>
                            <input
                                type="text"
                                id="recipient"
                                name="recipient"
                                placeholder="Digite o nome ou número do cliente"
                                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                                value={newChatSearch}
                                onChange={handleSearchChange}
                                autoComplete="off"
                            />
                            {filteredClients.length > 0 && (
                                <div className="absolute z-10 w-full bg-white border border-gray-200 rounded-b-md shadow-lg max-h-60 overflow-y-auto">
                                    {filteredClients.map(client => (
                                        <div
                                            key={client.userId}
                                            onClick={() => handleSelectClient(client)}
                                            className="p-3 hover:bg-gray-100 cursor-pointer border-t"
                                        >
                                            <p className="font-semibold text-sm text-gray-800">{client.userName}</p>
                                            <p className="text-xs text-gray-500">{client.userId.split('@')[0]}</p>
                                        </div>
                                    ))}
                                </div>
                            )}
                            <p className="text-xs text-gray-500 mt-1">Se o cliente não estiver na lista, digite o número completo (Ex: 5511999998888).</p>
                        </div>
                        <div>
                            <label htmlFor="message" className="block text-sm font-medium text-gray-700">Mensagem Inicial</label>
                            <textarea id="message" name="message" rows="4" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm" required></textarea>
                        </div>
                        <div className="text-right">
                           <button type="submit" className="bg-green-500 text-white text-sm font-bold py-2 px-4 rounded-md hover:bg-green-600">Enviar e Iniciar Atendimento</button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    </div>
  );
};
// --- END: Merged from components/AttendantPanel.tsx ---


// --- START: Merged from App.tsx ---
const App = () => {
  const [messages, setMessages] = useState([]);
  const [isBotTyping, setIsBotTyping] = useState(true);
  const [currentChatState, setCurrentChatState] = useState(ChatState.GREETING);
  const [conversationContext, setConversationContext] = useState({ history: {} });
  const [selectedFile, setSelectedFile] = useState(null);
  const [aiHistory, setAiHistory] = useState([]);
  const [view, setView] = useState('chatbot');
  
  const abortControllerRef = useRef(null);
  
  const addMessage = useCallback((message) => {
    setMessages((prev) => [...prev, { ...message, id: Date.now() + Math.random(), timestamp: new Date().toISOString() }]);
  }, []);
  
  const getFlowResponse = useCallback((state, context) => {
    const flowStep = conversationFlow.get(state);
    
    if (!flowStep) {
        const greetingStep = conversationFlow.get(ChatState.GREETING);
        return {
            text: translations.pt[greetingStep.textKey] || "Error: Greeting text not found.",
            options: greetingStep.options?.map(opt => ({...opt, text: translations.pt[opt.textKey]})),
        };
    }

    let responseText;
    if (flowStep.textKey) {
        const template = translations.pt[flowStep.textKey];
        responseText = typeof template === 'function' ? template(context) : template;
    } else {
        responseText = typeof flowStep.text === 'function' ? flowStep.text(context) : (flowStep.text || '');
    }
    
    const responseOptions = flowStep.options?.map(opt => {
        const payload = typeof opt.payload === 'function' ? opt.payload(context) : opt.payload;
        return {
            ...opt,
            text: (opt.textKey ? translations.pt[opt.textKey] : opt.text) || 'Option',
            payload,
        };
    });
    
    return {
        text: responseText,
        options: responseOptions,
        requiresTextInput: flowStep.requiresTextInput
    };
  }, []);
  
  const processBotTurn = useCallback(async (nextState, context, userInput, file) => {
    setIsBotTyping(true);
    
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
        if (nextState === ChatState.AI_ASSISTANT_CHATTING) {
            if (!userInput && !file) { // First entry into AI chat
                await new Promise(res => setTimeout(res, 500));
                const botResponse = getFlowResponse(nextState, context);
                addMessage({ ...botResponse, sender: Sender.BOT });
                setCurrentChatState(nextState);
                if(aiHistory.length === 0) { // Only on first entry
                     setAiHistory([]); 
                }
            } else {
                let filePayload = null;
                if (file) {
                    const base64Data = await new Promise((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            if (typeof reader.result === 'string') {
                                resolve(reader.result.split(',')[1]);
                            } else {
                                reject(new Error('Failed to read file as a data URL string.'));
                            }
                        };
                        reader.onerror = reject;
                        reader.readAsDataURL(file);
                    });
                    filePayload = { name: file.name, type: file.type, data: base64Data };
                }

                const userMessageForHistory = { role: 'user', parts: [{ text: userInput }] };

                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: userInput,
                        file: filePayload,
                        session: {
                            currentState: nextState,
                            conversationContext: context,
                            aiHistory: aiHistory
                        }
                    }),
                    signal: controller.signal,
                });
                
                if (!response.ok || !response.body) {
                    throw new Error(`Server error: ${response.statusText}`);
                }

                let finalStreamedText = '';
                const messageId = Date.now() + Math.random();
                const timestamp = new Date().toISOString();
                setMessages(prev => [...prev, { id: messageId, text: '', sender: Sender.BOT, timestamp }]);

                const reader = response.body.getReader();
                const decoder = new TextDecoder();

                let reading = true;
                while(reading) {
                    const { done, value } = await reader.read();
                    if(done) {
                        reading = false;
                        break;
                    }
                    finalStreamedText += decoder.decode(value, { stream: true });
                    setMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, text: finalStreamedText } : msg));
                }

                const modelMessageForHistory = { role: 'model', parts: [{ text: finalStreamedText }] };
                setAiHistory([...aiHistory, userMessageForHistory, modelMessageForHistory]);
                
                const finalOptions = [{ text: translations.pt.backToStart, nextState: ChatState.GREETING }];
                setMessages(prev => prev.map(msg => msg.id === messageId ? { ...msg, text: finalStreamedText, options: finalOptions, requiresTextInput: true } : msg));
            }
        } else {
            await new Promise(res => setTimeout(res, 1000));
            setAiHistory([]); // Reset AI history when leaving the AI flow
            let currentState = nextState;
            let currentContext = { ...context };
            
            if(userInput && (currentChatState === ChatState.SCHEDULING_NEW_CLIENT_DETAILS || currentChatState === ChatState.SCHEDULING_EXISTING_CLIENT_DETAILS)) {
              currentContext.history[currentChatState] = userInput;
            }

            while (currentState !== undefined) {
                const flowStep = conversationFlow.get(currentState);
                if (!flowStep) {
                    currentState = ChatState.GREETING;
                    continue;
                }
                
                const botResponse = getFlowResponse(currentState, currentContext);
                addMessage({ ...botResponse, sender: Sender.BOT });
                
                setCurrentChatState(currentState);

                if (flowStep.nextState && !flowStep.requiresTextInput && (!flowStep.options || flowStep.options.length === 0)) {
                    await new Promise(res => setTimeout(res, 1000));
                    currentState = flowStep.nextState;
                } else {
                    currentState = undefined;
                }
            }
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log("Busca abortada");
            return;
        }
        console.error("Erro durante o turno do bot:", error);
        const errorMessage = "Desculpe, ocorreu um erro de comunicação com o servidor. Por favor, tente novamente.";
        const botResponse = {
            text: errorMessage,
            options: [{ text: translations.pt.backToStart, nextState: ChatState.GREETING }],
        };
        addMessage({ ...botResponse, sender: Sender.BOT });
        const fallbackState = currentChatState === ChatState.AI_ASSISTANT_CHATTING ? ChatState.AI_ASSISTANT_CHATTING : ChatState.GREETING;
        setCurrentChatState(fallbackState);
    } finally {
        setIsBotTyping(false);
        abortControllerRef.current = null;
    }
  }, [addMessage, getFlowResponse, currentChatState, aiHistory]);

  const handleUserInput = async (userInput, option) => {
    const userMessageText = option?.text ?? userInput;
    
    addMessage({
      text: userMessageText,
      sender: Sender.USER,
      file: selectedFile ? { name: selectedFile.name } : undefined,
    });
    
    const isEndSession = option?.nextState === ChatState.END_SESSION;
    if (isEndSession) {
      setIsBotTyping(true);
      await new Promise(res => setTimeout(res, 500));
      addMessage({ text: translations.pt.sessionEnded, sender: Sender.BOT });
      await new Promise(res => setTimeout(res, 1500));
      
      setMessages([]);
      setConversationContext({ history: {} });
      setAiHistory([]);
      setSelectedFile(null);

      await processBotTurn(ChatState.GREETING, {}, undefined, undefined);
      return;
    }

    let nextState = option ? option.nextState : currentChatState;
    let contextUpdate = option?.payload ? { ...conversationContext, ...option.payload } : { ...conversationContext };

    if (nextState === ChatState.AI_ASSISTANT_CHATTING && option?.payload?.department) {
        contextUpdate.department = option.payload.department;
        setAiHistory([]);
    }
    
    setConversationContext(contextUpdate);
    
    await processBotTurn(nextState, contextUpdate, userInput, selectedFile || undefined);
    setSelectedFile(null);
  };
  
  useEffect(() => {
    if (messages.length === 0) {
      processBotTurn(ChatState.GREETING, {}, undefined, undefined);
    }
  }, []);

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-white shadow-2xl rounded-lg overflow-hidden">
       <header className="bg-[#005e54] text-white p-3 flex items-center justify-between shadow-md flex-shrink-0">
        <div className="flex items-center">
            <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center mr-3 flex-shrink-0">
               <svg className="w-8 h-8 text-[#005e54]" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold">JZF Contabilidade</h1>
              <p className="text-sm text-gray-200">
                {view === 'chatbot' ? 'Assistente Virtual' : 'Painel de Atendimento'}
              </p>
            </div>
        </div>
        <button 
          onClick={() => setView(v => v === 'chatbot' ? 'attendant' : 'chatbot')}
          className="p-2 rounded-full hover:bg-white/20 transition-colors"
          title={view === 'chatbot' ? 'Ver Painel de Atendimento' : 'Ver Simulação do Chatbot'}
        >
          {view === 'chatbot' ? (
             <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          )}
        </button>
      </header>
      
      <main className="flex-1 overflow-y-hidden">
        {view === 'chatbot' ? (
            <div className="flex flex-col h-full">
            {/* FIX: Pass null as children to satisfy the component's prop requirements. */}
            <ChatWindow messages={messages} isBotTyping={isBotTyping}>{null}</ChatWindow>
            <ChatInput
                onUserInput={handleUserInput}
                options={lastMessage?.sender === Sender.BOT ? lastMessage.options : []}
                requiresTextInput={lastMessage?.sender === Sender.BOT ? lastMessage.requiresTextInput : false}
                isBotTyping={isBotTyping}
                onFileChange={setSelectedFile}
                selectedFile={selectedFile}
            />
            </div>
        ) : (
            <AttendantPanel />
        )}
      </main>
    </div>
  );
};
// --- END: Merged from App.tsx ---


// --- Final Render Call ---
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
