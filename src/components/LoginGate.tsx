import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const API_KEY_STORAGE = "alagappa_api_key";
const APP_INFO_STORAGE = "alagappa_app_info";
const API_URL_STORAGE = "alagappa_api_url";
const DEFAULT_API_URL = "https://api.alagappa.org";

interface ApiKeyInfo {
  valid: boolean;
  app_name: string | null;
  app_identifier: string | null;
  platform: string | null;
  intent: string | null;
}

interface LoginGateProps {
  children: React.ReactNode;
}

// Check if Tauri API is available
function isTauriAvailable(): boolean {
  return typeof window !== "undefined" &&
         typeof (window as any).__TAURI_INTERNALS__ !== "undefined" &&
         typeof (window as any).__TAURI_INTERNALS__.invoke === "function";
}

export default function LoginGate({ children }: LoginGateProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isVerifying, setIsVerifying] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<ApiKeyInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem(API_URL_STORAGE) || DEFAULT_API_URL);
  const [tempApiUrl, setTempApiUrl] = useState(apiUrl);

  // Load and verify stored API key on mount
  useEffect(() => {
    const verifyStoredKey = async () => {
      const storedKey = localStorage.getItem(API_KEY_STORAGE);
      const storedInfo = localStorage.getItem(APP_INFO_STORAGE);
      const storedUrl = localStorage.getItem(API_URL_STORAGE);

      if (storedUrl) {
        setApiUrl(storedUrl);
        setTempApiUrl(storedUrl);
      }

      if (!storedKey) {
        setIsLoading(false);
        return;
      }

      // Check if Tauri is ready
      if (!isTauriAvailable()) {
        // Wait a bit for Tauri to initialize
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!isTauriAvailable()) {
          setIsLoading(false);
          return;
        }
      }

      try {
        const result = await invoke<ApiKeyInfo>("verify_api_key", {
          apiKey: storedKey,
          apiUrl: storedUrl || null
        });

        if (result.valid) {
          setAppInfo(result);
          setIsAuthenticated(true);
          localStorage.setItem(APP_INFO_STORAGE, JSON.stringify(result));
        } else {
          // Key is no longer valid - clear it
          localStorage.removeItem(API_KEY_STORAGE);
          localStorage.removeItem(APP_INFO_STORAGE);
          setError("Your API key is no longer valid. Please enter a new one.");
        }
      } catch (err) {
        // Network error or server issue - try using cached info
        if (storedInfo) {
          try {
            const cachedInfo = JSON.parse(storedInfo);
            setAppInfo(cachedInfo);
            setIsAuthenticated(true);
          } catch {
            localStorage.removeItem(API_KEY_STORAGE);
            localStorage.removeItem(APP_INFO_STORAGE);
            setError("Failed to verify API key. Please try again.");
          }
        } else {
          const errorMessage = err instanceof Error ? err.message : String(err);
          setError(`Failed to connect to server: ${errorMessage}`);
        }
      } finally {
        setIsLoading(false);
      }
    };

    verifyStoredKey();
  }, []);

  const handleLogin = async () => {
    if (!apiKey.trim()) {
      setError("Please enter your API key");
      return;
    }

    setIsVerifying(true);
    setError(null);

    try {
      const result = await invoke<ApiKeyInfo>("verify_api_key", {
        apiKey: apiKey.trim(),
        apiUrl: apiUrl !== DEFAULT_API_URL ? apiUrl : null
      });

      if (result.valid) {
        localStorage.setItem(API_KEY_STORAGE, apiKey.trim());
        localStorage.setItem(APP_INFO_STORAGE, JSON.stringify(result));
        if (apiUrl !== DEFAULT_API_URL) {
          localStorage.setItem(API_URL_STORAGE, apiUrl);
        } else {
          localStorage.removeItem(API_URL_STORAGE);
        }
        setAppInfo(result);
        setIsAuthenticated(true);
      } else {
        setError("Invalid API key. Please check and try again.");
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSaveSettings = () => {
    if (tempApiUrl !== apiUrl) {
      // Clear any stored API key when URL changes
      localStorage.removeItem(API_KEY_STORAGE);
      localStorage.removeItem(APP_INFO_STORAGE);
      setApiKey("");
    }

    setApiUrl(tempApiUrl);
    if (tempApiUrl !== DEFAULT_API_URL) {
      localStorage.setItem(API_URL_STORAGE, tempApiUrl);
    } else {
      localStorage.removeItem(API_URL_STORAGE);
    }
    setShowSettings(false);
    setError(null);
  };

  const handleResetSettings = () => {
    setTempApiUrl(DEFAULT_API_URL);
  };

  const handleLogout = () => {
    localStorage.removeItem(API_KEY_STORAGE);
    localStorage.removeItem(APP_INFO_STORAGE);
    setIsAuthenticated(false);
    setAppInfo(null);
    setApiKey("");
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-800 to-indigo-900 flex items-center justify-center">
        <div className="text-center">
          <div className="mb-4">
            <svg className="animate-spin h-12 w-12 text-white mx-auto" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <p className="text-white text-lg font-medium">Verifying access...</p>
        </div>
      </div>
    );
  }

  // Not authenticated - show login
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-800 to-indigo-900 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-8 py-8 text-center">
            <div className="w-20 h-20 bg-white rounded-full mx-auto mb-4 flex items-center justify-center shadow-lg">
              <svg className="w-12 h-12 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white">Alagappa Tools</h1>
            <p className="text-blue-100 mt-2">Enter your API key to continue</p>
          </div>

          {/* Login Form */}
          <div className="px-8 py-8">
            {error && (
              <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-start gap-3">
                <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                placeholder="Enter your API key"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
                autoFocus
              />
              <p className="mt-2 text-xs text-gray-500">
                Get your API key from the Access Control section in Alagappa ERP
              </p>
            </div>

            <button
              onClick={handleLogin}
              disabled={isVerifying || !apiKey.trim()}
              className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg font-medium hover:from-blue-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {isVerifying ? (
                <>
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Verifying...
                </>
              ) : (
                <>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>
                  Sign In
                </>
              )}
            </button>
          </div>

          {/* Footer */}
          <div className="px-8 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
            <p className="text-xs text-gray-500">
              Server: <span className="font-medium">{apiUrl.replace(/^https?:\/\//, '')}</span>
            </p>
            <button
              onClick={() => { setTempApiUrl(apiUrl); setShowSettings(true); }}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              type="button"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </button>
          </div>
        </div>

        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
              <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-900">Server Settings</h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-gray-400 hover:text-gray-600"
                  type="button"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="px-6 py-4">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  API Server URL
                </label>
                <input
                  type="text"
                  value={tempApiUrl}
                  onChange={(e) => setTempApiUrl(e.target.value)}
                  placeholder="https://api.alagappa.org"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900"
                />
                <p className="mt-2 text-xs text-gray-500">
                  Default: {DEFAULT_API_URL}
                </p>

                <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-xs text-yellow-700">
                  <strong>Development:</strong> Use <code className="bg-yellow-100 px-1 rounded">http://localhost:8000</code> for local testing
                </div>
              </div>

              <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between">
                <button
                  onClick={handleResetSettings}
                  className="text-sm text-gray-600 hover:text-gray-800"
                  type="button"
                >
                  Reset to Default
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowSettings(false)}
                    className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveSettings}
                    className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    type="button"
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Authenticated - render children with logout option available via context/props
  return (
    <AuthContext.Provider value={{ appInfo, apiUrl, logout: handleLogout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Auth context for accessing logout and app info from anywhere
import { createContext, useContext } from "react";

interface AuthContextType {
  appInfo: ApiKeyInfo | null;
  apiUrl: string;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  appInfo: null,
  apiUrl: DEFAULT_API_URL,
  logout: () => {},
});

export const useAuth = () => useContext(AuthContext);
