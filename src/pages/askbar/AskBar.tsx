import '@src/utils/logger';
import React, { useState, useEffect, useRef, useLayoutEffect, KeyboardEvent } from 'react';
import { Message } from '@src/services/storage';
import { ScrapedContent } from '@src/services/contentScraper';
import {
  ConversationList,
  useCopyMessage,
  useConversationStorage
} from '@src/components/index';
import { useSimpleChat } from '@src/components/hooks/useSimpleChat';
import { UiPortService, TabInfo } from '@src/services/messaging/uiPortService';
import { get } from '@src/services/storage';
import { ChatErrorBoundary, UIErrorBoundary } from '@src/components/ErrorBoundary';
import TabChipRow from './components/TabChipRow';
import InputArea from './components/InputArea';

interface AskBarProps {
  position?: string;
  onUnmount?: () => void;
  initialConversation?: Message[];
  initialConversationId?: string | null;
  onConversationUpdate?: (messages: Message[], conversationId: string | null) => void;
}

interface TabChip {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

interface TabMention {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

export const AskBar: React.FC<AskBarProps> = ({
  position = 'top-right',
  onUnmount,
  initialConversation = [],
  initialConversationId = null,
  onConversationUpdate
}) => {
  // State
  const [input, setInput] = useState('');
  const [conversationHistory, setConversationHistory] = useState<Message[]>(initialConversation);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(initialConversationId);
  const [isExpanded, setIsExpanded] = useState(initialConversation.length > 0);
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [scrapedContent, setScrapedContent] = useState<ScrapedContent | null>(null);
  const [pageUrl, setPageUrl] = useState<string>('');
  const [pageTitle, setPageTitle] = useState<string>('');
  const [selectedTabIds, setSelectedTabIds] = useState<number[]>([]);
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [debugEnabled, setDebugEnabled] = useState<boolean>(false);
  const [availableTabs, setAvailableTabs] = useState<TabChip[]>([]);
  const [inputHasFocus, setInputHasFocus] = useState(false);

  // @ mention state
  const [showDropdown, setShowDropdown] = useState(false);
  const [filteredTabs, setFilteredTabs] = useState<TabInfo[]>([]);
  const [dropdownSelectedIndex, setDropdownSelectedIndex] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const [mentionedTabs, setMentionedTabs] = useState<TabMention[]>([]);

  // Refs
  const askBarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const mountTimeRef = useRef<number>(Date.now());
  const uiPortService = useRef<UiPortService>(UiPortService.getInstance());

  // Custom hooks
  const { copiedMessageIndex, handleCopyMessage } = useCopyMessage();
  
  useConversationStorage(
    conversationHistory,
    currentConversationId,
    setCurrentConversationId,
    pageUrl
  );

  // Chat system
  const [chatState, chatActions] = useSimpleChat(
    (message: Message) => {
      // Finalize the last assistant message (keep existing content, just mark as complete)
      if (message.type === 'assistant') {
        setConversationHistory(prev => {
          const updated = [...prev];
          const lastMessage = updated[updated.length - 1];
          if (lastMessage && lastMessage.type === 'assistant') {
            // Keep the content we built during streaming, just update timestamp to mark as final
            updated[updated.length - 1] = {
              ...lastMessage,
              timestamp: message.timestamp // Use the completion timestamp
            };
          } else {
            // Add new assistant message if none exists (fallback)
            updated.push(message);
          }
          return updated;
        });
      }
    },
    (delta: string) => {
      // Update the last assistant message with streaming content
      setConversationHistory(prev => {
        const updated = [...prev];
        const lastMessage = updated[updated.length - 1];
        if (lastMessage && lastMessage.type === 'assistant') {
          const prevContent = lastMessage.content;
          // Detect if delta is cumulative or incremental
          // If the new delta already includes the previous content as a prefix, treat it as cumulative and replace
          // Otherwise, treat it as incremental and append
          if (delta.startsWith(prevContent)) {
            updated[updated.length - 1] = {
              ...lastMessage,
              content: delta
            };
          } else {
            updated[updated.length - 1] = {
              ...lastMessage,
              content: prevContent + delta
            };
          }
        } else {
          // Create new assistant message if none exists
          updated.push({
            type: 'assistant',
            content: delta,
            timestamp: Date.now()
          });
        }
        return updated;
      });
    },
    () => conversationHistory // Provide conversation history to the hook
  );

  // Effects
  useEffect(() => {
    setIsVisible(true);

    // Auto-focus the input when AskBar becomes visible
    const focusInput = () => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    };

    // Focus after animation completes
    setTimeout(focusInput, 300);

    // Load debug flag from storage once
    (async () => {
      try {
        const settings = await get();
        setDebugEnabled(!!settings.debug);
      } catch {}
    })();
  }, []);

