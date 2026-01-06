import { useState } from "react";
import { useAuth } from "./LoginGate";

const DEFAULT_API_URL = "https://api.alagappa.org";

interface LayoutProps {
  children: React.ReactNode;
  activeTool: string;
  onToolChange: (toolId: string) => void;
}

interface MenuItem {
  id: string;
  name: string;
  icon: string;
}

export default function Layout({ children, activeTool, onToolChange }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const { appInfo, apiUrl, logout } = useAuth();
  const [showSettings, setShowSettings] = useState(false);
  const [tempApiUrl, setTempApiUrl] = useState(apiUrl);

  const handleSaveSettings = () => {
    if (tempApiUrl !== apiUrl) {
      // Clear API key and app info when URL changes
      localStorage.removeItem("alagappa_api_key");
      localStorage.removeItem("alagappa_app_info");

      if (tempApiUrl && tempApiUrl !== DEFAULT_API_URL) {
        localStorage.setItem("alagappa_api_url", tempApiUrl);
      } else {
        localStorage.removeItem("alagappa_api_url");
      }
      // Reload the page - will go to login since API key is cleared
      window.location.reload();
    }
    setShowSettings(false);
  };

  const handleResetSettings = () => {
    setTempApiUrl(DEFAULT_API_URL);
  };

  const menuItems: MenuItem[] = [
    {
      id: "ai",
      name: "Alagappa AI",
      icon: "🤖",
    },
    {
      id: "attendance",
      name: "Attendance",
      icon: "📊",
    },
    {
      id: "document",
      name: "Documents",
      icon: "📄",
    },
    {
      id: "image",
      name: "Images",
      icon: "🖼️",
    },
    {
      id: "video",
      name: "Videos",
      icon: "🎬",
    },
  ];

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside
        className={`${
          sidebarOpen ? "w-64" : "w-20"
        } bg-white border-r border-gray-200 transition-all duration-300 flex flex-col`}
      >
        {/* Logo/Header */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200">
          {sidebarOpen && (
            <h1 className="text-xl font-bold text-gray-800">Alagappa Tools</h1>
          )}
          <button
            onClick={(): void => setSidebarOpen(!sidebarOpen)}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            type="button"
            aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          >
            <svg
              className="w-5 h-5 text-gray-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={sidebarOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"}
              />
            </svg>
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={(): void => onToolChange(item.id)}
              className={`w-full flex items-center ${
                sidebarOpen ? "justify-start px-4" : "justify-center"
              } py-3 rounded-lg transition-all ${
                activeTool === item.id
                  ? "bg-primary-50 text-primary-700 font-medium"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
              type="button"
              aria-label={item.name}
            >
              <span className="text-xl">{item.icon}</span>
              {sidebarOpen && <span className="ml-3">{item.name}</span>}
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 space-y-2">
          {sidebarOpen && appInfo && (
            <div className="text-xs text-gray-500 text-center mb-2">
              <p className="font-medium text-gray-700 truncate" title={appInfo.app_name || undefined}>
                {appInfo.app_name || "Alagappa Tools"}
              </p>
              <p className="text-gray-400 truncate" title={apiUrl}>
                {apiUrl.replace(/^https?:\/\//, '')}
              </p>
            </div>
          )}
          <button
            onClick={() => { setTempApiUrl(apiUrl); setShowSettings(true); }}
            className={`w-full flex items-center ${
              sidebarOpen ? "justify-start px-4" : "justify-center"
            } py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg transition-colors`}
            type="button"
            title="Settings"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {sidebarOpen && <span className="ml-2">Settings</span>}
          </button>
          <button
            onClick={logout}
            className={`w-full flex items-center ${
              sidebarOpen ? "justify-start px-4" : "justify-center"
            } py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors`}
            type="button"
            title="Logout"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            {sidebarOpen && <span className="ml-2">Logout</span>}
          </button>
          {sidebarOpen && (
            <div className="text-xs text-gray-400 text-center pt-2">
              Version 1.0.0
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        <div className="h-full">{children}</div>
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Settings</h3>
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
                <strong>Note:</strong> Changing the server URL will reload the app to apply changes.
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

