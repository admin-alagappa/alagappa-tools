import { useState, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";

interface BiometricDevice {
  ip: string;
  mac: string;
  open_ports: number[];
}

interface AttendanceRecord {
  user_id: number;
  user_name: string;
  timestamp: string;
  status: number;
  punch: number;
  date: string;
  time: string;
  event: string;
}


// Check if Tauri API is available
function isTauriAvailable(): boolean {
  return typeof window !== "undefined" && 
         typeof (window as any).__TAURI_INTERNALS__ !== "undefined" &&
         typeof (window as any).__TAURI_INTERNALS__.invoke === "function";
}

// Safe wrapper for invoke that checks availability
async function safeInvoke<T>(cmd: string, args?: any): Promise<T> {
  if (!isTauriAvailable()) {
    throw new Error("Tauri API is not available. Please ensure you're running in a Tauri environment.");
  }
  
  try {
    return await invoke<T>(cmd, args);
  } catch (err: any) {
    // Handle the specific error where invoke is undefined
    if (err?.message?.includes("Cannot read properties of undefined") || 
        err?.message?.includes("invoke")) {
      throw new Error("Tauri API is not initialized. Please wait for the application to fully load.");
    }
    throw err;
  }
}

// Pagination constants
const RECORDS_PER_PAGE = 100;

export default function AttendanceModule() {
  const [devices, setDevices] = useState<BiometricDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [selectedDevice, setSelectedDevice] = useState<BiometricDevice | null>(null);
  const [attendanceData, setAttendanceData] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<string>("");
  const scanCancelledRef = useRef<boolean>(false);
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  
  // Manual connection state
  const [manualIp, setManualIp] = useState<string>("192.168.1.201");
  const [manualPort, setManualPort] = useState<string>("4370");
  const [connecting, setConnecting] = useState(false);
  
  // Paginated data - only compute what we need to display
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * RECORDS_PER_PAGE;
    const endIndex = startIndex + RECORDS_PER_PAGE;
    return attendanceData.slice(startIndex, endIndex);
  }, [attendanceData, currentPage]);
  
  const totalPages = Math.ceil(attendanceData.length / RECORDS_PER_PAGE);

  const scanNetwork = async (): Promise<void> => {
    setScanning(true);
    setError(null);
    scanCancelledRef.current = false;
    
    try {
      const result = await safeInvoke<BiometricDevice[]>("scan_for_devices");
      
      // Only update if scan wasn't cancelled
      if (!scanCancelledRef.current) {
        setDevices(result);
      }
    } catch (err: unknown) {
      // Only show error if scan wasn't cancelled
      if (!scanCancelledRef.current) {
        const errorMessage: string = err instanceof Error 
          ? err.message 
          : typeof err === 'string' 
          ? err 
          : 'Unknown error occurred';
        setError(errorMessage);
        console.error("Scan error:", err);
      }
    } finally {
      setScanning(false);
      scanCancelledRef.current = false;
    }
  };

  const stopScan = (): void => {
    scanCancelledRef.current = true;
    setScanning(false);
    setError(null);
  };

  // Manual connection function (like Python script)
  const connectManually = async (): Promise<void> => {
    if (!manualIp.trim()) {
      setError("Please enter a valid IP address");
      return;
    }
    
    const port = parseInt(manualPort) || 4370;
    
    setConnecting(true);
    setLoading(true);
    setError(null);
    setAttendanceData([]);
    setCurrentPage(1);
    setLoadingProgress("Connecting to device...");
    
    // Create a virtual device for display
    const virtualDevice: BiometricDevice = {
      ip: manualIp.trim(),
      mac: "Manual Connection",
      open_ports: [port],
    };
    setSelectedDevice(virtualDevice);
    
    try {
      console.log(`🔌 Connecting to ${manualIp}:${port}...`);
      setLoadingProgress("Fetching attendance data (this may take 30-60 seconds for large datasets)...");
      
      const result = await safeInvoke<AttendanceRecord[]>("fetch_attendance", {
        ip: manualIp.trim(),
        port: port,
      });
      
      console.log(`✅ Received ${result.length} attendance records`);
      setLoadingProgress(`Processing ${result.length} records...`);
      
      // Small delay to let UI update
      await new Promise(resolve => setTimeout(resolve, 100));
      
      setAttendanceData(result);
      setLoadingProgress("");
      
      // Add to devices list if not already there
      if (!devices.some(d => d.ip === manualIp.trim())) {
        setDevices(prev => [...prev, virtualDevice]);
      }
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error 
        ? err.message 
        : typeof err === 'string' 
        ? err 
        : 'Unknown error occurred';
      setError(errorMessage);
      console.error("Manual connection error:", err);
    } finally {
      setConnecting(false);
      setLoading(false);
      setLoadingProgress("");
    }
  };

  const fetchAttendance = async (device: BiometricDevice): Promise<void> => {
    setLoading(true);
    setError(null);
    setSelectedDevice(device);
    setCurrentPage(1);
    setLoadingProgress("Connecting to device...");
    
    const port: number = device.open_ports.includes(4370) 
      ? 4370 
      : device.open_ports[0] ?? 4370;
    
    try {
      setLoadingProgress("Fetching attendance data (this may take 30-60 seconds for large datasets)...");
      const result = await safeInvoke<AttendanceRecord[]>("fetch_attendance", {
        ip: device.ip,
        port: port,
      });
      
      setLoadingProgress(`Processing ${result.length} records...`);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      setAttendanceData(result);
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error 
        ? err.message 
        : typeof err === 'string' 
        ? err 
        : 'Unknown error occurred';
      setError(errorMessage);
      console.error("Fetch error:", err);
      setAttendanceData([]);
    } finally {
      setLoading(false);
      setLoadingProgress("");
    }
  };

  const handleDeviceSelect = (deviceId: string): void => {
    setSelectedDeviceId(deviceId);
    const device = devices.find((d, idx) => `${d.ip}-${idx}` === deviceId);
    setSelectedDevice(device || null);
    setAttendanceData([]); // Clear previous attendance data when selecting new device
  };

  const handleSync = async (): Promise<void> => {
    if (!selectedDevice) {
      setError("Please select a device first");
      return;
    }

    setSyncing(true);
    setError(null);
    
    try {
      // TODO: Implement sync functionality
      // This will be implemented later based on user requirements
      console.log("Syncing device:", selectedDevice);
      
      // Placeholder - will be replaced with actual sync logic
      await new Promise((resolve) => setTimeout(resolve, 1000));
      
      setError("Sync functionality will be implemented soon");
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error 
        ? err.message 
        : typeof err === 'string' 
        ? err 
        : 'Unknown error occurred';
      setError(errorMessage);
      console.error("Sync error:", err);
    } finally {
      setSyncing(false);
    }
  };

  const exportAttendanceToCSV = (): void => {
    if (attendanceData.length === 0) return;

    const headers = ["User ID", "User Name", "Date", "Time", "Event", "Status", "Punch", "Timestamp"];
    const rows = attendanceData.map((record) => [
      record.user_id.toString(),
      record.user_name,
      record.date,
      record.time,
      record.event,
      record.status.toString(),
      record.punch.toString(),
      record.timestamp,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
    ].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance_${selectedDevice?.ip || 'export'}_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  
  
  // Legacy export function for backwards compatibility
  const exportToCSV = exportAttendanceToCSV;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h2 className="text-2xl font-bold text-gray-800">Attendance Management</h2>
        <p className="text-sm text-gray-600 mt-1">Scan and fetch attendance data from biometric devices</p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Manual Connection Section - Primary Method */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-2 mb-4">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            <h3 className="text-lg font-semibold text-gray-800">Direct Connection</h3>
            <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded-full">Recommended</span>
          </div>
          
          <p className="text-sm text-gray-600 mb-4">
            Enter your ZKTeco device IP address and port to connect directly. This is faster and more reliable than network scanning.
          </p>
          
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1">
              <label htmlFor="manual-ip" className="block text-sm font-medium text-gray-700 mb-1">
                Device IP Address
              </label>
              <input
                id="manual-ip"
                type="text"
                value={manualIp}
                onChange={(e) => setManualIp(e.target.value)}
                placeholder="192.168.1.201"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
            </div>
            <div className="w-32">
              <label htmlFor="manual-port" className="block text-sm font-medium text-gray-700 mb-1">
                Port
              </label>
              <input
                id="manual-port"
                type="text"
                value={manualPort}
                onChange={(e) => setManualPort(e.target.value)}
                placeholder="4370"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={connectManually}
                disabled={connecting || loading}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                type="button"
              >
                {connecting ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Connecting...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    Connect & Fetch
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Device Scanner Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-gray-800">Network Scanner</h3>
              <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">Optional</span>
            </div>
            <div className="flex items-center gap-2">
              {scanning ? (
                <button
                  onClick={stopScan}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"
                  type="button"
                  aria-label="Stop scanning"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  Stop Scanning
                </button>
              ) : (
                <button
                  onClick={scanNetwork}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors flex items-center gap-2"
                  type="button"
                  aria-label="Scan network for biometric devices"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  Scan Network
                </button>
              )}
              {scanning && (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span>Scanning network...</span>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span>Error: {error}</span>
              </div>
            </div>
          )}

          {devices.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <p className="text-sm text-gray-600 font-medium mb-2">
                Found {devices.length} biometric device(s)
              </p>
            </div>
          )}
        </div>

        {/* Device Selector & Sync Section */}
        {devices.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Device Management</h3>
            
            <div className="flex flex-col md:flex-row gap-4">
              {/* Device Dropdown */}
              <div className="flex-1">
                <label htmlFor="device-select" className="block text-sm font-medium text-gray-700 mb-2">
                  Select Device
                </label>
                <select
                  id="device-select"
                  value={selectedDeviceId}
                  onChange={(e): void => handleDeviceSelect(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white text-gray-800"
                >
                  <option value="">-- Select a device --</option>
                  {devices.map((device, idx) => {
                    const deviceId = `${device.ip}-${idx}`;
                    return (
                      <option key={deviceId} value={deviceId}>
                        {device.ip} ({device.mac}) - Ports: {device.open_ports.join(", ")}
                      </option>
                    );
                  })}
                </select>
                {selectedDevice && (
                  <div className="mt-2 p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-primary-100 rounded-lg flex items-center justify-center">
                        <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                        </svg>
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-800">IP: {selectedDevice.ip}</p>
                        <p className="text-xs text-gray-500">MAC: {selectedDevice.mac}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Sync Button */}
              <div className="flex items-end">
                <button
                  onClick={handleSync}
                  disabled={!selectedDevice || syncing}
                  className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                  type="button"
                  aria-label="Sync device"
                >
                  {syncing ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Syncing...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Sync
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Fetch Attendance Button */}
            {selectedDevice && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <button
                  onClick={(): void => {
                    if (selectedDevice) {
                      void fetchAttendance(selectedDevice);
                    }
                  }}
                  disabled={loading}
                  className="w-full md:w-auto px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                  type="button"
                  aria-label="Fetch attendance from selected device"
                >
                  {loading ? (
                    <>
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Loading...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Fetch Attendance
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Attendance Data Section */}
        {selectedDevice && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Attendance Data</h3>
                {selectedDevice && (
                  <p className="text-sm text-gray-600 mt-1">
                    Device: {selectedDevice.ip} | Records: {attendanceData.length}
                  </p>
                )}
              </div>
              {attendanceData.length > 0 && (
                <button
                  onClick={exportToCSV}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors flex items-center gap-2"
                  type="button"
                  aria-label="Export attendance data to CSV"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Export to CSV
                </button>
              )}
            </div>

            {loading ? (
              <div className="text-center py-12">
                <svg className="animate-spin h-8 w-8 text-primary-600 mx-auto mb-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <p className="text-gray-600 font-medium">Loading attendance data...</p>
                {loadingProgress && (
                  <p className="text-sm text-gray-500 mt-2">{loadingProgress}</p>
                )}
              </div>
            ) : attendanceData.length > 0 ? (
              <>
                {/* Download Buttons Section */}
                <div className="mb-4 p-4 bg-gray-50 rounded-lg flex flex-wrap gap-3 items-center">
                  <span className="text-sm font-medium text-gray-700">Download:</span>
                  <button
                    onClick={exportAttendanceToCSV}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2 text-sm"
                    type="button"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Attendance CSV ({attendanceData.length.toLocaleString()} records)
                  </button>
                  <span className="text-xs text-gray-500">
                    Showing {((currentPage - 1) * RECORDS_PER_PAGE) + 1} - {Math.min(currentPage * RECORDS_PER_PAGE, attendanceData.length)} of {attendanceData.length.toLocaleString()}
                  </span>
                </div>
                
                {/* Pagination Controls - Top */}
                {totalPages > 1 && (
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setCurrentPage(1)}
                        disabled={currentPage === 1}
                        className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        First
                      </button>
                      <button
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Previous
                      </button>
                      <span className="px-3 py-1 text-sm text-gray-700">
                        Page {currentPage} of {totalPages}
                      </span>
                      <button
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Next
                      </button>
                      <button
                        onClick={() => setCurrentPage(totalPages)}
                        disabled={currentPage === totalPages}
                        className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Last
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-sm text-gray-600">Go to page:</label>
                      <input
                        type="number"
                        min={1}
                        max={totalPages}
                        value={currentPage}
                        onChange={(e) => {
                          const page = parseInt(e.target.value);
                          if (page >= 1 && page <= totalPages) {
                            setCurrentPage(page);
                          }
                        }}
                        className="w-20 px-2 py-1 text-sm border border-gray-300 rounded"
                      />
                    </div>
                  </div>
                )}
                
                <div className="overflow-x-auto border border-gray-200 rounded-lg">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          #
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          User ID
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          User Name
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Date
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Time
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Event
                        </th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {paginatedData.map((record, idx) => (
                        <tr key={idx} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-400">
                            {((currentPage - 1) * RECORDS_PER_PAGE) + idx + 1}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {record.user_id}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {record.user_name}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {record.date}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {record.time}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                              record.event === "Check In" 
                                ? "bg-green-100 text-green-800"
                                : record.event === "Check Out"
                                ? "bg-red-100 text-red-800"
                                : "bg-gray-100 text-gray-800"
                            }`}>
                              {record.event}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {record.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                
                {/* Pagination Controls - Bottom */}
                {totalPages > 1 && (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ← Previous
                    </button>
                    <span className="px-4 py-2 text-sm text-gray-600">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Next →
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <svg className="w-12 h-12 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p>No attendance data found</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