  useEffect(() => {
    // Send conversation updates to parent content script for persistence
    window.parent.postMessage({
      type: 'sol-update-tab-conversation',
      messages: conversationHistory,
      conversationId: currentConversationId
    }, '*');
    
    // Also call the optional callback if provided
    if (onConversationUpdate) {
      onConversationUpdate(conversationHistory, currentConversationId);
    }
  }, [conversationHistory, currentConversationId, onConversationUpdate]);

  // Initialize current tab and get page content from current tab
  useEffect(() => {
    const initializeCurrentTab = async () => {
      try {
        // Listen for current tab response from parent (content script)
        const handleCurrentTabResponse = (event: MessageEvent) => {
          if (event.data?.type === 'sol-current-tab-response' && event.data.tabId) {
            console.log('Sol AskBar: Received current tab from parent:', event.data.tabId);
            setCurrentTabId(event.data.tabId);
            setPageUrl(event.data.url || window.location.href);
            setPageTitle(event.data.title || document.title);
          }
        };

        window.addEventListener('message', handleCurrentTabResponse);
        
        // Request current tab info from parent (content script)
        window.parent.postMessage({ type: 'sol-get-current-tab' }, '*');

        return () => {
          window.removeEventListener('message', handleCurrentTabResponse);
        };
      } catch (error) {
        console.error('Sol AskBar: Error initializing current tab:', error);
      }
    };

    initializeCurrentTab();
  }, []);

  // Load available tabs for tab chips
  useEffect(() => {
    const loadAvailableTabs = async () => {
      try {
        const tabs = await uiPortService.current.listTabs();
        const tabChips: TabChip[] = tabs.map(tab => ({
          id: tab.id,
          title: tab.title || 'Untitled',
          url: tab.url || '',
          favIconUrl: tab.favIconUrl
        }));
        setAvailableTabs(tabChips);
      } catch (error) {
        console.error('Sol AskBar: Failed to load available tabs:', error);
      }
    };

    loadAvailableTabs();
  }, []);

  // Auto-select current tab when available and no tabs selected
  useEffect(() => {
    if (currentTabId && selectedTabIds.length === 0) {
      setSelectedTabIds([currentTabId]);
    }
  }, [currentTabId]);

  // Sync mentioned tabs with selected tabs
  useEffect(() => {
    const mentionedTabIds = mentionedTabs.map(tab => tab.id);
    if (mentionedTabIds.length > 0) {
      const newSelectedTabIds = [...new Set([...selectedTabIds, ...mentionedTabIds])];
      if (newSelectedTabIds.length !== selectedTabIds.length) {
        setSelectedTabIds(newSelectedTabIds);
      }
    }
  }, [mentionedTabs]);

  // Validate and clean up selected tabs (remove closed tabs)
  useEffect(() => {
    if (selectedTabIds.length === 0) return;

    const validateSelectedTabs = async () => {
      try {
        // Get current live tabs
        const liveTabs = await uiPortService.current.listTabs();
        const liveTabIds = new Set(liveTabs.map(tab => tab.id));
        
        // Filter out closed tabs
        const validTabIds = selectedTabIds.filter(id => liveTabIds.has(id));
        
        // Update selection if any tags were closed
        if (validTabIds.length !== selectedTabIds.length) {
          console.log(`Sol AskBar: Removed ${selectedTabIds.length - validTabIds.length} closed tabs from selection`);
          setSelectedTabIds(validTabIds);
          
          // Auto-select current tab if no tabs left
          if (validTabIds.length === 0 && currentTabId) {
            setSelectedTabIds([currentTabId]);
          }
        }
      } catch (error) {
        console.error('Sol AskBar: Failed to validate selected tabs:', error);
      }
    };

    // Only validate when window gains focus (user might have closed tabs)
    const handleFocus = () => {
      validateSelectedTabs();
    };

    window.addEventListener('focus', handleFocus);
    
    // Initial validation (but not on every re-render)
    const timer = setTimeout(validateSelectedTabs, 1000);
    
    return () => {
      window.removeEventListener('focus', handleFocus);
      clearTimeout(timer);
    };
  }, []); // Empty dependency array - only run once on mount

