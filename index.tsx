import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import ImageEditor from 'tui-image-editor';
import { conversationFlow, translations, ChatState as ChatStateValues } from './chatbotLogic.js';

// --- START: Merged from types.ts ---
const Sender = {
  USER: 'user',
  BOT: 'bot',
  ATTENDANT: 'attendant',
  SYSTEM: 'system', 
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

// --- COMPONENTE: MessageStatusIcon (Ticks do WhatsApp) ---
const MessageStatusIcon = ({ status }) => {
    // Status do Baileys: 0: ERROR, 1: PENDING, 2: SERVER_ACK (Enviado), 3: DELIVERY_ACK (Entregue), 4: READ (Lido), 5: PLAYED
    if (!status || status <= 1) return <svg viewBox="0 0 16 16" className="w-3 h-3 text-gray-400 ml-1"><path fill="currentColor" d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path fill="currentColor" d="M7.5 3a.5.5 0 0 1 .5.5v5.21l3.248 1.856a.5.5 0 0 1-.496.868l-3.5-2A.5.5 0 0 1 7 9V3.5a.5.5 0 0 1 .5-.5z"/></svg>; // Relógio
    
    const colorClass = status >= 4 ? "text-blue-500" : "text-gray-400";
    
    if (status === 2) {
        // Um check (Enviado)
        return <svg viewBox="0 0 16 15" className="w-3 h-3 text-gray-400 ml-1"><path fill="currentColor" d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 14.376l-3.89-3.956a.363.363 0 0 0-.506 0l-.477.476a.372.372 0 0 0 0 .515l4.636 4.706a.363.363 0 0 0 .506 0l10.122-12.28a.372.372 0 0 0 .052-.52z"/></svg>;
    }
    
    // Dois checks (Entregue ou Lido)
    return (
        <div className={`flex -space-x-1 ml-1 ${colorClass}`}>
            <svg viewBox="0 0 16 15" className="w-3 h-3"><path fill="currentColor" d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 14.376l-3.89-3.956a.363.363 0 0 0-.506 0l-.477.476a.372.372 0 0 0 0 .515l4.636 4.706a.363.363 0 0 0 .506 0l10.122-12.28a.372.372 0 0 0 .052-.52z"/></svg>
            <svg viewBox="0 0 16 15" className="w-3 h-3 relative top-0"><path fill="currentColor" d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L4.566 14.376l-3.89-3.956a.363.363 0 0 0-.506 0l-.477.476a.372.372 0 0 0 0 .515l4.636 4.706a.363.363 0 0 0 .506 0l10.122-12.28a.372.372 0 0 0 .052-.52z"/></svg>
        </div>
    );
};


// --- NOVO COMPONENTE: ImageEditorModal ---
const ImageEditorModal = ({ file, onSave, onCancel }) => {
    const editorRef = useRef(null);
    const editorInstance = useRef(null);

    useEffect(() => {
        if (!editorRef.current || !file) return;

        if (editorInstance.current) {
            editorInstance.current.destroy();
            editorInstance.current = null;
        }
        
        const imageUrl = `data:${file.type};base64,${file.data}`;

        editorInstance.current = new ImageEditor(editorRef.current, {
            includeUI: {
                loadImage: { path: imageUrl, name: file.name },
                menu: ['crop', 'draw', 'text'],
                initMenu: 'draw',
                uiSize: { width: '100%', height: '100%' },
                menuBarPosition: 'bottom',
                // @ts-ignore
                locale: { 'Crop': 'Recortar', 'Draw': 'Desenhar', 'Text': 'Texto', 'Apply': 'Aplicar', 'Cancel': 'Cancelar' },
            },
            cssMaxWidth: document.documentElement.clientWidth * 0.9,
            cssMaxHeight: document.documentElement.clientHeight * 0.8,
            selectionStyle: { cornerSize: 20, rotatingPointOffset: 70 },
        });
        
        const handleResize = () => editorInstance.current?.ui.resizeEditor();
        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (editorInstance.current) editorInstance.current.destroy();
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

const Lightbox = ({ src, onClose }) => {
  useEffect(() => {
    const handleKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-[100]" onClick={onClose}>
      <div className="relative p-4 w-full h-full flex items-center justify-center">
        <img src={src} alt="Visualização" className="max-w-[90vw] max-h-[90vh] object-contain shadow-lg rounded-md" onClick={(e) => e.stopPropagation()} />
        <button onClick={onClose} className="absolute top-4 right-4 text-white text-4xl font-bold hover:text-gray-300">&times;</button>
      </div>
    </div>
  );
};

const FileRenderer = ({ file, onImageClick }) => {
    if (!file || !file.type || !file.data) return null;
    const fileSrc = `data:${file.type};base64,${file.data}`;
    if (file.type.startsWith('image/')) return <img src={fileSrc} alt={file.name} className="w-full h-full object-cover cursor-pointer" onClick={() => onImageClick(fileSrc)} />;
    if (file.type.startsWith('audio/')) return <audio controls src={fileSrc} className="mt-2 w-full max-w-xs"></audio>;
    if (file.type.startsWith('video/')) return <video controls src={fileSrc} className="mt-2 rounded-lg max-w-xs md:max-w-sm max-h-80"></video>;
    return (
        <a href={fileSrc} download={file.name} className="mt-2 p-2 bg-gray-100 rounded-lg flex items-center space-x-2 border border-gray-200 hover:bg-gray-200">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            <span className="text-sm font-medium text-gray-800 truncate">{file.name}</span>
        </a>
    );
};

const MessageBubble = ({ message, onImageClick, onSetReply, onSetEdit, isFromAttendant = false, messageIndex, isHighlighted = false }) => {
  const [isMenuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const isBot = message.sender === Sender.BOT;
  const isAttendant = message.sender === Sender.ATTENDANT;
  const isSystem = message.sender === Sender.SYSTEM;
  const isOutgoing = isBot || isAttendant;

  useEffect(() => {
    const handleClickOutside = (event) => { if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (isSystem) return <div className="flex justify-center w-full"><div className="text-xs text-white bg-gray-500 bg-opacity-70 rounded-full px-3 py-1 my-1">{message.text}</div></div>;
  
  const highlightClass = isHighlighted ? 'bg-yellow-200 ring-2 ring-yellow-400' : '';
  const bubbleClasses = isBot ? 'bg-white text-gray-800 self-start' : isAttendant ? 'bg-green-100 text-gray-800 self-end' : 'bg-white text-gray-800 self-start';
  // Ajuste visual: Bot/User esquerda (branco), Atendente direita (verde claro WhatsApp)
  const containerClass = (isAttendant) ? 'justify-end' : 'justify-start';
  const colorClass = (isAttendant) ? 'bg-[#dcf8c6]' : 'bg-white'; // Verde WhatsApp para atendente (eu), Branco para usuário/bot

  return (
    <div id={`message-${messageIndex}`} className={`flex w-full ${containerClass} group items-center`}>
      <div className={`relative flex items-center ${isAttendant ? 'flex-row-reverse' : ''}`}>
        <div className={`max-w-md md:max-w-lg p-2 rounded-lg shadow-sm mb-1 flex flex-col ${colorClass} ${highlightClass}`}>
          {message.replyTo && (
              <div className="p-2 mb-1 text-xs bg-gray-500 bg-opacity-10 rounded-md border-l-2 border-blue-400">
                  <p className="font-semibold text-blue-500">{message.replyTo.senderName}</p>
                  <p className="text-gray-600 truncate">{message.replyTo.text || 'Arquivo'}</p>
              </div>
          )}
          {message.text && <div className="text-sm whitespace-pre-wrap">{message.text}</div>}
          {message.files && message.files.map((file, idx) => <FileRenderer key={idx} file={file} onImageClick={onImageClick} />)}
          <div className="text-xs text-gray-400 self-end mt-1 flex items-center">
              {message.edited && <span className="mr-1 italic">editada</span>}
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {isOutgoing && <MessageStatusIcon status={message.status} />}
          </div>
        </div>
        {!isSystem && (
          <div className="relative self-start mb-1">
              <button onClick={() => setMenuOpen(!isMenuOpen)} className={`p-1 text-gray-400 opacity-0 group-hover:opacity-100 hover:bg-gray-300 rounded-full ${isAttendant ? 'mr-2' : 'ml-2'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" /></svg>
              </button>
              {isMenuOpen && (
                <div ref={menuRef} className={`absolute top-6 z-10 w-32 bg-white rounded shadow-lg ring-1 ring-black ring-opacity-5 ${isAttendant ? 'right-0' : 'left-0'}`}>
                    <button onClick={() => { onSetReply(message); setMenuOpen(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Responder</button>
                    {isFromAttendant && message.text && <button onClick={() => { onSetEdit(message); setMenuOpen(false); }} className="block w-full text-left px-4 py-2 text-sm hover:bg-gray-100">Editar</button>}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
};

const MediaGallery = ({ messages, onImageClick }) => {
    const { media, docs, links } = useMemo(() => {
        const media = [], docs = [], links = [];
        messages.forEach((msg, i) => {
            if (msg.files) msg.files.forEach(f => (f.type.startsWith('image/') || f.type.startsWith('video/') ? media : docs).push({ ...f, id: `${i}-${f.name}` }));
            const foundLinks = msg.text?.match(/(https?:\/\/[^\s]+)/g);
            if (foundLinks) foundLinks.forEach((l, li) => links.push({ link: l, id: `${i}-${li}` }));
        });
        return { media: media.reverse(), docs: docs.reverse(), links: links.reverse() };
    }, [messages]);

    return (
        <div className="bg-white h-full overflow-y-auto">
            {[{t:'Mídia', d:media}, {t:'Documentos', d:docs}, {t:'Links', d:links}].map(sec => (
                <div key={sec.t} className="mb-6">
                    <h3 className="text-lg font-semibold p-4 border-b">{sec.t} ({sec.d.length})</h3>
                    {sec.d.length === 0 ? <p className="p-4 text-sm text-gray-500">Vazio.</p> : (
                        sec.t === 'Mídia' ? <div className="p-4 grid grid-cols-4 gap-2">{sec.d.map(m => <div key={m.id} className="aspect-square bg-gray-200"><img src={`data:${m.type};base64,${m.data}`} className="w-full h-full object-cover cursor-pointer" onClick={() => onImageClick(`data:${m.type};base64,${m.data}`)}/></div>)}</div> :
                        sec.t === 'Documentos' ? <ul className="p-2 space-y-1">{sec.d.map(d => <li key={d.id} className="border-b"><FileRenderer file={d} onImageClick={()=>{}}/></li>)}</ul> :
                        <ul className="p-2">{sec.d.map(l => <li key={l.id} className="p-2 border-b"><a href={l.link} target="_blank" className="text-blue-600 truncate block">{l.link}</a></li>)}</ul>
                    )}
                </div>
            ))}
        </div>
    );
};

const ChatPanel = ({ selectedChat, attendant, onSendMessage, onEditMessage, onResolveChat, onTransferChat, onTakeoverChat, isLoading, attendants, onImageClick, selectedFiles, setSelectedFiles, onFileSelect, onEditFile }) => {
  const [message, setMessage] = useState('');
  const [isTransferModalOpen, setTransferModalOpen] = useState(false);
  const [transferToAttendantId, setTransferToAttendantId] = useState('');
  const [replyingToMessage, setReplyingToMessage] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [editedText, setEditedText] = useState("");
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  
  const [activeTab, setActiveTab] = useState('chat');
  const [isSearchVisible, setSearchVisible] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(-1);
  const chatType = selectedChat?.handledBy === 'bot' ? 'bot' : 'human';
  
  // Verifica se o chat é do atendente atual
  const isOwner = attendant?.id === selectedChat?.attendantId;

  useEffect(() => { if (activeTab === 'chat') messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [selectedChat?.messageLog, isLoading, activeTab]);
  useEffect(() => { setMessage(''); setReplyingToMessage(null); setEditingMessage(null); setActiveTab('chat'); setSearchVisible(false); setSearchTerm(''); }, [selectedChat?.userId]);

  useEffect(() => {
    if (!searchTerm.trim() || !selectedChat) { setSearchResults([]); setCurrentResultIndex(-1); return; }
    const results = (selectedChat.messageLog || []).reduce((acc, msg, i) => (msg.text && msg.text.toLowerCase().includes(searchTerm.toLowerCase()) ? [...acc, i] : acc), []);
    setSearchResults(results); setCurrentResultIndex(results.length > 0 ? 0 : -1);
  }, [searchTerm, selectedChat]);

  useEffect(() => { if (currentResultIndex > -1) document.getElementById(`message-${searchResults[currentResultIndex]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [currentResultIndex]);

  const handleSend = () => { if ((message.trim() || selectedFiles.length) && selectedChat) { onSendMessage(selectedChat.userId, message.trim(), attendant.id, selectedFiles, replyingToMessage); setMessage(''); setSelectedFiles([]); setReplyingToMessage(null); } };

  if (!selectedChat) return <div className="flex-1 flex flex-col items-center justify-center bg-gray-100 text-gray-500"><span>Selecione um atendimento para começar.</span></div>;

  return (
    <div className="flex-1 flex flex-col bg-gray-100">
      <header className="bg-white p-3 border-b flex justify-between items-center shadow-sm">
        <div><h2 className="font-semibold">{selectedChat.userName}</h2><p className="text-xs text-gray-500">{chatType === 'bot' ? 'Assistente Virtual' : `Atendido por: ${attendants.find(a => a.id === selectedChat.attendantId)?.name || '...'}`}</p></div>
        <div className="flex items-center space-x-2">
            <button onClick={() => { setSearchVisible(true); setActiveTab('chat'); }} className="p-2 text-gray-500 hover:bg-gray-200 rounded-full"><svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" /></svg></button>
            {chatType === 'bot' && <button onClick={() => onTakeoverChat(selectedChat.userId)} className="px-3 py-1 text-xs text-white bg-purple-600 rounded hover:bg-purple-700">Assumir</button>}
            
            {/* Botão Transferir visível para todos os humanos para permitir supervisão, mas idealmente usado pelo dono */}
            {chatType === 'human' && <button onClick={() => setTransferModalOpen(true)} className="px-3 py-1 text-xs text-white bg-blue-600 rounded hover:bg-blue-700">Transferir</button>}
            
            <button onClick={() => onResolveChat(selectedChat.userId)} className="px-3 py-1 text-xs text-white bg-green-600 rounded hover:bg-green-700">Resolver</button>
        </div>
      </header>
      {isSearchVisible && (
          <div className="p-2 bg-gray-200 flex items-center space-x-2">
              <input type="text" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Buscar..." className="w-full px-3 py-1 text-sm rounded outline-none" autoFocus />
              <span className="text-xs text-gray-600 w-16">{currentResultIndex > -1 ? `${currentResultIndex + 1}/${searchResults.length}` : '0/0'}</span>
              <button onClick={() => setCurrentResultIndex(p => (p + 1) % searchResults.length)} disabled={!searchResults.length}>▼</button>
              <button onClick={() => { setSearchVisible(false); setSearchTerm(''); }}>✕</button>
          </div>
      )}
      <div className="bg-white border-b flex"><button onClick={() => setActiveTab('chat')} className={`py-2 px-4 text-sm ${activeTab === 'chat' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Conversa</button><button onClick={() => setActiveTab('media')} className={`py-2 px-4 text-sm ${activeTab === 'media' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}>Mídia/Links</button></div>
      <div className="flex-1 overflow-y-auto relative">
        {activeTab === 'chat' ? (
          <div className="p-4 whatsapp-bg min-h-full">
            {selectedChat.messageLog.map((msg, i) => <MessageBubble key={i} message={msg} onImageClick={onImageClick} onSetReply={setReplyingToMessage} onSetEdit={(m)=>{setEditingMessage(m); setEditedText(m.text)}} isFromAttendant={msg.sender === Sender.ATTENDANT} messageIndex={i} isHighlighted={searchResults[currentResultIndex] === i} />)}
            {isLoading && <TypingIndicator />}
            <div ref={messagesEndRef} />
          </div>
        ) : <MediaGallery messages={selectedChat.messageLog} onImageClick={onImageClick} />}
      </div>
      
      {/* Footer / Input Area */}
      {activeTab === 'chat' && (
          <footer className="bg-gray-200 p-3">
             {!isOwner && chatType === 'human' && (
                <div className="text-xs text-center text-gray-500 mb-2 p-1 bg-yellow-100 rounded border border-yellow-300">
                    Você está visualizando o atendimento de <b>{attendants.find(a=>a.id === selectedChat.attendantId)?.name}</b>. 
                    <button onClick={() => onTakeoverChat(selectedChat.userId)} className="ml-2 text-blue-600 underline">Assumir Conversa</button>
                </div>
             )}
            
            {editingMessage ? (
                 <div className="bg-white rounded p-2"><p className="text-xs font-bold text-yellow-600">Editando...</p><input type="text" value={editedText} onChange={e=>setEditedText(e.target.value)} className="w-full p-2 border rounded mb-2" /><div className="flex justify-end space-x-2"><button onClick={()=>setEditingMessage(null)} className="text-xs bg-gray-200 px-2 py-1 rounded">Cancelar</button><button onClick={()=>{onEditMessage(selectedChat.userId, editingMessage.timestamp, editedText); setEditingMessage(null)}} className="text-xs bg-green-600 text-white px-2 py-1 rounded">Salvar</button></div></div>
            ) : (
              <>
                {replyingToMessage && <div className="p-2 mb-2 bg-blue-50 border-l-4 border-blue-400 text-xs relative"><p className="font-bold text-blue-600">Respondendo a {replyingToMessage.senderName}</p><p className="truncate">{replyingToMessage.text || 'Arquivo'}</p><button onClick={()=>setReplyingToMessage(null)} className="absolute top-1 right-1 font-bold">&times;</button></div>}
                {selectedFiles.length > 0 && <div className="p-2 mb-2 bg-blue-100 rounded flex space-x-2 overflow-x-auto">{selectedFiles.map((f,i) => <div key={i} className="relative w-16 h-16 bg-white"><img src={`data:${f.type};base64,${f.data}`} className="w-full h-full object-cover"/><button onClick={()=>setSelectedFiles(fs=>fs.filter((_,idx)=>idx!==i))} className="absolute top-0 right-0 bg-red-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">&times;</button></div>)}</div>}
                
                {/* Input Controls - Sempre visíveis se for humano, mas desabilitados se não for o dono */}
                <div className={`flex items-center bg-white rounded-full px-2 shadow ${!isOwner && chatType === 'human' ? 'opacity-50 pointer-events-none' : ''}`}>
                  <button onClick={() => fileInputRef.current.click()} className="p-2 text-gray-500 hover:text-gray-700" disabled={!isOwner && chatType === 'human'}><svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg></button>
                  <input type="file" ref={fileInputRef} onChange={onFileSelect} className="hidden" multiple />
                  <input 
                    type="text" 
                    value={message} 
                    onChange={e => setMessage(e.target.value)} 
                    onKeyPress={e => e.key === 'Enter' && handleSend()} 
                    placeholder={chatType === 'bot' ? "Assuma a conversa para responder..." : "Digite sua mensagem..."} 
                    className="w-full p-2 bg-transparent outline-none" 
                    disabled={(!isOwner && chatType === 'human') || chatType === 'bot'}
                  />
                  <button onClick={handleSend} className="p-2 text-blue-600 hover:text-blue-800" disabled={(!isOwner && chatType === 'human') || chatType === 'bot'}><svg className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg></button>
                </div>
              </>
            )}
          </footer>
      )}
      {isTransferModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded w-full max-w-sm">
            <h3 className="text-lg font-semibold mb-4">Transferir</h3>
            <select value={transferToAttendantId} onChange={(e) => setTransferToAttendantId(e.target.value)} className="w-full p-2 border rounded mb-4"><option value="" disabled>Selecione...</option>{attendants.filter(a => a.id !== attendant.id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            <div className="flex justify-end space-x-2"><button onClick={() => setTransferModalOpen(false)} className="px-4 py-2 bg-gray-200 rounded">Cancelar</button><button onClick={() => { onTransferChat(selectedChat.userId, transferToAttendantId); setTransferModalOpen(false); }} className="px-4 py-2 bg-blue-600 text-white rounded">Transferir</button></div>
          </div>
        </div>
      )}
    </div>
  );
};

const Login = ({ attendants, onLogin, onRegister, isBackendOffline }) => {
  const [selectedAttendant, setSelectedAttendant] = useState('');
  const [newAttendantName, setNewAttendantName] = useState('');

  return (
    <div className="flex items-center justify-center w-full h-full bg-gray-100">
      <div className="w-full max-w-md p-8 space-y-6 bg-white rounded-xl shadow-lg">
        <h2 className="text-3xl font-bold text-center text-gray-800">Painel de Atendimento</h2>
        {isBackendOffline && <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 text-yellow-700 text-sm">Conectando ao servidor... Aguarde.</div>}
        <div>
          <h3 className="text-xl font-semibold text-gray-700">Entrar</h3>
          <select value={selectedAttendant} onChange={e => setSelectedAttendant(e.target.value)} className="w-full mt-2 p-2 border rounded" disabled={isBackendOffline}><option value="" disabled>Selecione seu nome</option>{attendants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <button onClick={() => onLogin(selectedAttendant)} disabled={!selectedAttendant || isBackendOffline} className="w-full mt-4 py-2 bg-blue-600 text-white rounded font-bold disabled:bg-blue-300">Entrar</button>
        </div>
        <div className="border-t pt-4">
          <h3 className="text-xl font-semibold text-gray-700">Registrar</h3>
           <input type="text" value={newAttendantName} onChange={e => setNewAttendantName(e.target.value)} placeholder="Seu nome completo" className="w-full mt-2 p-2 border rounded" disabled={isBackendOffline} />
          <button onClick={() => onRegister(newAttendantName)} disabled={!newAttendantName.trim() || isBackendOffline} className="w-full mt-4 py-2 bg-green-600 text-white rounded font-bold disabled:bg-green-300">Registrar-se</button>
        </div>
      </div>
    </div>
  );
};

function App() {
  const [attendant, setAttendant] = useState(null);
  const [attendants, setAttendants] = useState([]);
  const [activeView, setActiveView] = useState('queue');
  const [requestQueue, setRequestQueue] = useState([]);
  const [activeChats, setActiveChats] = useState([]);
  const [aiActiveChats, setAiActiveChats] = useState([]);
  const [chatHistory, setChatHistory] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [internalChatPartner, setInternalChatPartner] = useState(null);
  const [internalChatMessages, setInternalChatMessages] = useState([]);
  const [internalMessage, setInternalMessage] = useState('');
  const [internalSelectedFiles, setInternalSelectedFiles] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [editingFile, setEditingFile] = useState(null);
  const [gatewayStatus, setGatewayStatus] = useState({ status: 'LOADING', qrCode: null });
  const [isBackendOffline, setIsBackendOffline] = useState(true);
  
  // Modals
  const [isInitiateModalOpen, setInitiateModalOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [initiateMessage, setInitiateMessage] = useState('');
  const [clientSearchTerm, setClientSearchTerm] = useState('');
  const [lightboxSrc, setLightboxSrc] = useState(null);
  
  const [notifications, setNotifications] = useState({ queue: 0, active: new Set(), active_ai: new Set(), internal: new Set() });
  const [internalChatsSummary, setInternalChatsSummary] = useState({});

  const fetchData = useCallback(async () => {
    if (!attendant || isBackendOffline) return;
    try {
      const [reqRes, activeRes, historyRes, attendantsRes, aiChatsRes, internalSummaryRes] = await Promise.all([
        fetch('/api/requests'), fetch('/api/chats/active'), fetch('/api/chats/history'), fetch('/api/attendants'), fetch('/api/chats/ai-active'), fetch(`/api/internal-chats/summary/${attendant.id}`)
      ]);
      // Modificado: Se der erro, apenas loga e não trava o componente.
      if (!reqRes.ok) { console.warn('Erro ao buscar dados, tentando novamente...'); return; }
      
      setRequestQueue(await reqRes.json());
      setActiveChats(await activeRes.json());
      setChatHistory(await historyRes.json());
      setAttendants(await attendantsRes.json());
      setAiActiveChats(await aiChatsRes.json());
      setInternalChatsSummary(await internalSummaryRes.json());
      
      if (selectedChat) {
          const updated = [...await activeRes.json(), ...await aiChatsRes.json()].find(c => c.userId === selectedChat.userId);
          // Atualiza se houver mensagem nova OU mudança de status (ticks)
          const lastMsgUpdated = updated && updated.lastMessage?.timestamp !== selectedChat.messageLog[selectedChat.messageLog.length-1]?.timestamp;
          // Verificação superficial de status
          const statusUpdated = updated && updated.lastMessage?.status !== selectedChat.messageLog[selectedChat.messageLog.length-1]?.status;

          if (lastMsgUpdated || statusUpdated) {
               const res = await fetch(`/api/chats/history/${selectedChat.userId}`);
               if (res.ok) setSelectedChat({ ...selectedChat, ...(await res.json()) });
          }
      }
    } catch (err) { console.warn('Rede instável no fetchData, ignorando erro...'); }
  }, [attendant, isBackendOffline, selectedChat]);

  const pollStatus = useCallback(async () => {
      try {
          const res = await fetch('/api/gateway/status');
          if (res.ok) {
              const data = await res.json();
              setGatewayStatus(prev => JSON.stringify(prev) !== JSON.stringify(data) ? data : prev);
              setIsBackendOffline(false);
          }
      } catch (err) { 
          // Mantém offline se falhar, mas sem log de erro crítico
          setIsBackendOffline(true); 
      }
  }, []);

  useEffect(() => {
      const loadAttendants = async () => {
          try {
              const res = await fetch('/api/attendants');
              if (res.ok) { setAttendants(await res.json()); setIsBackendOffline(false); } 
              else throw new Error();
          } catch (e) { setIsBackendOffline(true); setTimeout(loadAttendants, 3000); }
      };
      loadAttendants();
  }, []);

  useEffect(() => { if (attendant) { pollStatus(); const i = setInterval(pollStatus, 3000); return () => clearInterval(i); } }, [attendant, pollStatus]);
  useEffect(() => { if (attendant && !isBackendOffline) { fetchData(); const i = setInterval(fetchData, 3000); return () => clearInterval(i); } }, [attendant, isBackendOffline, fetchData]);
  useEffect(() => { if (attendant && !isBackendOffline) fetch('/api/clients').then(r=>r.json()).then(setClients).catch(()=>{}); }, [attendant, isBackendOffline]);

  const readFileAsBase64 = (file) => new Promise((resolve) => { const r = new FileReader(); r.onload = e => resolve({ name: file.name, type: file.type, data: (e.target.result as string).split(',')[1] }); r.readAsDataURL(file); });
  const handleFileSelect = async (e) => { const files = Array.from(e.target.files); if(!files.length) return; const processed = await Promise.all(files.map(readFileAsBase64)); setSelectedFiles(p => [...p, ...processed]); e.target.value=null; };
  const handleInternalFileSelect = async (e) => { const files = Array.from(e.target.files); if(!files.length) return; const processed = await Promise.all(files.map(readFileAsBase64)); setInternalSelectedFiles(p => [...p, ...processed]); e.target.value=null; };

  const handleSendMessage = async (userId, text, attendantId, files, replyTo) => {
      const tempMsg = { sender: Sender.ATTENDANT, text, files, timestamp: new Date().toISOString(), replyTo: replyTo ? { text: replyTo.text, senderName: replyTo.sender === 'user' ? selectedChat.userName : 'Você' } : null, status: 1 };
      setSelectedChat(p => p?.userId === userId ? { ...p, messageLog: [...p.messageLog, tempMsg] } : p);
      await fetch('/api/chats/attendant-reply', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ userId, text, attendantId, files, replyTo }) });
  };

  const handleEditMessage = async (userId, messageTimestamp, newText) => {
      setSelectedChat(p => {
          if (p?.userId !== userId) return p;
          const newLog = p.messageLog.map(m => (m.timestamp === messageTimestamp && m.sender === Sender.ATTENDANT) ? { ...m, text: newText, edited: true } : m);
          return { ...p, messageLog: newLog };
      });
      await fetch('/api/chats/edit-message', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ userId, attendantId: attendant.id, messageTimestamp, newText }) });
  };
  
  // Handlers simplificados (mantendo lógica original)
  const handleLogin = (id) => { const a = attendants.find(x=>x.id===id); if(a) { setAttendant(a); localStorage.setItem('attendantId', a.id); } };
  const handleRegister = async (name) => { const res = await fetch('/api/attendants', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})}); if(res.ok) setAttendants([...attendants, await res.json()]); };
  const handleLogout = () => { setAttendant(null); localStorage.removeItem('attendantId'); };
  const handleSelectChatItem = async (item) => { setIsLoading(true); setSelectedChat(null); try { const res = await fetch(`/api/chats/history/${item.userId}`); if(res.ok) setSelectedChat({...item, ...await res.json()}); } finally { setIsLoading(false); } };

  useEffect(() => { const saved = localStorage.getItem('attendantId'); if(saved && attendants.length) handleLogin(saved); }, [attendants]);

  if (!attendant) return <Login attendants={attendants} onLogin={handleLogin} onRegister={handleRegister} isBackendOffline={isBackendOffline} />;

  if (gatewayStatus.status !== 'CONNECTED') {
    return (
        <div className="flex items-center justify-center w-full h-screen bg-gray-200 p-4">
            <div className="w-full max-w-md p-8 bg-white rounded-xl shadow-lg text-center">
                <h2 className="text-2xl font-bold text-gray-800 mb-4">Conexão WhatsApp</h2>
                
                {isBackendOffline && <div className="p-3 mb-4 bg-yellow-100 text-yellow-800 rounded text-sm">Conectando ao servidor... Por favor, aguarde.</div>}

                {gatewayStatus.status === 'LOADING' && (
                    <div className="animate-pulse flex flex-col items-center">
                        <div className="h-4 bg-gray-300 rounded w-3/4 mb-4"></div>
                        <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="text-sm text-gray-500 mt-4">Iniciando serviços e gerando QR Code...</p>
                    </div>
                )}

                {gatewayStatus.status === 'QR_CODE_READY' && gatewayStatus.qrCode && (
                    <div className="bg-white p-2 rounded border shadow-sm inline-block">
                        <img src={gatewayStatus.qrCode} alt="QR Code" className="w-64 h-64 object-contain"/>
                        <p className="mt-4 text-sm text-gray-600 font-medium">Abra o WhatsApp &gt; Aparelhos conectados &gt; Conectar</p>
                    </div>
                )}

                {gatewayStatus.status === 'DISCONNECTED' && (
                    <div>
                        <div className="text-red-500 mb-2 font-bold">Desconectado</div>
                        <p className="text-gray-600 text-sm">O sistema está tentando reconectar automaticamente.</p>
                        <div className="mt-4 w-8 h-8 border-4 border-gray-300 border-t-gray-600 rounded-full animate-spin mx-auto"></div>
                    </div>
                )}
                <button onClick={handleLogout} className="mt-6 text-xs text-red-500 hover:underline">Sair do painel</button>
            </div>
        </div>
    );
  }

  const filteredClients = clients.filter(c => c.userName.toLowerCase().includes(clientSearchTerm.toLowerCase()));

  return (
    <div className="flex h-screen font-sans bg-gray-100 text-gray-800">
      <aside className="w-80 bg-white border-r flex flex-col shadow-lg">
        <div className="p-4 border-b">
            <h1 className="text-xl font-bold">JZF Atendimento</h1>
            <p className="text-xs text-gray-500 mt-1">Olá, {attendant.name}</p>
            <div className="flex space-x-2 mt-2"><button onClick={() => setInitiateModalOpen(true)} className="text-xs text-blue-600">Novo Chat</button><button onClick={handleLogout} className="text-xs text-red-500">Sair</button></div>
        </div>
        <nav className="flex p-1 bg-gray-100 text-xs">
            {['queue', 'active', 'ai_active', 'history', 'internal_chat'].map(v => <button key={v} onClick={() => setActiveView(v)} className={`flex-1 p-2 rounded ${activeView === v ? 'bg-white shadow font-bold' : 'text-gray-600'}`}>{v === 'ai_active' ? 'IA' : v === 'internal_chat' ? 'Interno' : v.charAt(0).toUpperCase() + v.slice(1)} {notifications[v]?.size || notifications[v] || ''}</button>)}
        </nav>
        <div className="flex-1 overflow-y-auto">
            {activeView === 'queue' && requestQueue.map(r => <div key={r.id} onClick={()=>handleSelectChatItem({userId:r.userId, userName:r.userName})} className="p-3 border-b cursor-pointer hover:bg-gray-50"><p className="font-bold">{r.userName}</p><p className="text-xs text-gray-500">{r.department}</p></div>)}
            {activeView === 'active' && activeChats.map(c => <div key={c.userId} onClick={()=>handleSelectChatItem(c)} className={`p-3 border-b cursor-pointer hover:bg-gray-50 ${selectedChat?.userId===c.userId?'bg-blue-50':''}`}><p className="font-bold">{c.userName}</p></div>)}
            {activeView === 'ai_active' && aiActiveChats.map(c => <div key={c.userId} onClick={()=>handleSelectChatItem(c)} className={`p-3 border-b cursor-pointer hover:bg-gray-50 ${selectedChat?.userId===c.userId?'bg-blue-50':''}`}><p className="font-bold">{c.userName}</p><p className="text-xs text-gray-500">Via IA</p></div>)}
        </div>
      </aside>
      <main className="flex-1 flex flex-col">
        {activeView !== 'internal_chat' ? (
            <ChatPanel selectedChat={selectedChat} attendant={attendant} onSendMessage={handleSendMessage} onEditMessage={handleEditMessage} onResolveChat={async(id)=>{await fetch(`/api/chats/resolve/${id}`,{method:'POST',body:JSON.stringify({attendantId:attendant.id}),headers:{'Content-Type':'application/json'}}); fetchData(); setSelectedChat(null);}} onTransferChat={async(uid, aid)=>{await fetch(`/api/chats/transfer/${uid}`,{method:'POST',body:JSON.stringify({newAttendantId:aid, transferringAttendantId:attendant.id}),headers:{'Content-Type':'application/json'}}); setSelectedChat(null); fetchData();}} onTakeoverChat={async(uid)=>{const res=await fetch(`/api/chats/takeover/${uid}`,{method:'POST',body:JSON.stringify({attendantId:attendant.id}),headers:{'Content-Type':'application/json'}}); if(res.ok) handleSelectChatItem(await res.json());}} isLoading={isLoading} attendants={attendants} onImageClick={setLightboxSrc} selectedFiles={selectedFiles} setSelectedFiles={setSelectedFiles} onFileSelect={handleFileSelect} onEditFile={setEditingFile} />
        ) : <div className="flex items-center justify-center h-full text-gray-500">Chat interno em desenvolvimento (use a versão completa para esta funcionalidade)</div>}
      </main>
      {isInitiateModalOpen && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white p-6 rounded-lg w-full max-w-md h-[80vh] flex flex-col">
                  <h3 className="font-bold mb-4">Novo Chat</h3>
                  <input type="text" placeholder="Buscar cliente..." value={clientSearchTerm} onChange={e=>setClientSearchTerm(e.target.value)} className="p-2 border rounded mb-2" />
                  <div className="flex-1 overflow-y-auto border rounded mb-4">
                      {filteredClients.map(c => <div key={c.userId} onClick={()=>setSelectedClient(c)} className={`p-2 cursor-pointer hover:bg-gray-100 ${selectedClient?.userId===c.userId?'bg-blue-100':''}`}>{c.userName}</div>)}
                  </div>
                  <textarea value={initiateMessage} onChange={e=>setInitiateMessage(e.target.value)} placeholder="Mensagem..." className="p-2 border rounded mb-2 h-20"></textarea>
                  <div className="flex justify-end space-x-2"><button onClick={()=>setInitiateModalOpen(false)} className="px-4 py-2 bg-gray-200 rounded">Cancelar</button><button onClick={async()=>{ if(!selectedClient) return; const res = await fetch('/api/chats/initiate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({recipientNumber:selectedClient.userId, message:initiateMessage, attendantId:attendant.id})}); if(res.ok) { setInitiateModalOpen(false); handleSelectChatItem(await res.json()); }}} className="px-4 py-2 bg-blue-600 text-white rounded">Enviar</button></div>
              </div>
          </div>
      )}
      {editingFile && <ImageEditorModal file={editingFile.file} onSave={(d)=>{ const n=[...selectedFiles]; n[editingFile.context.index].data=d.split(',')[1]; setSelectedFiles(n); setEditingFile(null); }} onCancel={()=>setEditingFile(null)} />}
      {lightboxSrc && <Lightbox src={lightboxSrc} onClose={()=>setLightboxSrc(null)} />}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);
