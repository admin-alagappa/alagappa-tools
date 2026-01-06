import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

// Types
interface ChatMessage {
  role: string;
  content: string;
}

interface AIProvider {
  name: string;
  available: boolean;
  models: string[];
}

interface ChatResponse {
  content: string;
  model: string;
  provider: string;
}

interface BitNetPrerequisites {
  git: boolean;
  python: boolean;
  cmake: boolean;
  conda: boolean;
}

interface BitNetSetupStatus {
  installed: boolean;
  built: boolean;
  install_path: string | null;
  has_models: boolean;
  models: string[];
  prerequisites: BitNetPrerequisites;
}

export default function AlagappaAI() {
  // State
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>("ollama");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>("");
  const [showApiKey, setShowApiKey] = useState(false);
  
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // BitNet setup state
  const [bitnetStatus, setBitnetStatus] = useState<BitNetSetupStatus | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load providers on mount
  useEffect(() => {
    loadProviders();
    // Load API key from localStorage
    const savedKey = localStorage.getItem("openai_api_key");
    if (savedKey) setApiKey(savedKey);
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadProviders = async () => {
    try {
      const providerList = await invoke<AIProvider[]>("ai_get_providers");
      setProviders(providerList);
      
      // Select first available provider
      const available = providerList.find(p => p.available && p.models.length > 0);
      if (available) {
        setSelectedProvider(available.name);
        setSelectedModel(available.models[0] || "");
      }
    } catch (err) {
      console.error("Failed to load providers:", err);
    }
  };

  const getCurrentProvider = (): AIProvider | undefined => {
    return providers.find(p => p.name === selectedProvider);
  };

  const saveApiKey = () => {
    localStorage.setItem("openai_api_key", apiKey);
  };

  // BitNet setup functions
  const loadBitnetStatus = async () => {
    try {
      const status = await invoke<BitNetSetupStatus>("bitnet_get_status");
      setBitnetStatus(status);
    } catch (err) {
      console.error("Failed to get BitNet status:", err);
    }
  };

  const handleInstallBitnet = async () => {
    setIsInstalling(true);
    setSetupMessage(null);
    try {
      const result = await invoke<string>("bitnet_install");
      setSetupMessage(result);
      await loadBitnetStatus();
      await loadProviders();
    } catch (err) {
      setSetupMessage(`Error: ${err}`);
    } finally {
      setIsInstalling(false);
    }
  };

  const handleBuildBitnet = async () => {
    setIsBuilding(true);
    setSetupMessage("Building BitNet... This may take a few minutes.");
    try {
      const result = await invoke<string>("bitnet_build");
      setSetupMessage(result);
      await loadBitnetStatus();
      await loadProviders();
    } catch (err) {
      setSetupMessage(`Error: ${err}`);
    } finally {
      setIsBuilding(false);
    }
  };

  const handleDownloadModel = async (modelName: string) => {
    setIsDownloading(true);
    setSetupMessage(null);
    try {
      const result = await invoke<string>("bitnet_download_model", { modelName });
      setSetupMessage(result);
      await loadBitnetStatus();
      await loadProviders();
    } catch (err) {
      setSetupMessage(`Error: ${err}`);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleUninstallBitnet = async () => {
    if (!confirm("Are you sure you want to uninstall BitNet? This will remove all models.")) {
      return;
    }
    setIsInstalling(true);
    setSetupMessage(null);
    try {
      const result = await invoke<string>("bitnet_uninstall");
      setSetupMessage(result);
      await loadBitnetStatus();
      await loadProviders();
    } catch (err) {
      setSetupMessage(`Error: ${err}`);
    } finally {
      setIsInstalling(false);
    }
  };

  // Load BitNet status when provider changes to bitnet
  useEffect(() => {
    if (selectedProvider === "bitnet") {
      loadBitnetStatus();
    }
  }, [selectedProvider]);

  const sendMessage = async () => {
    if (!inputText.trim() || isLoading) return;

    const userMessage: ChatMessage = { role: "user", content: inputText.trim() };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInputText("");
    setIsLoading(true);
    setError(null);

    try {
      // Get system prompt
      const systemPrompt = await invoke<string>("ai_get_system_prompt");
      
      // Build messages with system prompt
      const chatMessages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        ...newMessages,
      ];

      const response = await invoke<ChatResponse>("ai_chat", {
        request: {
          messages: chatMessages,
          model: selectedModel || null,
          provider: selectedProvider,
        },
        apiKey: selectedProvider === "openai" ? apiKey : null,
      });

      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.content,
      };
      setMessages([...newMessages, assistantMessage]);
    } catch (err) {
      setError(`${err}`);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
  };

  const ollamaAvailable = providers.find(p => p.name === "ollama")?.available &&
                          (providers.find(p => p.name === "ollama")?.models.length || 0) > 0;

  return (
    <div className="h-full flex flex-col bg-gradient-to-b from-gray-50 to-white">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
              <span className="text-white text-xl">🤖</span>
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-800">Alagappa AI</h2>
              <p className="text-xs text-gray-500">Your intelligent assistant</p>
            </div>
          </div>
          
          {/* Model Selector */}
          <div className="flex items-center gap-3">
            <select
              value={selectedProvider}
              onChange={(e) => {
                setSelectedProvider(e.target.value);
                const provider = providers.find(p => p.name === e.target.value);
                if (provider && provider.models.length > 0) {
                  setSelectedModel(provider.models[0]!);
                }
              }}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white"
            >
              {providers.map(p => (
                <option key={p.name} value={p.name} disabled={!p.available && p.name !== "bitnet"}>
                  {p.name === "ollama" ? "🦙 Ollama" : p.name === "bitnet" ? "⚡ BitNet" : "🔮 OpenAI"}
                  {!p.available && p.name !== "bitnet" && " (not available)"}
                  {p.name === "bitnet" && !p.available && " (setup required)"}
                </option>
              ))}
            </select>
            
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg bg-white min-w-[120px]"
            >
              {getCurrentProvider()?.models.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            
            <button
              onClick={clearChat}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors"
              title="Clear chat"
            >
              🗑️
            </button>
          </div>
        </div>
        
        {/* OpenAI API Key Input */}
        {selectedProvider === "openai" && (
          <div className="mt-3 flex items-center gap-2">
            <input
              type={showApiKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onBlur={saveApiKey}
              placeholder="Enter OpenAI API Key"
              className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg"
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              className="px-2 py-1.5 text-sm text-gray-500 hover:text-gray-700"
            >
              {showApiKey ? "👁️" : "👁️‍🗨️"}
            </button>
          </div>
        )}
        
        {/* Ollama not available warning */}
        {selectedProvider === "ollama" && !ollamaAvailable && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
            <strong>Ollama not detected.</strong> Install it from{" "}
            <a href="https://ollama.ai" target="_blank" rel="noopener" className="underline">ollama.ai</a>
            {" "}then run: <code className="bg-amber-100 px-1 rounded">ollama pull llama3.2</code>
          </div>
        )}

        {/* BitNet Setup Panel - Only show if not fully ready */}
        {selectedProvider === "bitnet" && bitnetStatus && !(bitnetStatus.installed && bitnetStatus.built && bitnetStatus.models.length > 0) && (
          <div className="mt-3 p-4 bg-gray-50 border border-gray-200 rounded-lg">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold text-gray-700">BitNet Setup</h4>
              {bitnetStatus.installed && (
                <button
                  onClick={handleUninstallBitnet}
                  disabled={isInstalling || isBuilding || isDownloading}
                  className="px-2 py-1 text-xs text-red-600 hover:text-red-800"
                >
                  Uninstall
                </button>
              )}
            </div>

            {/* Step-by-step setup buttons */}
            <div className="flex flex-wrap gap-2">
              {/* Step 1: Clone */}
              <button
                onClick={handleInstallBitnet}
                disabled={isInstalling || isBuilding || isDownloading || bitnetStatus.installed}
                className={`px-3 py-2 text-sm rounded-lg flex items-center gap-2 ${
                  bitnetStatus.installed
                    ? "bg-green-100 text-green-700"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                } disabled:opacity-50`}
              >
                {isInstalling ? "⏳ Cloning..." : bitnetStatus.installed ? "✓ Cloned" : "1. Clone"}
              </button>

              {/* Step 2: Download Model */}
              <button
                onClick={() => handleDownloadModel("BitNet-b1.58-2B-4T")}
                disabled={isInstalling || isBuilding || isDownloading || !bitnetStatus.installed || bitnetStatus.models.length > 0}
                className={`px-3 py-2 text-sm rounded-lg flex items-center gap-2 ${
                  bitnetStatus.models.length > 0
                    ? "bg-green-100 text-green-700"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                } disabled:opacity-50`}
              >
                {isDownloading ? "⏳ Downloading..." : bitnetStatus.models.length > 0 ? "✓ Downloaded" : "2. Download Model"}
              </button>

              {/* Step 3: Build */}
              <button
                onClick={handleBuildBitnet}
                disabled={isInstalling || isBuilding || isDownloading || !bitnetStatus.installed || bitnetStatus.built}
                className={`px-3 py-2 text-sm rounded-lg flex items-center gap-2 ${
                  bitnetStatus.built
                    ? "bg-green-100 text-green-700"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                } disabled:opacity-50`}
              >
                {isBuilding ? "⏳ Building..." : bitnetStatus.built ? "✓ Built" : "3. Build"}
              </button>
            </div>

            {setupMessage && (
              <div className={`mt-3 p-2 rounded text-xs ${setupMessage.startsWith("Error") ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                {setupMessage}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-gray-400">
            <div className="w-20 h-20 bg-gradient-to-br from-blue-100 to-purple-100 rounded-2xl flex items-center justify-center mb-4">
              <span className="text-4xl">💬</span>
            </div>
            <p className="text-lg font-medium">Start a conversation</p>
            <p className="text-sm mt-1">Ask me anything about Alagappa Tools!</p>
            
            {/* Quick suggestions */}
            <div className="flex flex-wrap gap-2 mt-6 max-w-md justify-center">
              {[
                "How do I sync attendance?",
                "Convert Excel to CSV",
                "Compress a video",
                "Resize multiple images",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInputText(suggestion);
                    inputRef.current?.focus();
                  }}
                  className="px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-full hover:bg-gray-50 hover:border-gray-300 transition-colors"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] px-4 py-3 rounded-2xl ${
                msg.role === "user"
                  ? "bg-blue-600 text-white rounded-br-md"
                  : "bg-white border border-gray-200 text-gray-800 rounded-bl-md shadow-sm"
              }`}
            >
              <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
                <span className="text-sm text-gray-500">Thinking...</span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            <strong>Error:</strong> {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-gray-200 bg-white p-4">
        <div className="flex items-end gap-3">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message... (Shift+Enter for new line)"
              rows={1}
              className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-xl resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              style={{ minHeight: "48px", maxHeight: "120px" }}
            />
          </div>
          <button
            onClick={sendMessage}
            disabled={!inputText.trim() || isLoading}
            className="px-5 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            <span>Send</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-400 text-center">
          Using {selectedProvider === "ollama" ? "🦙 Ollama" : selectedProvider === "bitnet" ? "⚡ BitNet" : "🔮 OpenAI"} • {selectedModel}
        </div>
      </div>
    </div>
  );
}