  // Position and resize logic
  useLayoutEffect(() => {
    const sendBounds = () => {
      if (askBarRef.current) {
        const rect = askBarRef.current.getBoundingClientRect();
        // Send bounds in the format expected by iframeInjector
        window.parent.postMessage({
          type: 'sol-askbar-bounds',
          bounds: {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height
          }
        }, '*');
      }
    };

    const observer = new ResizeObserver(sendBounds);
    if (askBarRef.current) {
      observer.observe(askBarRef.current);
    }

    const messageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'sol-request-askbar-bounds') {
        sendBounds();
      } else if (event.data?.type === 'sol-init') {
        console.log('Sol AskBar: Received init message:', event.data);
      }
    };

    window.addEventListener('message', messageHandler);
    
    // Send bounds immediately and after a short delay
    sendBounds();
    setTimeout(sendBounds, 100);

    return () => {
      observer.disconnect();
      window.removeEventListener('message', messageHandler);
    };
  }, [isExpanded, conversationHistory.length]);

  // Mouse interaction handlers for pointer events
  useLayoutEffect(() => {
    const handleEnter = () => {
      // Enable pointer events when mouse enters AskBar
      window.parent.postMessage({ 
        type: 'sol-pointer-lock', 
        enabled: true 
      }, '*');
    };

    const handleLeave = () => {
      // Disable pointer events when mouse leaves AskBar
      window.parent.postMessage({ 
        type: 'sol-pointer-lock', 
        enabled: false 
      }, '*');
    };

    const askBar = askBarRef.current;
    if (askBar) {
      askBar.addEventListener('mouseenter', handleEnter);
      askBar.addEventListener('mouseleave', handleLeave);

      return () => {
        askBar.removeEventListener('mouseenter', handleEnter);
        askBar.removeEventListener('mouseleave', handleLeave);
      };
    }
  }, []);

  const handleClose = () => {
    if (Date.now() - mountTimeRef.current < 200) {
      console.log('Sol AskBar: Ignoring close during mount animation');
      return;
    }

    console.log('Sol AskBar: Close button clicked');
    
    // Ensure conversation is saved before closing
    window.parent.postMessage({
      type: 'sol-update-tab-conversation',
      messages: conversationHistory,
      conversationId: currentConversationId
    }, '*');
    
    setIsClosing(true);
    setIsVisible(false);
    
    // Send close message immediately, but with animation timing
    setTimeout(() => {
      window.parent.postMessage({ type: 'sol-close-askbar' }, '*');
      onUnmount?.();
    }, 300); // Match animation duration
  };

  const handleTabsChange = (tabIds: number[]) => {
    setSelectedTabIds(tabIds);
  };

  const handleTabRemove = (tabId: number) => {
    setSelectedTabIds(prev => prev.filter(id => id !== tabId));
  };

  // @ mention helper functions
  const parseTabMentions = (text: string): TabMention[] => {
    const mentions: TabMention[] = [];
    const mentionRegex = /@tab:(\d+):([^@]*?):/g;
    let match;

    while ((match = mentionRegex.exec(text)) !== null) {
      const tabId = parseInt(match[1]);
      const title = match[2];
      const tab = availableTabs.find(t => t.id === tabId);
      if (tab) {
        mentions.push({
          id: tabId,
          title: title || tab.title,
          url: tab.url,
          favIconUrl: tab.favIconUrl
        });
      }
    }

    return mentions;
  };

  const insertTabMention = (tab: TabChip) => {
    if (mentionStartPos === -1) return;

    const before = input.substring(0, mentionStartPos);
    const after = input.substring(inputRef.current?.selectionStart || mentionStartPos);
    const mention = `@tab:${tab.id}:${tab.title}:`;
    const newValue = before + mention + after;
    
    setInput(newValue);
    setShowDropdown(false);
    setMentionStartPos(-1);
    
    // Focus back to input
    setTimeout(() => {
      inputRef.current?.focus();
      const newPos = before.length + mention.length;
      inputRef.current?.setSelectionRange(newPos, newPos);
    }, 0);
  };

  const handleInputChange = (newValue: string) => {
    setInput(newValue);
    
    // Update mentioned tabs
    const newMentions = parseTabMentions(newValue);
    setMentionedTabs(newMentions);

    // Check for @ mentions
    const cursorPos = inputRef.current?.selectionStart || 0;
    const textBeforeCursor = newValue.substring(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');
    
    if (atIndex !== -1) {
      const afterAt = textBeforeCursor.substring(atIndex + 1);
      
      // Show dropdown if we have @ and it's not already a complete mention
      if (!afterAt.includes(':')) {
        setMentionStartPos(atIndex);
        setShowDropdown(true);
        setDropdownSelectedIndex(0);
        
        // Filter tabs based on search after @
        const searchTerm = afterAt.toLowerCase();
        const filtered = availableTabs.filter(tab => 
          tab.title.toLowerCase().includes(searchTerm) ||
          tab.url.toLowerCase().includes(searchTerm)
        );
        setFilteredTabs(filtered);
      } else {
        setShowDropdown(false);
      }
    } else {
      setShowDropdown(false);
      setMentionStartPos(-1);
    }
  };

  const handleInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Prevent parent handlers from receiving this key event
    e.stopPropagation();

    if (showDropdown && filteredTabs.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setDropdownSelectedIndex(prev => (prev + 1) % filteredTabs.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setDropdownSelectedIndex(prev => (prev - 1 + filteredTabs.length) % filteredTabs.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        insertTabMention(filteredTabs[dropdownSelectedIndex]);
      } else if (e.key === 'Escape') {
        setShowDropdown(false);
        setMentionStartPos(-1);
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    if (!input.trim()) return;

    // Parse mentioned tabs and update selected tabs if any mentions exist
    const mentionRegex = /@tab:(\d+):([^@]*?):/g;
    const mentionedTabIds = new Set<number>();
    let match;
    
    while ((match = mentionRegex.exec(input)) !== null) {
      const tabId = parseInt(match[1]);
      if (!isNaN(tabId)) {
        mentionedTabIds.add(tabId);
      }
    }

    // Calculate tabs to use BEFORE state update (combine existing + mentioned)
    const allTabIds = [...new Set([...selectedTabIds, ...Array.from(mentionedTabIds)])];
    let tabsToUse = allTabIds.length > 0 ? allTabIds : (currentTabId ? [currentTabId] : []);
    
    // Update selected tabs for UI display
    if (mentionedTabIds.size > 0) {
      setSelectedTabIds(allTabIds);
    }

    // Prevent duplicate consecutive user messages
    setConversationHistory(prev => {
      const last = prev[prev.length - 1];
      if (last && last.type === 'user' && last.content === input.trim()) {
        return prev; // Skip duplicate
      }
      return [...prev, {
      type: 'user',
      content: input.trim(),
        timestamp: Date.now(),
      }];
    });

    // Fallback to current tab if no tabs selected
    if (tabsToUse.length === 0 && currentTabId) {
      tabsToUse = [currentTabId];
      setSelectedTabIds([currentTabId]);
    }

    console.log('Sol AskBar: Ensuring content for tabs', tabsToUse);

    try {
      // Ensure background has scraped content for all tabs before asking question
      await uiPortService.current.getContent(tabsToUse);
    } catch (err) {
      console.warn('Sol AskBar: getContent failed', err);
    }

    console.log('Sol AskBar: Sending message with tabs:', tabsToUse);
    
    // Send message via chat system
    chatActions.sendMessage(input.trim(), tabsToUse, currentConversationId || 'new');

    // Clear input & expand
    setInput('');
    setIsExpanded(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClose();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Global ESC key handler
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Listen for context response to copy to clipboard
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'sol-context-response') {
        const text = JSON.stringify(event.data.context, null, 2);
        navigator.clipboard.writeText(text).then(() => {
          console.log('Sol AskBar: Context copied to clipboard');
        });
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Helper function to get base domain from URL
  const getBaseDomain = (url: string): string => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return url;
    }
  };

  // Helper function to truncate title
  const truncateTitle = (title: string, maxLength: number = 20): string => {
    return title.length > maxLength ? title.substring(0, maxLength) + '...' : title;
  };

  // Get selected tab chips for display
  const selectedTabChips = availableTabs.filter(tab => selectedTabIds.includes(tab.id));

  // Calculate conversation container height based on content
  const getConversationHeight = () => {
    const baseHeight = 200; // Minimum height
    const messageHeight = conversationHistory.length * 80; // Rough estimate per message
    const maxHeight = 600;
    return Math.min(Math.max(baseHeight, messageHeight), maxHeight);
  };

  return (
    <div 
      ref={askBarRef}
      className="fixed top-4 right-4 z-[2147483647] transition-all duration-300 ease-in-out font-inter"
      style={{
        opacity: isVisible ? 1 : 0,
        transform: `scale(${isVisible && !isClosing ? 1 : 0.9}) translateY(${isVisible && !isClosing ? 0 : 10}px)`,
        maxWidth: '90vw',
        maxHeight: '90vh',
        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      {isExpanded ? (
        // Expanded Mode - Full Conversation Container  
        <div 
          className="backdrop-blur-[16px] rounded-[28px] border-[0.5px] border-black/[0.07] transition-all duration-300 ease-in-out sol-conversation-shadow"
           style={{ 
            width: '436px',
            maxHeight: '600px',
            minHeight: '200px',
            height: 'auto',
            backgroundColor: 'rgba(255, 255, 255, 0.8)',
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          }}
        >
          {/* Header space */}
          <div className="p-2">
        </div>

          {/* Conversation Messages */}
          <div className="px-[14px] pb-2 max-h-[400px] overflow-y-auto">
            <ChatErrorBoundary>
              <ConversationList
                messages={conversationHistory}
                copiedMessageIndex={copiedMessageIndex}
                onCopyMessage={handleCopyMessage}
                isStreaming={chatState.isStreaming}
              />
            </ChatErrorBoundary>
          </div>

          {/* Input Area within conversation container */}
          <div className="p-2">
            <div 
              className="rounded-[20px] border-[0.5px] border-black/[0.07] sol-input-shadow"
              style={{ 
                width: '420px',
                backgroundColor: 'white',
                fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
              }}
            >
              {/* Tab Chips */}
              <UIErrorBoundary>
                <TabChipRow tabs={selectedTabChips} onRemove={handleTabRemove} />
              </UIErrorBoundary>

              {/* Input & buttons */}
              <div
                style={{
                  paddingTop: selectedTabChips.length > 0 ? '8px' : '16px',
                  paddingLeft: '16px',
                  paddingRight: '14px',
                  paddingBottom: '14px'
                }}
              >
                <UIErrorBoundary>
                  <InputArea
                    input={input}
                    onInputChange={handleInputChange}
                    onInputKeyDown={handleInputKeyDown}
                    inputRef={inputRef}
                    showDropdown={showDropdown}
                    filteredTabs={filteredTabs}
                    dropdownSelectedIndex={dropdownSelectedIndex}
                    insertTabMention={insertTabMention as any}
                    dropdownRef={dropdownRef}
                    setDropdownSelectedIndex={setDropdownSelectedIndex}
                    truncateTitle={truncateTitle}
                    onClose={handleClose}
                    onSubmit={handleSubmit}
                    isStreaming={chatState.isStreaming}
                  />
                </UIErrorBoundary>
          {chatState.error && (
                  <div className="mt-2 text-red-600 text-sm">{chatState.error}</div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        // Initial Mode - Just Input Container
        <div 
          className="rounded-[20px] border-[0.5px] border-black/[0.07] transition-all duration-300 ease-in-out transform sol-input-shadow-large"
          style={{ 
            width: '420px',
            backgroundColor: 'white',
            fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          }}
        >
          {/* Tab Chips */}
          <TabChipRow tabs={selectedTabChips} onRemove={handleTabRemove} />

          {/* Input Area */}
          <div
            style={{
              paddingTop: selectedTabChips.length > 0 ? '8px' : '16px',
              paddingLeft: '16px',
              paddingRight: '14px',
              paddingBottom: '14px'
            }}
          >
            <InputArea
              input={input}
              onInputChange={handleInputChange}
              onInputKeyDown={handleInputKeyDown}
              inputRef={inputRef}
              showDropdown={showDropdown}
              filteredTabs={filteredTabs}
              dropdownSelectedIndex={dropdownSelectedIndex}
              insertTabMention={insertTabMention as any}
              dropdownRef={dropdownRef}
              setDropdownSelectedIndex={setDropdownSelectedIndex}
              truncateTitle={truncateTitle}
              onClose={handleClose}
              onSubmit={handleSubmit}
              isStreaming={chatState.isStreaming}
            />
            {chatState.error && (
              <div className="mt-2 text-red-600 text-sm">{chatState.error}</div>
            )}
            </div>
        </div>
      )}
    </div>
  );
};

export default AskBar;