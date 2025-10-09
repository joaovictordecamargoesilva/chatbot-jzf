import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import ImageEditor from 'tui-image-editor';
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

// --- NOVO COMPONENTE: ImageEditorModal ---
const ImageEditorModal = ({ file, onSave, onCancel }) => {
    const editorRef = useRef(null);
    const editorInstance = useRef(null);

    useEffect(() => {
        if (!editorRef.current || !file) return;

        // Destrói a instância anterior para evitar memory leaks
        if (editorInstance.current) {
            editorInstance.current.destroy();
            editorInstance.current = null;
        }
        
        const imageUrl = `data:${file.type};base64,${file.data}`;

        editorInstance.current = new ImageEditor(editorRef.current, {
            includeUI: {
                loadImage: {
                    path: imageUrl,
                    name: file.name,
                },
                menu: ['crop', 'draw', 'text'],
                initMenu: 'draw',
                uiSize: {
                    width: '100%',
                    height: '100%',
                },
                menuBarPosition: 'bottom',
                locale: {
                    'Crop': 'Recortar',
                    'Draw': 'Desenhar',
                    'Text': 'Texto',
                    'Apply': 'Aplicar',
                    'Cancel': 'Cancelar',
                    'Rectangle': 'Retângulo',
                    'Triangle': 'Triângulo',
                    'Circle': 'Círculo',
                    'Free': 'Livre',
                    'Straight': 'Reta',
                    'Color': 'Cor',
                    'Range': 'Tamanho',
                }
            },
            cssMaxWidth: document.documentElement.clientWidth * 0.9,
            cssMaxHeight: document.documentElement.clientHeight * 0.8,
            selectionStyle: {
                cornerSize: 20,
                rotatingPointOffset: 70,
            },
        });
        
        // Corrige o bug do redimensionamento do canvas
        const handleResize = () => editorInstance.current?.ui.resizeEditor();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (editorInstance.current) {
                editorInstance.current.destroy();
            }
        };
    }, [file]);

    const handleSave = () => {
        if (editorInstance.current) {
            const dataUrl = editorInstance.current.toDataURL();
            onSave(dataUrl);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-75 flex flex-col items-center justify-center z-[100]">
            <div className="relative w-[95vw] h-[85vh] bg-white shadow-lg rounded-md">
                <div ref={editorRef} style={{ width: '100%', height: '100%' }}></div>
            </div>
            <div className="mt-4 flex space-x-4">
                <button onClick={onCancel} className="px-6 py-2 bg-gray-300 text-gray-800 font-semibold rounded-lg hover:bg-gray-400">Cancelar</button>
                <button onClick={handleSave} className="px-6 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700">Salvar Alterações</button>
            </div>
        </div>
    );
};


// --- NOVO COMPONENTE: Lightbox ---
const Lightbox = ({ src, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[100]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Visualizador de imagem"
    >
      <div className="relative p-4 w-full h-full flex items-center justify-center">
        {/* Evita que o clique na imagem feche o modal */}
        <img
          src={src}
          alt="Visualização ampliada"
          className="max-w-[90vw] max-h-[90vh] object-contain shadow-lg rounded-md"
          onClick={(e) => e.stopPropagation()}
        />
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-white text-4xl font-bold hover:text-gray-300 transition-colors"
          aria-label="Fechar"
        >
          &times;
        </button>
      </div>
    </div>
  );
};


