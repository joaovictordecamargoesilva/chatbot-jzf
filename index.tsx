
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
  
  const renderFile = (file, index) => {
    // Renderiza mídia com base64
    if (file.data && file.type) {
        const src = `data:${file.type};base64,${file.data}`;
        if (file.type.startsWith('image/')) {
            return <img key={index} src={src} alt={file.name} className="mt-2 max-w-xs rounded-lg shadow-md cursor-pointer" onClick={() => window.open(src, '_blank')} />;
        }
        if (file.type.startsWith('audio/')) {
            return <audio key={index} controls src={src} className="mt-2 w-full max-w-xs" />;
        }
        if (file.type.startsWith('video/')) {
            return <video key={index} controls src={src} className="mt-2 max-w-xs rounded-lg shadow-md" />;
        }
    }
    // Fallback para arquivos sem preview (ou formato antigo)
    return (
        <div key={index} className="mt-2 p-2 bg-gray-100 rounded-lg flex items-center space-x-2 border border-gray-200">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" />
                <path d="M8 8.5a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5zm0 2a.5.5 0 01.5-.5h3a.5.5 0 010 1h-3a.5.5 0 01-.5-.5z" />
            </svg>
            <span className="text-xs text-gray-700 truncate">{file.name}</span>
        </div>
    );
  };


  return (
    <div className={`flex w-full ${justifyClass}`}>
      <div
        className={`max-w-md md:max-w-lg lg:max-w-xl p-2 rounded-lg shadow-sm mb-1 flex flex-col ${bubbleClasses}`}
      >
        {/* NOVO: Bloco de Transcrição de Áudio */}
        {message.transcription && (
            <div className="text-sm italic text-gray-700 border-l-4 border-gray-400 bg-gray-50 rounded-r-md pl-3 py-2 mb-2 whitespace-pre-wrap">
                {message.transcription}
            </div>
        )}
        
        {message.text && <div className="text-sm whitespace-pre-wrap">{message.text}</div>}
        
        <div className="flex flex-col items-start">
             {/* Suporte ao novo formato `files` (array) e ao antigo `file` (objeto) */}
            {message.files && message.files.map(renderFile)}
            {message.file && !message.files && renderFile(message.file, 0)}
        </div>
        
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
  const [selectedFiles, setSelectedFiles] = useState([]);
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
     setSelectedFiles([]);
  }, [selectedChat?.userId]);
  
  // FIX: Added type for event and checked for event.target.files to handle file selection correctly and safely.
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    if (files.length > 0) {
        const filePromises = files.map(file => {
            return new Promise((resolve, reject) => {
                if (file.size > 15 * 1024 * 1024) { // Limite de 15MB por arquivo
                    return reject(new Error(`O arquivo ${file.name} é muito grande. O limite é 15MB.`));
                }
                const reader = new FileReader();
                reader.onload = (e) => {
                    if (e.target && typeof e.target.result === 'string') {
                        const base64Data = e.target.result.split(',')[1];
                        resolve({ name: file.name, type: file.type, data: base64Data });
                    } else {
                        reject(new Error(`Falha ao ler o arquivo ${file.name}.`));
                    }
                };
                reader.onerror = (error) => reject(error);
                reader.readAsDataURL(file);
            });
        });

        Promise.all(filePromises)
            .then(newFiles => setSelectedFiles(prev => [...prev, ...newFiles]))
            .catch(error => alert(error.message));
    }
    event.target.value = ''; // Reseta para poder selecionar os mesmos arquivos novamente
  };


  const handleSend = () => {
    if ((message.trim() || selectedFiles.length > 0) && selectedChat && attendant) {
      onSendMessage(selectedChat.userId, message.trim(), attendant.id, selectedFiles);
      setMessage('');
      setSelectedFiles([]);
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
             {/* Preview dos arquivos selecionados */}
            {selectedFiles.length > 0 && (
                <div className="p-2 mb-2 bg-blue-100 rounded-lg text-sm shadow-sm border border-blue-200 max-h-32 overflow-y-auto">
                    {selectedFiles.map((file, index) => (
                        <div key={index} className="flex items-center justify-between py-1">
                            <div className="flex items-center space-x-2 truncate">
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-blue-500 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                                   <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" />
                                </svg>
                                <span className="text-gray-700 truncate">{file.name}</span>
                            </div>
                            <button onClick={() => setSelectedFiles(files => files.filter((_, i) => i !== index))} className="text-red-500 hover:text-red-700 font-bold text-lg leading-none" aria-label="Remover arquivo">&times;</button>
                        </div>
                    ))}
                </div>
            )}
            <div className="flex items-center bg-white rounded-full shadow-sm px-2">
              <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" multiple />
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
                disabled={!message.trim() && selectedFiles.length === 0}
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
                .map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <div className="flex justify-end space-x-2">
              <button onClick={() => setTransferModalOpen(false)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500">
                Cancelar
              </button>
              <button onClick={handleTransfer} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
                Transferir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
// --- END: Merged from components/ChatPanel.tsx ---


// --- START: Merged from components/Sidebar.tsx ---
const Sidebar = ({ 
    chats, 
    activeChats, 
    aiChats,
    history, 
    onSelectChat, 
    selectedChatId, 
    activeTab, 
    setActiveTab,
    attendant,
    attendants,
    onInitiateChat,
    internalChatSummary,
    onSelectInternalChat,
    selectedInternalChatId
 }) => {
    const [isModalOpen, setModalOpen] = useState(false);
    const [recipientNumber, setRecipientNumber] = useState('');
    const [initialMessage, setInitialMessage] = useState('');

    const handleInitiate = () => {
        if (recipientNumber && initialMessage && attendant) {
            onInitiateChat(recipientNumber, initialMessage, attendant.id);
            setModalOpen(false);
            setRecipientNumber('');
            setInitialMessage('');
        } else {
            alert('Por favor, preencha todos os campos.');
        }
    };
    
    const renderLastMessage = (message) => {
        if (!message) return <span className="italic text-gray-400">Nenhuma mensagem ainda.</span>;

        let content = message.text || '';
        
        if (message.transcription) {
            // Remove a primeira linha da transcrição para um preview mais curto
            const shortTranscription = message.transcription.split('\n')[1] || '[Áudio]';
            content = `🎤 ${shortTranscription}`;
        } else if (message.files && message.files.length > 0) {
            content = `📄 [${message.files.length} anexo(s)] ${content}`;
        } else if (!content) {
            content = "Enviou um anexo."
        }
        
        const senderPrefix = message.sender === 'user' ? '' : 'Você: ';
        
        return `${senderPrefix}${content}`;
    }
    
    const renderInternalLastMessage = (message) => {
         if (!message) return <span className="italic text-gray-400">Nenhuma mensagem ainda.</span>;
         let content = message.text || '';
         if (message.files && message.files.length > 0) {
            content = `📄 [${message.files.length} anexo(s)] ${content}`;
         }
         const senderPrefix = message.senderId === attendant.id ? 'Você: ' : '';
         return `${senderPrefix}${content}`;
    }

    const tabs = [
        { id: 'queue', label: 'Na Fila', count: chats.length },
        { id: 'active', label: 'Ativos', count: activeChats.length },
        { id: 'ai', label: 'IA Ativos', count: aiChats.length },
        { id: 'internal', label: 'Interno', count: Object.keys(internalChatSummary).length},
        { id: 'history', label: 'Histórico', count: history.length }
    ];

    return (
        <aside className="w-full md:w-1/3 lg:w-1/4 xl:w-1/5 bg-white border-r border-gray-200 flex flex-col h-full">
            <header className="p-4 border-b border-gray-200 flex justify-between items-center">
                <h1 className="text-xl font-bold text-gray-800">Atendimentos</h1>
                <button 
                  onClick={() => setModalOpen(true)}
                  className="p-2 bg-blue-600 text-white rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 shadow-sm"
                  aria-label="Iniciar nova conversa"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clipRule="evenodd" />
                    </svg>
                </button>
            </header>
            
             {isModalOpen && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md">
                        <h3 className="text-lg font-semibold mb-4">Iniciar Nova Conversa</h3>
                        <input
                            type="text"
                            placeholder="Número do WhatsApp (ex: 55119...)"
                            value={recipientNumber}
                            onChange={(e) => setRecipientNumber(e.target.value)}
                            className="w-full p-2 border border-gray-300 rounded-md mb-3"
                        />
                        <textarea
                            placeholder="Sua primeira mensagem..."
                            value={initialMessage}
                            onChange={(e) => setInitialMessage(e.target.value)}
                            rows={4}
                            className="w-full p-2 border border-gray-300 rounded-md mb-4"
                        ></textarea>
                        <div className="flex justify-end space-x-2">
                            <button onClick={() => setModalOpen(false)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">
                                Cancelar
                            </button>
                            <button onClick={handleInitiate} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700">
                                Enviar
                            </button>
                        </div>
                    </div>
                </div>
            )}


            <div className="border-b border-gray-200">
                <nav className="flex space-x-1 p-1 bg-gray-100" aria-label="Tabs">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`
                                ${activeTab === tab.id ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}
                                rounded-md px-2 py-1 text-xs font-medium flex-1 text-center whitespace-nowrap
                            `}
                        >
                            {tab.label} {tab.count > 0 && `(${tab.count})`}
                        </button>
                    ))}
                </nav>
            </div>

            <div className="flex-1 overflow-y-auto">
                {activeTab === 'queue' && (
                    <ul>
                        {chats.map(chat => (
                            <li key={chat.id} onClick={() => onSelectChat(chat.userId, 'bot')}
                                className={`p-3 border-b border-gray-200 cursor-pointer hover:bg-gray-50 ${selectedChatId === chat.userId ? 'bg-blue-50' : ''}`}
                            >
                                <div className="font-semibold text-gray-800">{chat.userName || chat.userId}</div>
                                <div className="text-sm text-gray-600 truncate">{chat.department ? `Setor: ${chat.department}` : 'Aguardando'}</div>
                                <div className="text-xs text-gray-400 mt-1">{new Date(chat.timestamp).toLocaleString()}</div>
                            </li>
                        ))}
                    </ul>
                )}
                
                {activeTab === 'active' && (
                     <ul>
                        {activeChats
                          // FIX: Added types for sort arguments and used .getTime() for date comparison to fix type errors.
                          .sort((a: any, b: any) => new Date(b.lastMessage?.timestamp || 0).getTime() - new Date(a.lastMessage?.timestamp || 0).getTime())
                          .map(chat => {
                            const currentAttendant = attendants.find(at => at.id === chat.attendantId);
                            const isMyChat = attendant && chat.attendantId === attendant.id;
                            return (
                                <li key={chat.userId} onClick={() => onSelectChat(chat.userId, 'human')}
                                    className={`p-3 border-b border-gray-200 cursor-pointer hover:bg-gray-50 ${selectedChatId === chat.userId ? 'bg-blue-50' : ''}`}
                                >
                                    <div className={`font-semibold ${isMyChat ? 'text-green-700' : 'text-gray-800'}`}>{chat.userName || chat.userId}</div>
                                    <div className="text-sm text-gray-600 truncate">{renderLastMessage(chat.lastMessage)}</div>
                                    <div className="text-xs text-gray-400 mt-1">
                                        Atendido por: {currentAttendant?.name || 'Desconhecido'}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
                
                {activeTab === 'ai' && (
                    <ul>
                        {aiChats
                            // FIX: Added types for sort arguments and used .getTime() for date comparison to fix type errors.
                            .sort((a: any, b: any) => new Date(b.lastMessage?.timestamp || 0).getTime() - new Date(a.lastMessage?.timestamp || 0).getTime())
                            .map(chat => (
                            <li key={chat.userId} onClick={() => onSelectChat(chat.userId, 'bot')}
                                className={`p-3 border-b border-gray-200 cursor-pointer hover:bg-gray-50 ${selectedChatId === chat.userId ? 'bg-blue-50' : ''}`}
                            >
                                <div className="font-semibold text-gray-800">{chat.userName || chat.userId}</div>
                                <div className="text-sm text-gray-600 truncate">{renderLastMessage(chat.lastMessage)}</div>
                                 <div className="text-xs text-blue-500 mt-1">
                                    Setor IA: {chat.department || 'N/A'}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
                
                {activeTab === 'internal' && (
                    <ul>
                        {Object.entries(internalChatSummary)
                         // FIX: Added types for sort/map arguments and used .getTime() for date comparison to fix type errors.
                         .sort(([, a]: [string, any], [, b]: [string, any]) => new Date(b.lastMessage?.timestamp || 0).getTime() - new Date(a.lastMessage?.timestamp || 0).getTime())
                         .map(([partnerId, summary]: [string, any]) => {
                            const partner = attendants.find(a => a.id === partnerId);
                            return (
                                <li key={partnerId} onClick={() => onSelectInternalChat(partnerId)}
                                    className={`p-3 border-b border-gray-200 cursor-pointer hover:bg-gray-50 ${selectedInternalChatId === partnerId ? 'bg-blue-50' : ''}`}
                                >
                                    <div className="font-semibold text-gray-800">{partner?.name || 'Desconhecido'}</div>
                                    <div className="text-sm text-gray-600 truncate">{renderInternalLastMessage(summary.lastMessage)}</div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {activeTab === 'history' && (
                    <ul>
                        {history.map(chat => (
                            <li key={chat.userId} onClick={() => onSelectChat(chat.userId, 'history')}
                                className={`p-3 border-b border-gray-200 cursor-pointer hover:bg-gray-50 ${selectedChatId === chat.userId ? 'bg-blue-50' : ''}`}
                            >
                                <div className="font-semibold text-gray-800">{chat.userName || chat.userId}</div>
                                <div className="text-sm text-gray-500">Resolvido por: {chat.resolvedBy}</div>
                                <div className="text-xs text-gray-400 mt-1">{new Date(chat.resolvedAt).toLocaleString()}</div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </aside>
    );
};
// --- END: Merged from components/Sidebar.tsx ---


// --- START: Merged from components/InternalChatPanel.tsx ---
const InternalChatPanel = ({ 
    partner, 
    chatHistory, 
    attendant, 
    onSendMessage 
}) => {
    const [message, setMessage] = useState('');
    const [selectedFiles, setSelectedFiles] = useState([]);
    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [chatHistory]);

    useEffect(() => {
        setMessage('');
        setSelectedFiles([]);
    }, [partner?.id]);
    
    // FIX: Added type for event and checked for event.target.files to handle file selection correctly and safely.
    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files ? Array.from(event.target.files) : [];
        if (files.length > 0) {
            const filePromises = files.map(file => {
                return new Promise((resolve, reject) => {
                    if (file.size > 15 * 1024 * 1024) {
                        return reject(new Error(`O arquivo ${file.name} é muito grande (limite de 15MB).`));
                    }
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        if (e.target && typeof e.target.result === 'string') {
                            const base64Data = e.target.result.split(',')[1];
                            resolve({ name: file.name, type: file.type, data: base64Data });
                        } else {
                            reject(new Error(`Falha ao ler o arquivo ${file.name}.`));
                        }
                    };
                    reader.onerror = error => reject(error);
                    reader.readAsDataURL(file);
                });
            });
            Promise.all(filePromises)
                .then(newFiles => setSelectedFiles(prev => [...prev, ...newFiles]))
                .catch(error => alert(error.message));
        }
        event.target.value = '';
    };


    const handleSend = () => {
        if ((message.trim() || selectedFiles.length > 0) && partner && attendant) {
            onSendMessage(attendant.id, partner.id, message.trim(), selectedFiles);
            setMessage('');
            setSelectedFiles([]);
        }
    };
    
    if (!partner) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center bg-gray-100 text-gray-500">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 mb-4" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M2 5a2 2 0 012-2h7a2 2 0 012 2v4a2 2 0 01-2 2H9l-3 3v-3H4a2 2 0 01-2-2V5z" />
                    <path d="M15 7v2a4 4 0 01-4 4H9.828l-1.766 1.767c.28.149.599.233.938.233h2l3 3v-3h1a2 2 0 002-2V9a2 2 0 00-2-2h-1z" />
                </svg>
                <span>Selecione um colega na aba "Interno" para conversar.</span>
            </div>
        );
    }

    return (
        <div className="flex-1 flex flex-col bg-gray-100">
            <header className="bg-white p-3 border-b border-gray-200 flex justify-between items-center shadow-sm">
                <h2 className="font-semibold text-gray-800">Conversa com {partner.name}</h2>
            </header>

            <div className="flex-1 overflow-y-auto p-4 whatsapp-bg">
                {chatHistory.map((msg, index) => {
                    const isMe = msg.senderId === attendant.id;
                    const bubbleClasses = isMe ? 'bg-[#dcf8c6] self-end' : 'bg-white self-start';
                    const justifyClass = isMe ? 'justify-end' : 'justify-start';

                    return (
                        <div key={index} className={`flex w-full ${justifyClass}`}>
                            <div className={`max-w-md md:max-w-lg lg:max-w-xl p-2 rounded-lg shadow-sm mb-1 flex flex-col ${bubbleClasses}`}>
                                {!isMe && <div className="font-bold text-xs text-purple-600 mb-1">{msg.senderName}</div>}
                                {msg.text && <div className="text-sm whitespace-pre-wrap">{msg.text}</div>}
                                
                                {msg.files && msg.files.map((file, i) => (
                                    <div key={i} className="mt-2 p-2 bg-gray-100 rounded-lg flex items-center space-x-2 border border-gray-200">
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 text-gray-500" viewBox="0 0 20 20" fill="currentColor">
                                          <path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" />
                                        </svg>
                                        <span className="text-xs text-gray-700 truncate">{file.name}</span>
                                    </div>
                                ))}

                                <div className="text-xs text-gray-400 self-end mt-1">
                                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </div>
                            </div>
                        </div>
                    );
                })}
                <div ref={messagesEndRef} />
            </div>

            <footer className="bg-gray-200 p-3">
                 {selectedFiles.length > 0 && (
                    <div className="p-2 mb-2 bg-blue-100 rounded-lg text-sm shadow-sm border border-blue-200 max-h-32 overflow-y-auto">
                        {selectedFiles.map((file, index) => (
                            <div key={index} className="flex items-center justify-between py-1">
                                <span className="text-gray-700 truncate">{file.name}</span>
                                <button onClick={() => setSelectedFiles(files => files.filter((_, i) => i !== index))} className="text-red-500 hover:text-red-700 font-bold text-lg">&times;</button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="flex items-center bg-white rounded-full shadow-sm px-2">
                    <button 
                        onClick={() => fileInputRef.current.click()}
                        className="p-2 text-gray-500 hover:text-blue-600 rounded-full"
                    >
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                           <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                         </svg>
                    </button>
                    <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="hidden" multiple />
                    <input
                        type="text"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleSend()}
                        placeholder="Mensagem interna..."
                        className="w-full p-2 bg-transparent focus:outline-none"
                    />
                    <button onClick={handleSend} className="p-2 text-blue-600 hover:text-blue-800 rounded-full">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor">
                           <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                        </svg>
                    </button>
                </div>
            </footer>
        </div>
    );
};
// --- END: Merged from components/InternalChatPanel.tsx ---

// --- Main App Component ---
const App = () => {
    const [attendants, setAttendants] = useState([]);
    const [attendant, setAttendant] = useState(null);
    const [isLoadingAttendant, setIsLoadingAttendant] = useState(true);
    
    const [chats, setChats] = useState([]); // Fila de espera
    const [activeChats, setActiveChats] = useState([]); // Atendimentos ativos (humanos)
    const [aiChats, setAiChats] = useState([]); // Atendimentos ativos (IA)
    const [history, setHistory] = useState([]);
    const [clients, setClients] = useState([]);
    
    const [selectedChat, setSelectedChat] = useState(null);
    const [isLoadingChat, setIsLoadingChat] = useState(false);
    
    const [activeTab, setActiveTab] = useState('queue'); // 'queue', 'active', 'ai', 'internal', 'history'
    
    // State para chat interno
    const [internalChatSummary, setInternalChatSummary] = useState({});
    const [selectedInternalPartner, setSelectedInternalPartner] = useState(null);
    const [internalChatHistory, setInternalChatHistory] = useState([]);
    const isInternalChatSelected = activeTab === 'internal' && selectedInternalPartner;

    const POLLING_INTERVAL = 2000; // 2 segundos para atualizações rápidas

    // Função de fetch de dados centralizada
    const fetchData = useCallback(async (currentAttendant) => {
        try {
            const endpoints = [
                '/api/requests', 
                '/api/chats/active', 
                '/api/chats/ai-active', 
                '/api/chats/history', 
                '/api/clients'
            ];
             if (currentAttendant) {
                endpoints.push(`/api/internal-chats/summary/${currentAttendant.id}`);
            }

            const responses = await Promise.all(endpoints.map(url => fetch(url)));
            const data = await Promise.all(responses.map(res => res.json()));

            setChats(data[0]);
            setActiveChats(data[1]);
            setAiChats(data[2]);
            setHistory(data[3]);
            setClients(data[4]);
            if (currentAttendant) {
                setInternalChatSummary(data[5] || {});
            }
            
        } catch (error) {
            console.error("Falha ao buscar dados:", error);
        }
    }, []);

    // Efeito para login e fetch inicial
    useEffect(() => {
        const fetchAndSetAttendant = async () => {
            try {
                const res = await fetch('/api/attendants');
                const existingAttendants = await res.json();
                setAttendants(existingAttendants);

                const storedId = localStorage.getItem('attendantId');
                if (storedId) {
                    const found = existingAttendants.find(a => a.id === storedId);
                    if (found) {
                        setAttendant(found);
                        fetchData(found); // Fetch inicial com o atendente logado
                    } else {
                         localStorage.removeItem('attendantId'); // Limpa ID inválido
                    }
                }
            } catch (error) {
                console.error("Falha ao buscar atendentes:", error);
            } finally {
                setIsLoadingAttendant(false);
            }
        };
        fetchAndSetAttendant();
    }, [fetchData]);

    // Efeito para polling contínuo
    useEffect(() => {
        if (attendant) {
            const intervalId = setInterval(() => fetchData(attendant), POLLING_INTERVAL);
            return () => clearInterval(intervalId);
        }
    }, [attendant, fetchData]);

    // Efeito para buscar histórico do chat interno ao selecionar parceiro
    useEffect(() => {
        const fetchInternalHistory = async () => {
            if (isInternalChatSelected) {
                try {
                    const res = await fetch(`/api/internal-chats/${attendant.id}/${selectedInternalPartner.id}`);
                    const history = await res.json();
                    setInternalChatHistory(history);
                } catch (error) {
                    console.error("Falha ao buscar histórico do chat interno:", error);
                }
            }
        };
        fetchInternalHistory();
        
        // Polling para o chat interno específico
        if (isInternalChatSelected) {
            const intervalId = setInterval(fetchInternalHistory, POLLING_INTERVAL);
            return () => clearInterval(intervalId);
        }
    }, [isInternalChatSelected, attendant?.id, selectedInternalPartner?.id]);


    // Atualiza o chat selecionado quando os dados mudam
    useEffect(() => {
        if (selectedChat) {
            handleSelectChat(selectedChat.userId, selectedChat.type);
        }
    }, [chats, activeChats, aiChats, history]);
    
    const handleLogin = (id) => {
        const selected = attendants.find(a => a.id === id);
        if (selected) {
            setAttendant(selected);
            localStorage.setItem('attendantId', id);
        }
    };

    const handleCreateAttendant = async (name) => {
        try {
            const res = await fetch('/api/attendants', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (res.ok) {
                const newAttendant = await res.json();
                setAttendants(prev => [...prev, newAttendant]);
                handleLogin(newAttendant.id);
            } else {
                const error = await res.json();
                alert(`Erro: ${error.error}`);
            }
        } catch (error) {
            console.error("Falha ao criar atendente:", error);
            alert("Falha na comunicação com o servidor.");
        }
    };
    
    const handleLogout = () => {
        setAttendant(null);
        localStorage.removeItem('attendantId');
        setSelectedChat(null);
        setSelectedInternalPartner(null);
    };

    const handleSelectChat = async (userId, type) => {
        setSelectedInternalPartner(null); // Desseleciona chat interno
        if (selectedChat?.userId === userId) return;
        setIsLoadingChat(true);
        try {
            const res = await fetch(`/api/chats/history/${userId}`);
            if (res.ok) {
                const chatData = await res.json();
                setSelectedChat({ ...chatData, type });
            } else {
                console.error("Chat não encontrado:", userId);
                setSelectedChat(null);
            }
        } catch (error) {
            console.error("Falha ao buscar chat:", error);
        } finally {
            setIsLoadingChat(false);
        }
    };
    
    const handleSelectInternalChat = (partnerId) => {
        const partner = attendants.find(a => a.id === partnerId);
        if(partner) {
            setSelectedChat(null); // Desseleciona chat de cliente
            setSelectedInternalPartner(partner);
        }
    };
    
    const handleSendMessage = async (userId, text, attendantId, files) => {
        try {
            const res = await fetch('/api/chats/attendant-reply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, text, attendantId, files }),
            });
            if (res.ok) {
                // Adiciona a mensagem localmente para uma UI mais responsiva
                 setSelectedChat(prev => {
                    if (!prev || prev.userId !== userId) return prev;
                    const newMessage = { sender: 'attendant', text, files, timestamp: new Date().toISOString() };
                    return { ...prev, messageLog: [...prev.messageLog, newMessage] };
                 });
            }
        } catch (error) {
            console.error("Falha ao enviar mensagem:", error);
        }
    };
    
    const handleSendInternalMessage = async (senderId, recipientId, text, files) => {
         try {
            const res = await fetch('/api/internal-chats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ senderId, recipientId, text, files }),
            });
            if (res.ok) {
                const newMessage = await res.json();
                setInternalChatHistory(prev => [...prev, newMessage]);
            }
        } catch (error) {
            console.error("Falha ao enviar mensagem interna:", error);
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
                await fetchData(attendant); // Atualiza as listas
                setActiveTab('active'); // Muda para a aba de ativos
                handleSelectChat(userId, 'human'); // Seleciona o chat
            }
        } catch (error) {
            console.error("Falha ao assumir atendimento:", error);
        }
    };

    const handleResolveChat = async (userId) => {
        if (!attendant) return;
        try {
            const res = await fetch(`/api/chats/resolve/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ attendantId: attendant.id }),
            });
            if (res.ok) {
                setSelectedChat(null);
                await fetchData(attendant);
                setActiveTab('history');
            }
        } catch (error) {
            console.error("Falha ao resolver atendimento:", error);
        }
    };

    const handleTransferChat = async (userId, newAttendantId) => {
        if (!attendant) return;
        try {
            const res = await fetch(`/api/chats/transfer/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newAttendantId, transferringAttendantId: attendant.id }),
            });
            if (res.ok) {
                setSelectedChat(null); // Fecha o chat da sua visão
                await fetchData(attendant);
                setActiveTab('active');
            }
        } catch (error) {
            console.error("Falha ao transferir atendimento:", error);
        }
    };
    
    const handleInitiateChat = async (recipientNumber, message, attendantId) => {
        try {
            const res = await fetch('/api/chats/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ recipientNumber, message, attendantId }),
            });
             if (res.ok) {
                const newChat = await res.json();
                await fetchData(attendant);
                setActiveTab('active');
                handleSelectChat(newChat.userId, 'human');
            } else {
                const errorText = await res.text();
                alert(`Erro ao iniciar conversa: ${errorText}`);
            }
        } catch(e) {
            console.error("Falha ao iniciar chat", e);
            alert("Erro de comunicação ao iniciar chat.");
        }
    };

    if (isLoadingAttendant) {
        return <div className="flex items-center justify-center h-screen">Carregando...</div>;
    }

    if (!attendant) {
        return (
            <div className="flex items-center justify-center h-screen bg-gray-100">
                <div className="w-full max-w-sm p-8 bg-white rounded-lg shadow-md">
                    <h2 className="text-2xl font-bold text-center text-gray-800 mb-6">Login de Atendente</h2>
                    <select
                        onChange={(e) => handleLogin(e.target.value)}
                        defaultValue=""
                        className="w-full p-2 mb-4 border border-gray-300 rounded-md"
                    >
                        <option value="" disabled>Selecione seu nome</option>
                        {attendants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <p className="text-center my-4 text-gray-500">ou</p>
                    <div className="flex flex-col">
                         <input
                            type="text"
                            placeholder="Digite seu nome para criar"
                            id="new-attendant-name"
                            className="w-full p-2 mb-4 border border-gray-300 rounded-md"
                        />
                        <button
                           onClick={() => {
                                // FIX: Cast element to HTMLInputElement to safely access its value.
                                const input = document.getElementById('new-attendant-name') as HTMLInputElement | null;
                                if (input && input.value) handleCreateAttendant(input.value);
                           }}
                           className="w-full bg-green-600 text-white p-2 rounded-md hover:bg-green-700"
                        >
                            Criar Novo Atendente
                        </button>
                    </div>
                </div>
            </div>
        );
    }
    
    // --- Renderização Principal ---
    return (
      <div className="flex h-screen font-sans antialiased text-gray-900 bg-gray-50">
          <div className="fixed top-0 left-0 w-full bg-blue-800 text-white p-2 text-center text-xs z-10 shadow-md">
            <span>Você está logado como: <strong>{attendant.name}</strong></span>
            <button onClick={handleLogout} className="ml-4 text-blue-200 hover:text-white font-bold text-xs">[Sair]</button>
          </div>
          <div className="flex w-full pt-8"> {/* pt-8 para compensar o header fixo */}
             <Sidebar
                  chats={chats}
                  activeChats={activeChats}
                  aiChats={aiChats}
                  history={history}
                  onSelectChat={handleSelectChat}
                  selectedChatId={selectedChat?.userId}
                  activeTab={activeTab}
                  setActiveTab={setActiveTab}
                  attendant={attendant}
                  attendants={attendants}
                  onInitiateChat={handleInitiateChat}
                  internalChatSummary={internalChatSummary}
                  onSelectInternalChat={handleSelectInternalChat}
                  selectedInternalChatId={selectedInternalPartner?.id}
              />
              {isInternalChatSelected ? (
                 <InternalChatPanel 
                    partner={selectedInternalPartner}
                    chatHistory={internalChatHistory}
                    attendant={attendant}
                    onSendMessage={handleSendInternalMessage}
                 />
              ) : (
                 <ChatPanel
                      selectedChat={selectedChat}
                      attendant={attendant}
                      attendants={attendants}
                      onSendMessage={handleSendMessage}
                      onResolveChat={handleResolveChat}
                      onTransferChat={handleTransferChat}
                      onTakeoverChat={handleTakeoverChat}
                      isLoading={isLoadingChat}
                  />
              )}
          </div>
      </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