// --- ATUALIZADO: FileRenderer ---
// Helper para renderizar diferentes tipos de arquivo de forma inteligente
const FileRenderer = ({ file, onImageClick }) => {
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
        return <img src={fileSrc} alt={file.name} className="mt-2 rounded-lg max-w-xs md:max-w-sm max-h-80 object-contain cursor-pointer" onClick={() => onImageClick(fileSrc)} />;
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
const MessageBubble = ({ message, onImageClick, onSetReply, onSetEdit, isFromAttendant = false }) => {
  const [isMenuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const isBot = message.sender === Sender.BOT;
  const isAttendant = message.sender === Sender.ATTENDANT;
  const isSystem = message.sender === Sender.SYSTEM;

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
  
  const files = message.files || (message.file ? [message.file] : []);
  const canInteract = !isSystem;

  return (
    <div className={`flex w-full ${justifyClass} group items-center`}>
      <div className={`relative flex items-center ${isAttendant ? 'flex-row-reverse' : ''}`}>
        {/* Container da Bolha de Mensagem */}
        <div
          className={`max-w-md md:max-w-lg lg:max-w-xl p-2 rounded-lg shadow-sm mb-1 flex flex-col ${bubbleClasses}`}
        >
          {/* Contexto da Resposta */}
          {message.replyTo && (
              <div className="p-2 mb-1 text-xs bg-gray-500 bg-opacity-10 rounded-md border-l-2 border-blue-400">
                  <p className="font-semibold text-blue-500">{message.replyTo.senderName}</p>
                  <p className="text-gray-600 truncate">{message.replyTo.text || 'Arquivo'}</p>
              </div>
          )}
          
          {message.text && <div className="text-sm whitespace-pre-wrap">{message.text}</div>}
          
          {files.length > 0 && (
              <div className="mt-1 flex flex-col space-y-2">
                  {files.map((file, index) => (
                      <FileRenderer key={index} file={file} onImageClick={onImageClick} />
                  ))}
              </div>
          )}

          <div className="text-xs text-gray-400 self-end mt-1 flex items-center">
            {message.edited && <span className="mr-1 italic text-gray-500">editada</span>}
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

        {/* Menu de Opções */}
        {canInteract && (
          <div className="relative self-start mb-1">
              <button
                onClick={() => setMenuOpen(prev => !prev)}
                className={`p-1 text-gray-400 rounded-full opacity-0 group-hover:opacity-100 hover:bg-gray-300 focus:outline-none transition-opacity ${isAttendant ? 'mr-2' : 'ml-2'}`}
                aria-label="Opções da mensagem"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                </svg>
              </button>
              {isMenuOpen && (
                <div ref={menuRef} className={`absolute top-6 z-10 w-32 bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 ${isAttendant ? 'right-0' : 'left-0'}`}>
                    <div className="py-1" role="menu" aria-orientation="vertical">
                       <button onClick={() => { onSetReply(message); setMenuOpen(false); }} className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100" role="menuitem">Responder</button>
                       {isFromAttendant && message.text && (
                          <button onClick={() => { onSetEdit(message); setMenuOpen(false); }} className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100" role="menuitem">Editar</button>
                       )}
                    </div>
                </div>
              )}
          </div>
        )}
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
  onEditMessage,
  onResolveChat,
  onTransferChat,
  onTakeoverChat,
  isLoading,
  attendants,
  onImageClick,
  selectedFiles,
  setSelectedFiles,
  onFileSelect,
  onEditFile
}) => {
  const [message, setMessage] = useState('');
  const [isTransferModalOpen, setTransferModalOpen] = useState(false);
  const [transferToAttendantId, setTransferToAttendantId] = useState('');
  const [replyingToMessage, setReplyingToMessage] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [editedText, setEditedText] = useState("");
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const messageInputRef = useRef(null);
  
  const chatType = selectedChat?.handledBy === 'bot' ? 'bot' : 'human';

  const handleSetEdit = (msg) => {
    setEditingMessage(msg);
    setEditedText(msg.text);
    setReplyingToMessage(null); // Cancela a resposta se estiver editando
  };

  const handleCancelEdit = () => {
    setEditingMessage(null);
    setEditedText("");
  };

  const handleSaveEdit = () => {
    if (editingMessage && editedText.trim()) {
      onEditMessage(selectedChat.userId, editingMessage.timestamp, editedText.trim());
      handleCancelEdit();
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [selectedChat?.messageLog, isLoading]);
  
  useEffect(() => {
     setMessage('');
     //setSelectedFiles([]); // REMOVIDO: A limpeza agora é feita no componente pai (App) ao trocar de chat.
     setReplyingToMessage(null);
     setEditingMessage(null);
  }, [selectedChat?.userId]);

  const handleSend = () => {
    if ((message.trim() || selectedFiles.length > 0) && selectedChat && attendant) {
      onSendMessage(selectedChat.userId, message.trim(), attendant.id, selectedFiles, replyingToMessage);
      setMessage('');
      setSelectedFiles([]);
      setReplyingToMessage(null);
      messageInputRef.current?.focus();
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
          <MessageBubble key={index} message={msg} onImageClick={onImageClick} onSetReply={setReplyingToMessage} onSetEdit={handleSetEdit} isFromAttendant={msg.sender === Sender.ATTENDANT} />
        ))}
        {isLoading && <TypingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      {/* Rodapé do Chat (Input) */}
      {chatType === 'human' && attendant?.id === selectedChat.attendantId && (
          <footer className="bg-gray-200 p-3">
            {editingMessage ? (
                 <div className="bg-white rounded-lg shadow-sm p-2">
                    <p className="text-xs font-semibold text-yellow-600 mb-1">Editando mensagem...</p>
                    <input
                        type="text"
                        value={editedText}
                        onChange={(e) => setEditedText(e.target.value)}
                        onKeyPress={(e) => e.key === 'Enter' && handleSaveEdit()}
                        className="w-full p-2 bg-gray-100 border border-gray-300 rounded-md mb-2 focus:outline-none focus:ring-2 focus:ring-yellow-500"
                        autoFocus
                    />
                    <div className="flex justify-end space-x-2">
                        <button onClick={handleCancelEdit} className="px-3 py-1 text-xs font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">Cancelar</button>
                        <button onClick={handleSaveEdit} className="px-3 py-1 text-xs font-medium text-white bg-green-600 rounded-md hover:bg-green-700">Salvar</button>
                    </div>
                </div>
            ) : (
              <>
                {replyingToMessage && (
                    <div className="p-2 mb-2 bg-blue-50 rounded-lg text-sm shadow-sm border-l-4 border-blue-400 relative">
                        <p className="font-semibold text-blue-600 text-xs">Respondendo a {replyingToMessage.sender === 'user' ? selectedChat.userName : 'Você'}</p>
                        <p className="text-gray-700 truncate">{replyingToMessage.text || (replyingToMessage.files?.[0]?.name || 'Arquivo')}</p>
                        <button
                            onClick={() => setReplyingToMessage(null)}
                            className="absolute top-1 right-1 text-gray-500 hover:text-gray-800 font-bold text-lg leading-none"
                            aria-label="Cancelar resposta"
                        >
                            &times;
                        </button>
                    </div>
                )}
                {selectedFiles.length > 0 && (
                     <div className="p-2 mb-2 bg-blue-100 rounded-lg shadow-sm border border-blue-200 max-h-40 overflow-y-auto">
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                            {selectedFiles.map((file, index) => (
                                <div key={index} className="relative group bg-white rounded-md p-1">
                                    {file.type.startsWith('image/') ? (
                                        <img src={`data:${file.type};base64,${file.data}`} alt={file.name} className="w-full h-16 object-cover rounded"/>
                                    ) : (
                                        <div className="w-full h-16 flex flex-col items-center justify-center bg-gray-200 rounded">
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" /></svg>
                                            <span className="text-xs text-gray-600 w-full text-center truncate px-1">{file.name}</span>
                                        </div>
                                    )}
                                    <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded">
                                        {file.type.startsWith('image/') && (
                                            <button onClick={() => onEditFile({file, context: {list: 'main', index}})} className="p-1 text-white hover:text-yellow-300" aria-label="Editar imagem">
                                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" /></svg>
                                            </button>
                                        )}
                                        <button onClick={() => setSelectedFiles(files => files.filter((_, i) => i !== index))} className="p-1 text-white hover:text-red-400" aria-label="Remover arquivo">
                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg>
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
                <div className="flex items-center bg-white rounded-full shadow-sm px-2">
                  <input type="file" ref={fileInputRef} onChange={onFileSelect} className="hidden" multiple />
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
                    ref={messageInputRef}
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
              </>
            )}
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
  const [internalSelectedFiles, setInternalSelectedFiles] = useState([]);
  const internalFileInputRef = useRef(null);
  const internalMessageInputRef = useRef(null);
  
  // Estados para Responder e Editar no Chat Interno
  const [replyingToInternal, setReplyingToInternal] = useState(null);
  const [editingInternal, setEditingInternal] = useState(null);
  const [editedInternalText, setEditedInternalText] = useState("");
  
  const [selectedFiles, setSelectedFiles] = useState([]); // Estado para arquivos do chat principal

  // Estados para edição de imagem
  const [editingFile, setEditingFile] = useState(null); // { file: object, context: { list: 'main'|'internal', index: number } }

  const sidebarRef = useRef(null); // Ref para a barra lateral rolável

  // Estados para o modal de iniciar chat
  const [isInitiateModalOpen, setInitiateModalOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [initiateStep, setInitiateStep] = useState('select'); // 'select' | 'message'
  const [selectedClient, setSelectedClient] = useState(null);
  const [initiateMessage, setInitiateMessage] = useState('');
  const [clientSearchTerm, setClientSearchTerm] = useState('');

  const [lightboxSrc, setLightboxSrc] = useState(null);
  const [notifications, setNotifications] = useState({ queue: 0, active: new Set(), ai_active: new Set(), internal: new Set() });
  const [internalChatsSummary, setInternalChatsSummary] = useState({});
  const prevData = useRef(null);

  const showBrowserNotification = useCallback((title, options) => {
    if (document.hidden && Notification.permission === 'granted') {
      new Notification(title, options);
      const audio = new Audio('https://cdn.freesound.org/previews/220/220173_4100837-lq.mp3');
      audio.play().catch(e => console.error("Erro ao tocar áudio:", e));
    }
  }, []);

  useEffect(() => {
    if (!prevData.current || !attendant) {
        prevData.current = { requestQueue, activeChats, aiActiveChats, internalChatsSummary };
        return;
    }
  
    const newNotifications = { ...notifications };
    let changed = false;

    if (requestQueue.length > prevData.current.requestQueue.length) {
        const newRequest = requestQueue[0];
        showBrowserNotification("Nova solicitação na fila", { body: `Cliente: ${newRequest.userName}\nMotivo: ${newRequest.message}` });
        newNotifications.queue = requestQueue.length;
        changed = true;
    } else if (requestQueue.length !== prevData.current.requestQueue.length) {
        newNotifications.queue = requestQueue.length;
        changed = true;
    }

    const activeNotifications = new Set(notifications.active);
    activeChats.forEach(chat => {
      const prevChat = prevData.current.activeChats.find(c => c.userId === chat.userId);
      if ( chat.lastMessage?.sender === 'user' && (!prevChat?.lastMessage || new Date(chat.lastMessage.timestamp) > new Date(prevChat.lastMessage.timestamp))) {
        if (selectedChat?.userId !== chat.userId) {
          activeNotifications.add(chat.userId);
          showBrowserNotification(`Nova mensagem de ${chat.userName}`, { body: chat.lastMessage.text || 'Arquivo recebido.' });
        }
      }
      if (chat.attendantId === attendant.id && prevChat && prevChat.attendantId !== attendant.id) {
          const transferrer = attendants.find(a => a.id === prevChat.attendantId);
          activeNotifications.add(chat.userId);
          showBrowserNotification(`Atendimento transferido para você`, { body: `Cliente: ${chat.userName}\nDe: ${transferrer?.name || 'outro atendente'}` });
      }
    });
    if (activeNotifications.size !== notifications.active.size || [...activeNotifications].some(id => !notifications.active.has(id))) {
        newNotifications.active = activeNotifications;
        changed = true;
    }

    const aiNotifications = new Set(notifications.ai_active);
    aiActiveChats.forEach(chat => {
      const prevChat = prevData.current.aiActiveChats.find(c => c.userId === chat.userId);
      if ( chat.lastMessage?.sender === 'user' && (!prevChat?.lastMessage || new Date(chat.lastMessage.timestamp) > new Date(prevChat.lastMessage.timestamp))) {
         if (selectedChat?.userId !== chat.userId) {
            aiNotifications.add(chat.userId);
            showBrowserNotification(`Cliente interagiu com IA: ${chat.userName}`, { body: chat.lastMessage.text || 'Arquivo recebido.' });
         }
      }
    });
     if (aiNotifications.size !== notifications.ai_active.size || [...aiNotifications].some(id => !notifications.ai_active.has(id))) {
        newNotifications.ai_active = aiNotifications;
        changed = true;
    }
    
    const internalNotifications = new Set(notifications.internal);
    Object.keys(internalChatsSummary).forEach(partnerId => {
      const current = internalChatsSummary[partnerId];
      const prev = prevData.current.internalChatsSummary[partnerId];
      if ( current?.lastMessage && current.lastMessage.senderId !== attendant.id && (!prev?.lastMessage || new Date(current.lastMessage.timestamp) > new Date(prev.lastMessage.timestamp))) {
         if (internalChatPartner?.id !== partnerId) {
            internalNotifications.add(partnerId);
            const senderName = attendants.find(a => a.id === current.lastMessage.senderId)?.name || 'Colega';
            showBrowserNotification(`Mensagem interna de ${senderName}`, { body: current.lastMessage.text || 'Arquivo recebido.' });
         }
      }
    });
    if (internalNotifications.size !== notifications.internal.size || [...internalNotifications].some(id => !notifications.internal.has(id))) {
        newNotifications.internal = internalNotifications;
        changed = true;
    }

    if (changed) {
        setNotifications(newNotifications);
    }

    const totalNotifications = newNotifications.queue + newNotifications.active.size + newNotifications.ai_active.size + newNotifications.internal.size;
    document.title = totalNotifications > 0 ? `(${totalNotifications}) JZF Atendimento` : 'JZF Atendimento';

    prevData.current = { requestQueue, activeChats, aiActiveChats, internalChatsSummary };

  }, [requestQueue, activeChats, aiActiveChats, internalChatsSummary, selectedChat, internalChatPartner, attendant, attendants, showBrowserNotification]);


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

      setRequestQueue(current => JSON.stringify(current) !== JSON.stringify(reqData) ? reqData : current);
      setActiveChats(current => JSON.stringify(current) !== JSON.stringify(activeData) ? activeData : current);
      setChatHistory(current => JSON.stringify(current) !== JSON.stringify(historyData) ? historyData : current);
      setAttendants(current => JSON.stringify(current) !== JSON.stringify(attendantsData) ? attendantsData : current);
      setAiActiveChats(current => JSON.stringify(current) !== JSON.stringify(aiChatsData) ? aiChatsData : current);
      setInternalChatsSummary(current => JSON.stringify(current) !== JSON.stringify(internalSummaryData) ? internalSummaryData : current);

      if (selectedChat) {
          const allCurrentChats = [...activeData, ...aiChatsData];
          const updatedChatInList = allCurrentChats.find(c => c.userId === selectedChat.userId);
          const localLastMessage = selectedChat.messageLog.length > 0 ? selectedChat.messageLog[selectedChat.messageLog.length - 1] : null;

          if (updatedChatInList && updatedChatInList.lastMessage && (!localLastMessage || new Date(updatedChatInList.lastMessage.timestamp) > new Date(localLastMessage.timestamp))) {
              const res = await fetch(`/api/chats/history/${selectedChat.userId}`);
              if (res.ok) {
                  const fullChatData = await res.json();
                  setSelectedChat(prevChat => ({ ...prevChat, messageLog: fullChatData.messageLog }));
              }
          }
      }
    } catch (err) {
      setError(err.message);
      console.error(err);
    }
  }, [attendant, selectedChat]);

  useEffect(() => {
    fetch('/api/attendants').then(res => res.json()).then(setAttendants);
  }, []);

  useEffect(() => {
    if (attendant) {
      fetchData();
      const interval = setInterval(fetchData, 2500);
      return () => clearInterval(interval);
    }
  }, [attendant, fetchData]);
  
  useEffect(() => {
    const fetchClients = async () => {
        try {
            const res = await fetch('/api/clients');
            if (res.ok) setClients(await res.json());
        } catch (err) { console.error("Falha ao buscar clientes:", err); }
    };
    if (attendant) fetchClients();
  }, [attendant]);

  useEffect(() => {
    if (internalChatPartner && attendant) {
      const fetchInternalHistory = async () => {
        try {
          const res = await fetch(`/api/internal-chats/${attendant.id}/${internalChatPartner.id}`);
          if (res.ok) {
            const data = await res.json();
            setInternalChatMessages(current => JSON.stringify(current) !== JSON.stringify(data) ? data : current);
          }
        } catch (err) { console.error("Falha ao buscar chat interno:", err); }
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
      if (Notification.permission !== "granted") Notification.requestPermission();
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
    } catch (err) { alert(err.message); }
  };

  const handleLogout = () => {
    setAttendant(null);
    localStorage.removeItem('attendantId');
  };

  const handleSelectChatItem = async (item) => {
    setIsLoading(true);
    setSelectedChat(null);
    setSelectedFiles([]); // Limpa a pré-visualização de arquivos ao trocar de chat
    try {
        const res = await fetch(`/api/chats/history/${item.userId}`);
        if(res.ok){
            const data = await res.json();
            const handledBy = activeView === 'ai_active' ? 'bot' : 'human';
            setSelectedChat({ ...item, ...data, handledBy: data.handledBy || handledBy });

            const notificationSetKey = activeView === 'active' ? 'active' : 'ai_active';
            const notificationSet = notifications[notificationSetKey];

            if (notificationSet instanceof Set && notificationSet.has(item.userId)) {
                const updatedSet = new Set(notificationSet);
                updatedSet.delete(item.userId);
                setNotifications(prev => ({ ...prev, [notificationSetKey]: updatedSet }));
            }
        } else { throw new Error('Falha ao buscar histórico do chat.'); }
    } catch (err) { alert(err.message); } 
    finally { setIsLoading(false); }
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
        const takeoverData = await res.json();
        await fetchData(); 
        setActiveView('active');
        setTimeout(() => handleSelectChatItem(takeoverData), 100);
      } else { throw new Error('Falha ao assumir o atendimento.'); }
    } catch (err) { alert(err.message); }
  };

  const handleSendMessage = async (userId, text, attendantId, files, replyTo = null) => {
      if (text === '/finalizar') { handleResolveChat(userId); return; }
      
      const replyContext = replyTo ? {
          text: replyTo.text || (replyTo.files?.[0]?.name || 'Arquivo'),
          sender: replyTo.sender,
          senderName: replyTo.sender === 'user' ? selectedChat.userName : 'Você',
          timestamp: replyTo.timestamp
      } : null;

      const tempMessage = {
          sender: Sender.ATTENDANT, text,
          files: files,
          timestamp: new Date().toISOString(), replyTo: replyContext,
      };
      setSelectedChat(prev => ({ ...prev, messageLog: [...prev.messageLog, tempMessage] }));

      try {
          await fetch('/api/chats/attendant-reply', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId, text, attendantId, files, replyTo: replyContext }),
          });
      } catch (err) { alert('Falha ao enviar mensagem.'); }
  };

  const handleEditMessage = async (userId, messageTimestamp, newText) => {
    setSelectedChat(prev => {
        const newLog = prev.messageLog.map(msg => 
            msg.timestamp === messageTimestamp ? { ...msg, text: newText, edited: true } : msg
        );
        return { ...prev, messageLog: newLog };
    });
    try {
        await fetch('/api/chats/edit-message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, attendantId: attendant.id, messageTimestamp, newText })
        });
    } catch (err) { alert('Falha ao editar mensagem.'); }
  };

  const handleResolveChat = async (userId) => {
    if (!attendant) return;
    const sidebarScrollPosition = sidebarRef.current?.scrollTop;
    try {
      const res = await fetch(`/api/chats/resolve/${userId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendantId: attendant.id }),
      });
      if (res.ok) {
        alert('Atendimento resolvido com sucesso!');
        setSelectedChat(null);
        setActiveView('queue');
        await fetchData();
        requestAnimationFrame(() => { if (sidebarRef.current) sidebarRef.current.scrollTop = sidebarScrollPosition; });
      } else { throw new Error('Falha ao resolver o atendimento.'); }
    } catch (err) { alert(err.message); }
  };
  
  const handleTransferChat = async (userId, newAttendantId) => {
    if (!attendant) return;
    const sidebarScrollPosition = sidebarRef.current?.scrollTop;
    try {
      const res = await fetch(`/api/chats/transfer/${userId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newAttendantId, transferringAttendantId: attendant.id }),
      });
      if (res.ok) {
        const targetAttendant = attendants.find(a => a.id === newAttendantId);
        alert(`Atendimento transferido com sucesso para ${targetAttendant?.name || 'outro atendente'}!`);
        setSelectedChat(null);
        setActiveView('queue');
        await fetchData();
        requestAnimationFrame(() => { if (sidebarRef.current) sidebarRef.current.scrollTop = sidebarScrollPosition; });
      } else {
        const errorText = await res.text();
        throw new Error(errorText || 'Falha ao transferir o atendimento.');
      }
    } catch (err) { alert(err.message); }
  };
  
    // --- LÓGICA DE SELEÇÃO DE ARQUIVO ROBUSTA (CORRIGIDA) ---
    const readFileAsBase64 = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => { // Usa o evento 'onload' para acesso seguro
                const result = event.target?.result;
                if (result && typeof result === 'string') {
                    const base64Data = result.split(',')[1];
                    resolve({ name: file.name, type: file.type, data: base64Data });
                } else {
                    reject(new Error('Falha ao ler o resultado do arquivo. Formato inesperado.'));
                }
            };
            reader.onerror = (error) => reject(error); // Rejeita com o evento de erro
            reader.readAsDataURL(file);
        });
    };

    const handleFileSelect = async (event) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        let currentTotalSize = selectedFiles.reduce((acc, f) => acc + (atob(f.data).length), 0);
        const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB
        let filesToProcess = [];

        for (const file of Array.from(files)) {
            if (file.size > 15 * 1024 * 1024) {
                alert(`O arquivo "${file.name}" é muito grande. O limite individual é de 15MB.`);
                continue;
            }
            if (currentTotalSize + file.size > MAX_TOTAL_SIZE) {
                alert("O tamanho total dos anexos excede 50MB. Alguns arquivos não foram adicionados.");
                break;
            }
            currentTotalSize += file.size;
            filesToProcess.push(readFileAsBase64(file));
        }

        try {
            const newFiles = await Promise.all(filesToProcess);
            setSelectedFiles(prev => [...prev, ...newFiles]);
        } catch (error) {
            console.error("Erro ao processar arquivos:", error);
            alert("Ocorreu um erro ao carregar um ou mais arquivos.");
        } finally {
            event.target.value = null; // Limpa o input para permitir a seleção do mesmo arquivo novamente
        }
    };
    
    const handleInternalFileSelect = async (event) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        
        const filesToProcess = Array.from(files).map(file => {
             if (file.size > 15 * 1024 * 1024) { 
                alert(`O arquivo "${file.name}" é muito grande (limite de 15MB).`); 
                return null;
            }
            return readFileAsBase64(file);
        }).filter(Boolean); // Filtra arquivos nulos (inválidos)
        
        try {
            const newFiles = await Promise.all(filesToProcess);
            setInternalSelectedFiles(prev => [...prev, ...newFiles]);
        } catch (error) {
            console.error("Erro ao processar arquivos internos:", error);
            alert("Ocorreu um erro ao carregar um ou mais arquivos.");
        } finally {
            event.target.value = null;
        }
    };
  
    const handleSaveEditedImage = (newBase64Data) => {
        if (!editingFile) return;
    
        const { file, context } = editingFile;
        const newData = newBase64Data.split(',')[1]; // Remove o prefixo data:image/...;base64,
    
        if (context.list === 'main') {
            const updatedFiles = [...selectedFiles];
            updatedFiles[context.index] = { ...file, data: newData };
            setSelectedFiles(updatedFiles);
        } else if (context.list === 'internal') {
            const updatedFiles = [...internalSelectedFiles];
            updatedFiles[context.index] = { ...file, data: newData };
            setInternalSelectedFiles(updatedFiles);
        }
    
        setEditingFile(null); // Fecha o modal
    };

  const handleSendInternalMessage = async () => {
    if ((!internalMessage.trim() && internalSelectedFiles.length === 0) || !attendant || !internalChatPartner) return;
    const text = internalMessage.trim();
    const files = internalSelectedFiles;
    
    const replyContext = replyingToInternal ? {
        text: replyingToInternal.text || (replyingToInternal.files?.[0]?.name || 'Arquivo'),
        senderId: replyingToInternal.senderId,
        senderName: replyingToInternal.senderName,
        timestamp: replyingToInternal.timestamp
    } : null;

    const tempMessage = {
      senderId: attendant.id, senderName: attendant.name, text,
      files: files,
      timestamp: new Date().toISOString(), replyTo: replyContext,
    };
    setInternalChatMessages(prev => [...prev, tempMessage]);
    
    setInternalMessage('');
    setInternalSelectedFiles([]);
    setReplyingToInternal(null);
    internalMessageInputRef.current?.focus();

    try {
      await fetch('/api/internal-chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          senderId: attendant.id, recipientId: internalChatPartner.id,
          text, files, replyTo: replyContext,
        }),
      });
    } catch (err) { console.error("Falha ao enviar mensagem interna:", err); }
  };
  
  const handleEditInternalMessage = async (newText) => {
    if (!editingInternal) return;
    const { timestamp, senderId } = editingInternal;
    
    setInternalChatMessages(prev => prev.map(msg => 
        msg.timestamp === timestamp ? { ...msg, text: newText, edited: true } : msg
    ));
    
    try {
        await fetch('/api/internal-chats/edit-message', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                senderId, recipientId: internalChatPartner.id, 
                messageTimestamp: timestamp, newText
            })
        });
    } catch (err) { alert('Falha ao editar mensagem interna.'); }
    
    setEditingInternal(null);
    setEditedInternalText("");
  };

  const handleInitiateChat = async () => {
    if (!initiateMessage.trim() || !attendant || !selectedClient) return;
    try {
        const res = await fetch('/api/chats/initiate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipientNumber: selectedClient.userId, message: initiateMessage.trim(),
                attendantId: attendant.id
            })
        });
        if (res.ok) {
            const newChat = await res.json();
            handleCloseInitiateModal();
            await fetchData();
            setActiveView('active');
            setTimeout(() => handleSelectChatItem(newChat), 100);
        } else {
            const errorText = await res.text();
            throw new Error(errorText || "Falha ao iniciar conversa.");
        }
    } catch (err) { alert(err.message); }
  };

  const handleCloseInitiateModal = () => {
      setInitiateModalOpen(false);
      setInitiateStep('select');
      setSelectedClient(null);
      setInitiateMessage('');
      setClientSearchTerm('');
  };

  const handleNavClick = (view) => {
      setActiveView(view);
      setSelectedChat(null);
      setInternalChatPartner(null);
      if (view === 'queue' && notifications.queue > 0) setNotifications(prev => ({...prev, queue: 0}));
      else if (notifications[view] instanceof Set && notifications[view].size > 0) setNotifications(prev => ({...prev, [view]: new Set()}));
  };

  const handleOpenLightbox = (src) => setLightboxSrc(src);
  const handleCloseLightbox = () => setLightboxSrc(null);

  useEffect(() => {
    const savedAttendantId = localStorage.getItem('attendantId');
    if (savedAttendantId && attendants.length > 0) handleLogin(savedAttendantId);
  }, [attendants]);


  if (!attendant) {
    return <Login attendants={attendants} onLogin={handleLogin} onRegister={handleRegister} />;
  }

  const filteredClients = clients.filter(c =>
    c.userName.toLowerCase().includes(clientSearchTerm.toLowerCase()) || c.userId.includes(clientSearchTerm)
  );

  const ListItem = ({ item, onClick, isSelected = false, children = null }) => (
    <li
      onClick={onClick}
      className={`p-3 cursor-pointer border-b border-gray-200 hover:bg-gray-100 transition-colors duration-75 ${isSelected ? 'bg-blue-100' : 'bg-white'}`}
    >
      <p className="font-semibold text-gray-800 truncate">{item.userName || item.name || item.id}</p>
      {children}
    </li>
  );

  const NavButton = ({ view, label, count }) => (
    <button onClick={() => handleNavClick(view)} className={`relative flex-1 p-2 text-sm font-semibold rounded-md transition-colors duration-150 ${activeView === view ? 'bg-white shadow' : 'text-gray-600 hover:bg-gray-200'}`}>
        {label} {count > 0 && <span className="absolute top-0 right-0 -mt-1 -mr-1 px-1.5 py-0.5 bg-red-500 text-white text-xs rounded-full">{count}</span>}
    </button>
  );

  return (
    <div className="flex h-screen font-sans bg-gray-100 text-gray-800">
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
        
        <nav className="flex p-1 bg-gray-100">
            <NavButton view="queue" label="Fila" count={notifications.queue} />
            <NavButton view="active" label="Ativos" count={notifications.active.size} />
            <NavButton view="ai_active" label="Virtual" count={notifications.ai_active.size} />
            <NavButton view="history" label="Histórico" count={0} />
            <NavButton view="internal_chat" label="Interno" count={notifications.internal.size} />
        </nav>

        <div ref={sidebarRef} className="flex-1 overflow-y-auto smooth-scroll">
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
                            const newInternal = new Set(notifications.internal); newInternal.delete(a.id);
                            setNotifications(p => ({ ...p, internal: newInternal }));
                        }
                   }} isSelected={internalChatPartner?.id === a.id}>
                       {lastMessage && (
                           <p className={`text-xs truncate mt-1 ${hasUnread ? 'text-gray-800 font-bold' : 'text-gray-500'}`}>
                               {lastMessage.senderId === attendant.id && 'Você: '}{lastMessage.text || (lastMessage.files?.[0] ? `Arquivo: ${lastMessage.files[0].name}`: '...')}
                           </p>
                       )}
                   </ListItem>
                );
            })}
          </ul>
        </div>
      </aside>

      <main className="flex-1 flex flex-col">
        {activeView !== 'internal_chat' && (
          <ChatPanel
            selectedChat={selectedChat} attendant={attendant}
            onSendMessage={handleSendMessage} onEditMessage={handleEditMessage}
            onResolveChat={handleResolveChat} onTransferChat={handleTransferChat}
            onTakeoverChat={handleTakeoverChat} isLoading={isLoading}
            attendants={attendants} onImageClick={handleOpenLightbox}
            selectedFiles={selectedFiles} setSelectedFiles={setSelectedFiles}
            onFileSelect={handleFileSelect} onEditFile={setEditingFile}
          />
        )}
        
        {activeView === 'internal_chat' && (
           <div className="flex-1 flex flex-col bg-gray-100">
            {!internalChatPartner ? (
                <div className="flex-1 flex items-center justify-center text-gray-500"><span>Selecione um atendente para conversar.</span></div>
            ) : (
                <>
                    <header className="bg-white p-3 border-b border-gray-200"><h2 className="font-semibold">{internalChatPartner.name}</h2></header>
                    <div className="flex-1 overflow-y-auto p-4 whatsapp-bg">
                        {internalChatMessages.map((msg, index) => (
                           <MessageBubble 
                              key={index} message={{...msg, sender: msg.senderId === attendant.id ? Sender.ATTENDANT : Sender.USER}}
                              onImageClick={handleOpenLightbox}
                              onSetReply={setReplyingToInternal}
                              onSetEdit={(m) => { setEditingInternal(m); setEditedInternalText(m.text); }}
                              isFromAttendant={msg.senderId === attendant.id}
                           />
                        ))}
                        <div ref={internalMessagesEndRef} />
                    </div>
                    <footer className="bg-gray-200 p-3">
                        {editingInternal ? (
                            <div className="bg-white rounded-lg shadow-sm p-2">
                                <p className="text-xs font-semibold text-yellow-600 mb-1">Editando mensagem...</p>
                                <input type="text" value={editedInternalText} onChange={(e) => setEditedInternalText(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleEditInternalMessage(editedInternalText)} className="w-full p-2 bg-gray-100 border border-gray-300 rounded-md mb-2 focus:outline-none focus:ring-2 focus:ring-yellow-500" autoFocus />
                                <div className="flex justify-end space-x-2">
                                    <button onClick={() => setEditingInternal(null)} className="px-3 py-1 text-xs font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">Cancelar</button>
                                    <button onClick={() => handleEditInternalMessage(editedInternalText)} className="px-3 py-1 text-xs font-medium text-white bg-green-600 rounded-md hover:bg-green-700">Salvar</button>
                                </div>
                            </div>
                        ) : (
                          <>
                            {replyingToInternal && (
                                <div className="p-2 mb-2 bg-blue-50 rounded-lg text-sm shadow-sm border-l-4 border-blue-400 relative">
                                    <p className="font-semibold text-blue-600 text-xs">Respondendo a {replyingToInternal.senderName}</p>
                                    <p className="text-gray-700 truncate">{replyingToInternal.text || 'Arquivo'}</p>
                                    <button onClick={() => setReplyingToInternal(null)} className="absolute top-1 right-1 text-gray-500 hover:text-gray-800 font-bold text-lg leading-none">&times;</button>
                                </div>
                            )}
                            {internalSelectedFiles.length > 0 && (
                                <div className="p-2 mb-2 bg-blue-100 rounded-lg shadow-sm border border-blue-200 max-h-40 overflow-y-auto">
                                   <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                                        {internalSelectedFiles.map((file, index) => (
                                            <div key={index} className="relative group bg-white rounded-md p-1">
                                                {file.type.startsWith('image/') ? (
                                                    <img src={`data:${file.type};base64,${file.data}`} alt={file.name} className="w-full h-16 object-cover rounded"/>
                                                ) : (
                                                    <div className="w-full h-16 flex flex-col items-center justify-center bg-gray-200 rounded">
                                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-500" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h8V4H6z" clipRule="evenodd" /></svg>
                                                        <span className="text-xs text-gray-600 w-full text-center truncate px-1">{file.name}</span>
                                                    </div>
                                                )}
                                                <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded">
                                                    {file.type.startsWith('image/') && (
                                                        <button onClick={() => setEditingFile({file, context: {list: 'internal', index}})} className="p-1 text-white hover:text-yellow-300" aria-label="Editar imagem">
                                                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" /><path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" /></svg>
                                                        </button>
                                                    )}
                                                    <button onClick={() => setInternalSelectedFiles(files => files.filter((_, i) => i !== index))} className="p-1 text-white hover:text-red-400" aria-label="Remover arquivo">
                                                         <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clipRule="evenodd" /></svg>
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                            <div className="flex items-center bg-white rounded-full shadow-sm px-2">
                                 <input type="file" ref={internalFileInputRef} onChange={handleInternalFileSelect} className="hidden" multiple />
                                  <button onClick={() => internalFileInputRef.current.click()} className="p-2 text-gray-500 hover:text-blue-600 rounded-full" aria-label="Anexar arquivo"><svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg></button>
                                <input ref={internalMessageInputRef} type="text" value={internalMessage} onChange={e => setInternalMessage(e.target.value)} onKeyPress={e => e.key === 'Enter' && handleSendInternalMessage()} placeholder={`Mensagem para ${internalChatPartner.name}...`} className="w-full p-2 bg-transparent focus:outline-none" />
                                <button onClick={handleSendInternalMessage} disabled={!internalMessage.trim() && internalSelectedFiles.length === 0} className="p-2 text-blue-600 rounded-full disabled:text-gray-400"><svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg></button>
                            </div>
                          </>
                        )}
                    </footer>
                </>
            )}
           </div>
        )}
      </main>

      {isInitiateModalOpen && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-lg flex flex-col" style={{height: '80vh'}}>
                  {initiateStep === 'select' ? (
                      <>
                          <h3 className="text-lg font-semibold mb-4">Iniciar Nova Conversa</h3>
                          <p className="text-sm text-gray-600 mb-4">Selecione um contato para enviar uma mensagem.</p>
                          <input type="text" placeholder="Buscar por nome ou número..." value={clientSearchTerm} onChange={e => setClientSearchTerm(e.target.value)} className="w-full p-2 border border-gray-300 rounded-md mb-4" />
                          <div className="flex-1 overflow-y-auto border rounded-md">
                              <ul>
                                  {filteredClients.length > 0 ? filteredClients.map(client => (
                                      <li key={client.userId} onClick={() => { setSelectedClient(client); setInitiateStep('message'); }} className="p-3 cursor-pointer hover:bg-gray-100 border-b">
                                          <p className="font-semibold">{client.userName}</p>
                                          <p className="text-xs text-gray-500">{client.userId.split('@')[0]}</p>
                                      </li>
                                  )) : <li className="p-4 text-center text-gray-500">Nenhum contato encontrado.</li>}
                              </ul>
                          </div>
                          <div className="flex justify-end mt-4"><button onClick={handleCloseInitiateModal} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-md hover:bg-gray-300">Cancelar</button></div>
                      </>
                  ) : (
                      <>
                          <h3 className="text-lg font-semibold mb-4">Enviar Mensagem</h3>
                          <p className="text-sm text-gray-600 mb-4">Para: <span className="font-semibold">{selectedClient?.userName} ({selectedClient?.userId.split('@')[0]})</span></p>
                          <textarea value={initiateMessage} onChange={e => setInitiateMessage(e.target.value)} placeholder="Digite sua primeira mensagem..." className="w-full flex-1 p-2 border border-gray-300 rounded-md mb-4 resize-none"></textarea>
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
      
      {editingFile && (
          <ImageEditorModal
              file={editingFile.file}
              onSave={handleSaveEditedImage}
              onCancel={() => setEditingFile(null)}
          />
      )}

      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={handleCloseLightbox} />}

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
