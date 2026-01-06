import { useState, useRef, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useAuth } from "./LoginGate";

const STORAGE_KEY = "biometric_devices";
const ATTENDANCE_STORAGE_PREFIX = "attendance_data_";

// ERP Types
interface ErpConfig {
  api_key: string;
  api_url?: string;
}

interface FacultyAttendancePayload {
  faculty: number;
  date: string;
  check_in_time: string | null;
  check_out_time: string | null;
  is_present: boolean;
  notes: string | null;
}

interface SyncResult {
  success: boolean;
  synced_count: number;
  skipped_count: number;
  failed_count: number;
  errors: string[];
}

// Load ERP config from localStorage (uses login API key)
function loadErpConfig(): ErpConfig {
  try {
    const apiKey = localStorage.getItem("alagappa_api_key") || "";
    const apiUrl = localStorage.getItem("alagappa_api_url") || undefined;
    return { api_key: apiKey, api_url: apiUrl };
  } catch (e) {
    console.error("Failed to load ERP config:", e);
  }
  return { api_key: "" };
}


interface BiometricDevice {
  ip: string;
  mac: string;
  open_ports: number[];
  // Custom name set by user (shown as header)
  custom_name?: string;
  // Device info (populated after first sync)
  device_name?: string;
  firmware_version?: string;
  serial_number?: string;
  last_synced?: string;
}

// Load devices from localStorage
function loadDevicesFromStorage(): BiometricDevice[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Failed to load devices from storage:", e);
  }
  return [];
}

// Save devices to localStorage
function saveDevicesToStorage(devices: BiometricDevice[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(devices));
  } catch (e) {
    console.error("Failed to save devices to storage:", e);
  }
}

// Load attendance data for a specific device
// Get storage key for device (prefer serial number, fallback to IP)
function getDeviceStorageKey(device: BiometricDevice): string {
  if (device.serial_number) {
    return ATTENDANCE_STORAGE_PREFIX + device.serial_number.replace(/[^a-zA-Z0-9]/g, '_');
  }
  return ATTENDANCE_STORAGE_PREFIX + device.ip.replace(/\./g, '_');
}

function loadAttendanceFromStorage(device: BiometricDevice): AttendanceRecord[] {
  try {
    const key = getDeviceStorageKey(device);
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error("Failed to load attendance from storage:", e);
  }
  return [];
}

// Save attendance data for a specific device
function saveAttendanceToStorage(device: BiometricDevice, records: AttendanceRecord[]): void {
  try {
    const key = getDeviceStorageKey(device);
    localStorage.setItem(key, JSON.stringify(records));
  } catch (e) {
    console.error("Failed to save attendance to storage:", e);
  }
}

// Raw record from device (no event calculation)
interface AttendanceRecord {
  user_id: number;
  user_name: string;
  timestamp: string;
  status: number;
  punch: number;
  date: string;
  time: string;
}

// Calculated summary per user per day
interface DailySummary {
  user_id: number;
  user_name: string;
  date: string;
  first_punch: string;  // First punch time (Check In)
  last_punch: string;   // Last punch time (Check Out)
  total_punches: number;
  working_hours: string; // Calculated duration
}

// Device information from ZKTeco device
interface DeviceInfo {
  device_name: string;
  firmware_version: string;
  serial_number: string;
  platform: string;
  mac_address: string;
}

// Response from fetch_attendance command
interface AttendanceResponse {
  device_info: DeviceInfo;
  records: AttendanceRecord[];
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

// Calculate daily summary from raw attendance records
// Convert time string (HH:MM:SS) to seconds
function timeToSeconds(time: string): number {
  const parts = time.split(":");
  const hours = parseInt(parts[0] || "0");
  const minutes = parseInt(parts[1] || "0");
  const seconds = parseInt(parts[2] || "0");
  return hours * 3600 + minutes * 60 + seconds;
}

// Buffer time in seconds to filter duplicate entries
const DUPLICATE_BUFFER_SECONDS = 50;

function calculateDailySummary(records: AttendanceRecord[]): DailySummary[] {
  // Group records by user_id + date
  const grouped = new Map<string, AttendanceRecord[]>();
  
  for (const record of records) {
    const key = `${record.user_id}_${record.date}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(record);
    } else {
      grouped.set(key, [record]);
    }
  }
  
  // Calculate summary for each group
  const summaries: DailySummary[] = [];
  
  grouped.forEach((dayRecords) => {
    if (dayRecords.length === 0) return;
    
    // Sort by time (earliest first)
    dayRecords.sort((a, b) => a.time.localeCompare(b.time));
    
    // Filter out duplicate punches within buffer time
    const filteredRecords: AttendanceRecord[] = [];
    for (const record of dayRecords) {
      const lastFiltered = filteredRecords[filteredRecords.length - 1];
      if (!lastFiltered) {
        filteredRecords.push(record);
      } else {
        const timeDiff = timeToSeconds(record.time) - timeToSeconds(lastFiltered.time);
        if (timeDiff > DUPLICATE_BUFFER_SECONDS) {
          filteredRecords.push(record);
        }
      }
    }
    
    const firstRecord = filteredRecords[0];
    if (!firstRecord) return;
    
    // Calculate working hours using alternating In/Out logic
    // Punch 1 = In, Punch 2 = Out, Punch 3 = In, Punch 4 = Out, etc.
    let totalWorkingSeconds = 0;
    const isCheckedIn = filteredRecords.length % 2 === 1;
    const isToday = firstRecord.date === new Date().toISOString().split('T')[0];
    
    for (let i = 0; i < filteredRecords.length; i += 2) {
      const checkIn = filteredRecords[i];
      const checkOut = filteredRecords[i + 1];
      
      if (checkIn && checkOut) {
        // Complete In/Out pair - add working time
        const inSeconds = timeToSeconds(checkIn.time);
        const outSeconds = timeToSeconds(checkOut.time);
        totalWorkingSeconds += (outSeconds - inSeconds);
      } else if (checkIn && !checkOut && isToday) {
        // Currently checked in (today only) - add time until now
        const inSeconds = timeToSeconds(checkIn.time);
        const now = new Date();
        const nowSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        if (nowSeconds > inSeconds) {
          totalWorkingSeconds += (nowSeconds - inSeconds);
        }
      }
    }
    
    // Format working hours
    let workingHours = "-";
    if (totalWorkingSeconds > 0) {
      const totalMinutes = Math.floor(totalWorkingSeconds / 60);
      const hours = Math.floor(totalMinutes / 60);
      const mins = totalMinutes % 60;
      workingHours = `${hours}h ${mins}m`;
      // Add indicator if still checked in today
      if (isCheckedIn && isToday) {
        workingHours += " (ongoing)";
      }
    }
    
    // Determine last checkout time
    // If even number of punches, last punch is checkout
    // If odd number and today, show "Now" / otherwise show "-"
    let lastPunchTime = "-";
    if (!isCheckedIn) {
      lastPunchTime = filteredRecords[filteredRecords.length - 1]?.time || "-";
    } else if (isToday) {
      lastPunchTime = "Now";
    }
    
    summaries.push({
      user_id: firstRecord.user_id,
      user_name: firstRecord.user_name,
      date: firstRecord.date,
      first_punch: firstRecord.time,
      last_punch: lastPunchTime,
      total_punches: dayRecords.length, // Show actual punch count (including duplicates)
      working_hours: workingHours,
    });
  });
  
  // Sort by date (newest first), then by user
  summaries.sort((a, b) => {
    const dateCompare = b.date.localeCompare(a.date);
    if (dateCompare !== 0) return dateCompare;
    return a.user_name.localeCompare(b.user_name);
  });
  
  return summaries;
}

export default function AttendanceModule() {
  const { logout } = useAuth();
  const [devices, setDevices] = useState<BiometricDevice[]>(() => loadDevicesFromStorage());
  const [scanning, setScanning] = useState(false);
  const [selectedDevices, setSelectedDevices] = useState<BiometricDevice[]>([]);
  const [attendanceData, setAttendanceData] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingProgress, setLoadingProgress] = useState<string>("");
  const [manualIp, setManualIp] = useState("");
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const scanCancelledRef = useRef<boolean>(false);
  
  // Connected device info
  const [connectedDeviceInfo, setConnectedDeviceInfo] = useState<DeviceInfo | null>(null);
  
  // View state: "raw" or "summary"
  const [viewMode, setViewMode] = useState<"raw" | "summary">("summary");

  // ERP Sync state
  const [erpConfig, setErpConfig] = useState<ErpConfig>(() => loadErpConfig());
  const [erpExpanded, setErpExpanded] = useState(false);
  const [erpTesting, setErpTesting] = useState(false);
  const [erpSyncing, setErpSyncing] = useState(false);
  const [erpTestResult, setErpTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [erpSyncResult, setErpSyncResult] = useState<SyncResult | null>(null);

  // Reload ERP config when section is expanded (to pick up changes from login settings)
  useEffect(() => {
    if (erpExpanded) {
      setErpConfig(loadErpConfig());
    }
  }, [erpExpanded]);
  
  // Search and filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [summaryPage, setSummaryPage] = useState(1);
  
  // Save devices to localStorage whenever they change
  useEffect(() => {
    saveDevicesToStorage(devices);
  }, [devices]);
  
  // Reset pagination when filters change
  useEffect(() => {
    setCurrentPage(1);
    setSummaryPage(1);
  }, [searchQuery, dateFrom, dateTo]);
  
  // Calculate summary from raw data
  const dailySummary = useMemo(() => {
    return calculateDailySummary(attendanceData);
  }, [attendanceData]);
  
  // Filter raw data based on search and date
  const filteredRawData = useMemo(() => {
    const filtered = attendanceData.filter(record => {
      // Search filter (by name or user_id)
      const matchesSearch = searchQuery === "" || 
        record.user_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        record.user_id.toString().includes(searchQuery);
      
      // Date filter
      const matchesDateFrom = dateFrom === "" || record.date >= dateFrom;
      const matchesDateTo = dateTo === "" || record.date <= dateTo;
      
      return matchesSearch && matchesDateFrom && matchesDateTo;
    });
    
    // Sort by latest date first, then by time (descending)
    return filtered.sort((a, b) => {
      const dateCompare = b.date.localeCompare(a.date);
      if (dateCompare !== 0) return dateCompare;
      return b.time.localeCompare(a.time);
    });
  }, [attendanceData, searchQuery, dateFrom, dateTo]);
  
  // Filter summary data based on search and date (already sorted by date in calculateDailySummary)
  const filteredSummary = useMemo(() => {
    return dailySummary.filter(record => {
      // Search filter (by name or user_id)
      const matchesSearch = searchQuery === "" || 
        record.user_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        record.user_id.toString().includes(searchQuery);
      
      // Date filter
      const matchesDateFrom = dateFrom === "" || record.date >= dateFrom;
      const matchesDateTo = dateTo === "" || record.date <= dateTo;
      
      return matchesSearch && matchesDateFrom && matchesDateTo;
    });
  }, [dailySummary, searchQuery, dateFrom, dateTo]);
  
  // Paginated raw data (from filtered)
  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * RECORDS_PER_PAGE;
    const endIndex = startIndex + RECORDS_PER_PAGE;
    return filteredRawData.slice(startIndex, endIndex);
  }, [filteredRawData, currentPage]);
  
  // Paginated summary data (from filtered)
  const paginatedSummary = useMemo(() => {
    const startIndex = (summaryPage - 1) * RECORDS_PER_PAGE;
    const endIndex = startIndex + RECORDS_PER_PAGE;
    return filteredSummary.slice(startIndex, endIndex);
  }, [filteredSummary, summaryPage]);
  
  const totalPages = Math.ceil(filteredRawData.length / RECORDS_PER_PAGE);
  const totalSummaryPages = Math.ceil(filteredSummary.length / RECORDS_PER_PAGE);
  
  // Calculate date range from attendance data
  const dateRange = useMemo(() => {
    if (attendanceData.length === 0) return null;
    
    const dates = attendanceData.map(r => r.date).filter(d => d);
    if (dates.length === 0) return null;
    
    const sortedDates = [...new Set(dates)].sort();
    return {
      earliest: sortedDates[0],
      latest: sortedDates[sortedDates.length - 1],
      totalDays: sortedDates.length
    };
  }, [attendanceData]);
  
  // Clear filters
  const clearFilters = () => {
    setSearchQuery("");
    setDateFrom("");
    setDateTo("");
  };

  const scanNetwork = async (): Promise<void> => {
    setScanning(true);
    setError(null);
    scanCancelledRef.current = false;
    
    try {
      const result = await safeInvoke<BiometricDevice[]>("scan_for_devices");
      
      // Only update if scan wasn't cancelled
      if (!scanCancelledRef.current && result.length > 0) {
        // Merge with existing devices - use serial number as unique key (IP can change)
        setDevices(prev => {
          const result_devices = [...prev];
          
          for (const scanned of result) {
            // Find by serial number first (if available), then by IP
            let existingIndex = -1;
            
            if (scanned.serial_number) {
              existingIndex = result_devices.findIndex(d => d.serial_number === scanned.serial_number);
            }
            
            // If not found by serial, try by IP (for devices without serial yet)
            if (existingIndex === -1) {
              existingIndex = result_devices.findIndex(d => d.ip === scanned.ip && !d.serial_number);
            }
            
            if (existingIndex !== -1) {
              // Update existing device (IP might have changed)
              const existing = result_devices[existingIndex]!;
              result_devices[existingIndex] = {
                ...existing,
                ip: scanned.ip, // Update IP (might have changed)
                mac: scanned.mac || existing.mac,
                device_name: scanned.device_name || existing.device_name,
                firmware_version: scanned.firmware_version || existing.firmware_version,
                serial_number: scanned.serial_number || existing.serial_number,
                open_ports: scanned.open_ports,
              };
            } else {
              // Add new device
              result_devices.push(scanned);
            }
          }
          
          return result_devices;
        });
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
  
  // Add device manually by IP
  const addDeviceManually = (): void => {
    const ip = manualIp.trim();
    if (!ip) {
      setError("Please enter an IP address");
      return;
    }
    
    // Validate IP format
    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ip)) {
      setError("Invalid IP address format");
      return;
    }
    
    // Check if already exists
    if (devices.some(d => d.ip === ip)) {
      setError("Device already exists");
      return;
    }
    
    // Add device with default port
    const newDevice: BiometricDevice = {
      ip,
      mac: "Manual",
      open_ports: [4370],
    };
    
    setDevices(prev => [...prev, newDevice]);
    setManualIp("");
    setError(null);
  };
  
  // Remove a device from the list
  const removeDevice = (device: BiometricDevice): void => {
    setDevices(prev => prev.filter(d => {
      if (device.serial_number && d.serial_number) {
        return d.serial_number !== device.serial_number;
      }
      return d.ip !== device.ip;
    }));
    
    // Also remove from selection if selected
    setSelectedDevices(prev => prev.filter(d => {
      if (device.serial_number && d.serial_number) {
        return d.serial_number !== device.serial_number;
      }
      return d.ip !== device.ip;
    }));
  };

  // Get device ID for editing (serial number or IP)
  const getDeviceId = (device: BiometricDevice): string => {
    return device.serial_number || device.ip;
  };

  // Start editing device name
  const startEditingName = (device: BiometricDevice, e: React.MouseEvent): void => {
    e.stopPropagation();
    setEditingDeviceId(getDeviceId(device));
    setEditingName(device.custom_name || device.device_name || "");
  };

  // Save custom name
  const saveCustomName = (device: BiometricDevice): void => {
    const trimmedName = editingName.trim();
    setDevices(prev => prev.map(d => {
      const isSame = device.serial_number && d.serial_number 
        ? d.serial_number === device.serial_number 
        : d.ip === device.ip;
      return isSame ? { ...d, custom_name: trimmedName || undefined } : d;
    }));
    setEditingDeviceId(null);
    setEditingName("");
  };

  // Cancel editing
  const cancelEditing = (): void => {
    setEditingDeviceId(null);
    setEditingName("");
  };
  
  // Helper to check if device is selected
  const isDeviceSelected = (device: BiometricDevice): boolean => {
    return selectedDevices.some(d => 
      device.serial_number && d.serial_number 
        ? d.serial_number === device.serial_number 
        : d.ip === device.ip
    );
  };

  // Toggle device selection (click to select/deselect)
  const toggleDeviceSelection = (device: BiometricDevice): void => {
    setError(null);
    
    if (isDeviceSelected(device)) {
      // Deselect
      setSelectedDevices(prev => prev.filter(d => 
        device.serial_number && d.serial_number 
          ? d.serial_number !== device.serial_number 
          : d.ip !== device.ip
      ));
    } else {
      // Select (add to selection)
      setSelectedDevices(prev => [...prev, device]);
    }
    
    // Reset pagination
    setCurrentPage(1);
    setSummaryPage(1);
  };

  // Load attendance data for all selected devices
  const loadSelectedDevicesData = (): void => {
    const allData: AttendanceRecord[] = [];
    for (const device of selectedDevices) {
      const deviceData = loadAttendanceFromStorage(device);
      allData.push(...deviceData);
    }
    setAttendanceData(allData);
  };

  // Effect to load data when selection changes
  useEffect(() => {
    loadSelectedDevicesData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevices]);

  // Sync (fetch attendance) from all selected devices
  const syncDevices = async (): Promise<void> => {
    if (selectedDevices.length === 0) {
      setError("Please select at least one device");
      return;
    }
    
    setLoading(true);
    setError(null);
    setCurrentPage(1);
    setSummaryPage(1);
    setConnectedDeviceInfo(null);
    
    const allRecords: AttendanceRecord[] = [];
    const errors: string[] = [];
    let lastDeviceInfo: DeviceInfo | null = null;
    
    for (const device of selectedDevices) {
      const deviceIndex = selectedDevices.indexOf(device);
      setLoadingProgress(`Syncing device ${deviceIndex + 1}/${selectedDevices.length}: ${device.serial_number || device.ip}...`);
      
      const port: number = device.open_ports.includes(4370) 
        ? 4370 
        : device.open_ports[0] ?? 4370;
      
      try {
        const result = await safeInvoke<AttendanceResponse>("fetch_attendance", {
          ip: device.ip,
          port: port,
        });
        
        // Store last device info (or could show all)
        lastDeviceInfo = result.device_info;
        
        const deviceIp = device.ip;
        const deviceSerial = device.serial_number;
        
        // Update device in list with device info
        setDevices(prev => prev.map(d => {
          const isSame = deviceSerial && d.serial_number 
            ? d.serial_number === deviceSerial 
            : d.ip === deviceIp;
          return isSame 
            ? {
                ...d,
                device_name: result.device_info.device_name || d.device_name,
                firmware_version: result.device_info.firmware_version || d.firmware_version,
                serial_number: result.device_info.serial_number || d.serial_number,
                last_synced: new Date().toISOString(),
              }
            : d;
        }));
        
        // Also update selectedDevices with new serial number
        setSelectedDevices(prev => prev.map(d => {
          const isSame = deviceSerial && d.serial_number 
            ? d.serial_number === deviceSerial 
            : d.ip === deviceIp;
          return isSame 
            ? { ...d, serial_number: result.device_info.serial_number || d.serial_number }
            : d;
        }));
        
        // Save to storage
        const updatedDevice: BiometricDevice = { 
          ...device, 
          serial_number: result.device_info.serial_number || device.serial_number 
        };
        saveAttendanceToStorage(updatedDevice, result.records);
        
        // Add to combined records
        allRecords.push(...result.records);
        
      } catch (err: unknown) {
        const errorMessage: string = err instanceof Error 
          ? err.message 
          : typeof err === 'string' 
          ? err 
          : 'Unknown error occurred';
        errors.push(`${device.serial_number || device.ip}: ${errorMessage}`);
        console.error("Fetch error for device:", device.ip, err);
      }
    }
    
    setLoadingProgress(`Processing ${allRecords.length} total records...`);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    setAttendanceData(allRecords);
    setConnectedDeviceInfo(lastDeviceInfo);
    
    if (errors.length > 0) {
      setError(`Errors: ${errors.join("; ")}`);
    }
    
    setLoading(false);
    setLoadingProgress("");
  };

  // Helper function to download CSV using Tauri native dialog
  const downloadCSV = async (content: string, defaultFilename: string): Promise<void> => {
    try {
      const filePath = await save({
        defaultPath: defaultFilename,
        filters: [{ name: "CSV Files", extensions: ["csv"] }],
      });
      
      if (filePath) {
        // Add BOM for Excel compatibility
        await writeTextFile(filePath, "\uFEFF" + content);
        alert(`File saved: ${filePath}`);
      }
    } catch (err) {
      console.error("Failed to save file:", err);
      alert("Failed to save file: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  // Export raw attendance data to CSV (filtered data)
  const exportRawToCSV = async (): Promise<void> => {
    if (filteredRawData.length === 0) {
      alert("No data to export");
      return;
    }

    const headers = ["User ID", "User Name", "Date", "Time", "Status", "Punch", "Timestamp"];
    const rows = filteredRawData.map((record) => [
      record.user_id.toString(),
      record.user_name.replace(/"/g, '""'),
      record.date,
      record.time,
      record.status.toString(),
      record.punch.toString(),
      record.timestamp,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
    ].join("\n");

    const firstDevice = selectedDevices[0];
    const deviceLabel = selectedDevices.length === 1 && firstDevice
      ? (firstDevice.serial_number || firstDevice.ip) 
      : selectedDevices.length > 1 ? `${selectedDevices.length}_devices` : 'export';
    const filename = `attendance_raw_${deviceLabel}_${new Date().toISOString().split("T")[0]}.csv`;
    await downloadCSV(csvContent, filename);
  };
  
  // Export daily summary to CSV (filtered data)
  const exportSummaryToCSV = async (): Promise<void> => {
    if (filteredSummary.length === 0) {
      alert("No data to export");
      return;
    }

    const headers = ["User ID", "User Name", "Date", "Check In", "Check Out", "Total Punches", "Working Hours"];
    const rows = filteredSummary.map((record) => [
      record.user_id.toString(),
      record.user_name.replace(/"/g, '""'),
      record.date,
      record.first_punch,
      record.last_punch,
      record.total_punches.toString(),
      record.working_hours,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(",")),
    ].join("\n");

    const firstDevice = selectedDevices[0];
    const deviceLabel = selectedDevices.length === 1 && firstDevice
      ? (firstDevice.serial_number || firstDevice.ip)
      : selectedDevices.length > 1 ? `${selectedDevices.length}_devices` : 'export';
    const filename = `attendance_summary_${deviceLabel}_${new Date().toISOString().split("T")[0]}.csv`;
    await downloadCSV(csvContent, filename);
  };

  // ERP: Test connection
  const testErpConnection = async () => {
    if (!erpConfig.api_key) {
      setErpTestResult({ success: false, message: "Please enter API Key" });
      return;
    }

    setErpTesting(true);
    setErpTestResult(null);

    try {
      const result = await safeInvoke<string>("erp_test_connection", {
        config: erpConfig,
      });
      setErpTestResult({ success: true, message: result });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Check for AUTH_ERROR - API key revoked or invalid
      if (errorMessage.startsWith("AUTH_ERROR:")) {
        logout();
        return;
      }
      setErpTestResult({ success: false, message: errorMessage });
    } finally {
      setErpTesting(false);
    }
  };

  // ERP: Sync attendance data
  const syncToErp = async () => {
    if (!erpConfig.api_key) {
      setErpSyncResult({ success: false, synced_count: 0, skipped_count: 0, failed_count: 0, errors: ["Please enter API Key first"] });
      return;
    }

    if (filteredSummary.length === 0) {
      setErpSyncResult({ success: false, synced_count: 0, skipped_count: 0, failed_count: 0, errors: ["No attendance data to sync"] });
      return;
    }

    setErpSyncing(true);
    setErpSyncResult(null);

    try {
      // Transform daily summary to ERP payload format
      const records: FacultyAttendancePayload[] = filteredSummary.map(summary => ({
        faculty: summary.user_id,
        date: summary.date,
        check_in_time: summary.first_punch !== "-" ? summary.first_punch : null,
        check_out_time: summary.last_punch !== "-" && summary.last_punch !== "Now" ? summary.last_punch : null,
        is_present: true,
        notes: `Synced from biometric device. Punches: ${summary.total_punches}`,
      }));

      const result = await safeInvoke<SyncResult>("erp_sync_attendance", {
        request: {
          config: erpConfig,
          records: records,
        },
      });

      setErpSyncResult(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      // Check for AUTH_ERROR - API key revoked or invalid
      if (errorMessage.startsWith("AUTH_ERROR:")) {
        logout();
        return;
      }
      setErpSyncResult({ success: false, synced_count: 0, skipped_count: 0, failed_count: 0, errors: [errorMessage] });
    } finally {
      setErpSyncing(false);
    }
  };


  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h2 className="text-2xl font-bold text-gray-800">Attendance Management</h2>
        <p className="text-sm text-gray-600 mt-1">Manage biometric devices and fetch attendance data</p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 space-y-6">
        
        {/* Devices Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              <h3 className="text-lg font-semibold text-gray-800">Biometric Devices</h3>
              <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">
                {devices.length} device{devices.length !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {scanning ? (
                <button
                  onClick={stopScan}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2 text-sm"
                  type="button"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  Stop
                </button>
              ) : (
                <button
                  onClick={scanNetwork}
                  className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors flex items-center gap-2 text-sm"
                  type="button"
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
                  <span>Scanning...</span>
                </div>
              )}
            </div>
            
            {/* Manual IP Add */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={manualIp}
                onChange={(e) => setManualIp(e.target.value)}
                placeholder="Enter IP (e.g., 192.168.1.201)"
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 w-48"
                onKeyDown={(e) => e.key === 'Enter' && addDeviceManually()}
              />
              <button
                onClick={addDeviceManually}
                className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm"
                type="button"
              >
                + Add
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span>{error}</span>
              </div>
            </div>
          )}

          {/* Device Cards */}
          {devices.length === 0 ? (
            <div className="text-center py-8 text-gray-500">
              <svg className="w-12 h-12 mx-auto mb-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              <p className="font-medium">No devices found</p>
              <p className="text-sm mt-1">Click "Scan Network" to discover biometric devices</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {devices.map((device) => {
                const deviceKey = device.serial_number || device.ip;
                const isSelected = isDeviceSelected(device);
                return (
                  <div
                    key={deviceKey}
                    onClick={() => toggleDeviceSelection(device)}
                    className={`relative p-4 rounded-lg border-2 cursor-pointer transition-all ${
                      isSelected
                        ? "border-primary-500 bg-primary-50"
                        : "border-gray-200 hover:border-gray-300 bg-white"
                    }`}
                  >
                    {/* Remove button */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeDevice(device);
                      }}
                      className="absolute top-2 right-2 p-1 text-gray-400 hover:text-red-500 transition-colors"
                      title="Remove device"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                    
                    <div className="flex items-start gap-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                        isSelected ? "bg-primary-500 text-white" : "bg-gray-100 text-gray-600"
                      }`}>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        {/* Custom name as header (editable) */}
                        {editingDeviceId === getDeviceId(device) ? (
                          <div className="flex items-center gap-1 mb-1" onClick={e => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveCustomName(device);
                                if (e.key === "Escape") cancelEditing();
                              }}
                              className="flex-1 px-2 py-1 text-sm font-semibold border border-primary-300 rounded focus:outline-none focus:ring-1 focus:ring-primary-500"
                              placeholder="Enter device name..."
                              autoFocus
                            />
                            <button
                              onClick={() => saveCustomName(device)}
                              className="p-1 text-green-600 hover:text-green-700"
                              title="Save"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            </button>
                            <button
                              onClick={cancelEditing}
                              className="p-1 text-gray-400 hover:text-gray-600"
                              title="Cancel"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 group">
                            <p className="font-semibold text-gray-900 truncate">
                              {device.custom_name || device.device_name || "Unnamed Device"}
                            </p>
                            <button
                              onClick={(e) => startEditingName(device, e)}
                              className="p-0.5 text-gray-300 hover:text-primary-500 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Edit name"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                          </div>
                        )}
                        {/* Device model from device (smaller) */}
                        {device.device_name && device.custom_name && (
                          <p className="text-xs text-gray-400">{device.device_name}</p>
                        )}
                        {/* Serial number as primary ID */}
                        {device.serial_number ? (
                          <p className="text-sm font-mono text-primary-600">{device.serial_number}</p>
                        ) : (
                          <p className="text-xs text-gray-400 italic">No serial number</p>
                        )}
                        {/* IP address as secondary info */}
                        <p className="text-xs text-gray-500">IP: {device.ip}</p>
                        {device.firmware_version && (
                          <p className="text-xs text-gray-400">FW: {device.firmware_version}</p>
                        )}
                        <p className="text-xs text-gray-400">Port: {device.open_ports.join(", ")}</p>
                      </div>
                    </div>
                    
                    {/* Last synced info */}
                    {device.last_synced && (
                      <div className="mt-2 text-xs text-gray-400">
                        Last sync: {new Date(device.last_synced).toLocaleDateString()} {new Date(device.last_synced).toLocaleTimeString()}
                      </div>
                    )}
                    
                    {isSelected && (
                      <div className="mt-2 pt-2 border-t border-primary-200">
                        <span className="text-xs font-medium text-primary-600">✓ Selected</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          
          {/* Sync Button */}
          {selectedDevices.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                Selected: <span className="font-medium text-primary-600">{selectedDevices.length} device{selectedDevices.length !== 1 ? 's' : ''}</span>
                {selectedDevices.length <= 3 && (
                  <span className="text-gray-400 ml-2">
                    ({selectedDevices.map(d => d.serial_number || d.ip).join(", ")})
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedDevices([])}
                  className="px-3 py-2 text-gray-600 hover:text-gray-800 transition-colors text-sm"
                  type="button"
                >
                  Clear Selection
                </button>
                <button
                  onClick={syncDevices}
                  disabled={loading}
                  className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                  type="button"
                >
                  {loading ? (
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
                      Sync Attendance
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Connected Device Info */}
        {connectedDeviceInfo && (
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg border border-green-200 p-4 mb-6">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-green-800">✅ Connected to device</h4>
                  {dateRange && (
                    <span className="inline-flex items-center px-3 py-1 rounded-full bg-blue-100 text-blue-800 text-sm font-semibold">
                      📅 Latest: {dateRange.latest}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-green-600">📟</span>
                    <span className="text-gray-600">Device Name:</span>
                    <span className="font-medium text-gray-800">{connectedDeviceInfo.device_name || "Unknown"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-green-600">📟</span>
                    <span className="text-gray-600">Firmware:</span>
                    <span className="font-medium text-gray-800">{connectedDeviceInfo.firmware_version || "Unknown"}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-green-600">📟</span>
                    <span className="text-gray-600">Serial:</span>
                    <span className="font-medium text-gray-800">{connectedDeviceInfo.serial_number || "Unknown"}</span>
                  </div>
                  {connectedDeviceInfo.platform && (
                    <div className="flex items-center gap-2">
                      <span className="text-green-600">🖥️</span>
                      <span className="text-gray-600">Platform:</span>
                      <span className="font-medium text-gray-800">{connectedDeviceInfo.platform}</span>
                    </div>
                  )}
                  {connectedDeviceInfo.mac_address && (
                    <div className="flex items-center gap-2">
                      <span className="text-green-600">🔗</span>
                      <span className="text-gray-600">MAC:</span>
                      <span className="font-medium text-gray-800">{connectedDeviceInfo.mac_address}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Attendance Data Section */}
        {(selectedDevices.length > 0 || attendanceData.length > 0) && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-800">Attendance Data</h3>
                {selectedDevices.length > 0 && (
                  <div className="text-sm text-gray-600 mt-1 space-y-1">
                    <p>
                      {selectedDevices.length === 1 && selectedDevices[0] ? (
                        <>Device: <span className="font-mono text-primary-600">{selectedDevices[0].serial_number || selectedDevices[0].ip}</span></>
                      ) : (
                        <>{selectedDevices.length} devices selected</>
                      )}
                      {" | "}Raw Records: {attendanceData.length.toLocaleString()} | Daily Summary: {dailySummary.length.toLocaleString()}
                    </p>
                    {dateRange && (
                      <p className="flex items-center gap-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-xs font-medium">
                          📅 Latest: {dateRange.latest}
                        </span>
                        <span className="text-gray-400">|</span>
                        <span className="text-xs text-gray-500">
                          Earliest: {dateRange.earliest} • {dateRange.totalDays} days
                        </span>
                      </p>
                    )}
                  </div>
                )}
              </div>
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
                {/* Tab Navigation */}
                <div className="mb-4 border-b border-gray-200">
                  <nav className="flex gap-4">
                    <button
                      onClick={() => { setViewMode("summary"); setSummaryPage(1); }}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        viewMode === "summary"
                          ? "border-primary-600 text-primary-600"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      Daily Summary ({filteredSummary.length.toLocaleString()})
                    </button>
                    <button
                      onClick={() => { setViewMode("raw"); setCurrentPage(1); }}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                        viewMode === "raw"
                          ? "border-primary-600 text-primary-600"
                          : "border-transparent text-gray-500 hover:text-gray-700"
                      }`}
                    >
                      Raw Data ({filteredRawData.length.toLocaleString()})
                    </button>
                  </nav>
                </div>
                
                {/* Search and Filter Section */}
                <div className="mb-4 p-4 bg-gray-50 rounded-lg">
                  <div className="flex flex-wrap gap-4 items-end">
                    {/* Search Employee */}
                    <div className="flex-1 min-w-[200px]">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Search Employee</label>
                      <div className="relative">
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Name or ID..."
                          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                        />
                        <svg className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                        </svg>
                      </div>
                    </div>
                    
                    {/* Date From */}
                    <div className="w-40">
                      <label className="block text-xs font-medium text-gray-600 mb-1">From Date</label>
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                      />
                    </div>
                    
                    {/* Date To */}
                    <div className="w-40">
                      <label className="block text-xs font-medium text-gray-600 mb-1">To Date</label>
                      <input
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                      />
                    </div>
                    
                    {/* Clear Filters */}
                    {(searchQuery || dateFrom || dateTo) && (
                      <button
                        onClick={clearFilters}
                        className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-200 rounded-lg transition-colors flex items-center gap-1"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                        Clear
                      </button>
                    )}
                  </div>
                  
                  {/* Filter Summary */}
                  {(searchQuery || dateFrom || dateTo) && (
                    <div className="mt-3 pt-3 border-t border-gray-200 text-xs text-gray-500">
                      Showing {viewMode === "summary" ? filteredSummary.length.toLocaleString() : filteredRawData.length.toLocaleString()} of {viewMode === "summary" ? dailySummary.length.toLocaleString() : attendanceData.length.toLocaleString()} records
                      {searchQuery && <span className="ml-2">• Search: "{searchQuery}"</span>}
                      {dateFrom && <span className="ml-2">• From: {dateFrom}</span>}
                      {dateTo && <span className="ml-2">• To: {dateTo}</span>}
                    </div>
                  )}
                </div>
                
                {/* Download Buttons */}
                <div className="mb-4 p-4 bg-white border border-gray-200 rounded-lg flex flex-wrap gap-3 items-center">
                  <span className="text-sm font-medium text-gray-700">Download:</span>
                  <button
                    onClick={exportSummaryToCSV}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 text-sm"
                    type="button"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Summary CSV
                  </button>
                  <button
                    onClick={exportRawToCSV}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2 text-sm"
                    type="button"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Raw Data CSV
                  </button>
                </div>

                {/* ERP Sync Section */}
                <div className="mb-4 border border-purple-200 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setErpExpanded(!erpExpanded)}
                    className="w-full px-4 py-3 bg-gradient-to-r from-purple-50 to-indigo-50 flex items-center justify-between hover:from-purple-100 hover:to-indigo-100 transition-colors"
                    type="button"
                  >
                    <div className="flex items-center gap-2">
                      <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                      </svg>
                      <span className="font-medium text-purple-800">Sync to ERP</span>
                      <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full">
                        {(erpConfig.api_url || "https://api.alagappa.org").replace(/^https?:\/\//, '')}
                      </span>
                    </div>
                    <svg
                      className={`w-5 h-5 text-purple-600 transition-transform ${erpExpanded ? "rotate-180" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {erpExpanded && (
                    <div className="p-4 bg-white border-t border-purple-100">
                      {/* ERP Configuration */}
                      <div className="mb-4">
                        <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
                          <span className="font-medium">Server:</span> {erpConfig.api_url || "https://api.alagappa.org"}
                          <span className="mx-2">|</span>
                          <span className="font-medium">Using login API key</span>
                        </div>
                      </div>

                      {/* Test Result */}
                      {erpTestResult && (
                        <div className={`mb-4 p-3 rounded-lg text-sm ${erpTestResult.success ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
                          {erpTestResult.success ? "✓ " : "✗ "}{erpTestResult.message}
                        </div>
                      )}

                      {/* Sync Result */}
                      {erpSyncResult && (
                        <div className={`mb-4 p-3 rounded-lg text-sm ${erpSyncResult.success ? "bg-green-50 border border-green-200" : "bg-yellow-50 border border-yellow-200"}`}>
                          <div className="flex items-center gap-3 mb-2">
                            <span className={erpSyncResult.success ? "text-green-700" : "text-yellow-700"}>
                              {erpSyncResult.success ? "✓ Sync completed" : "⚠ Sync completed with errors"}
                            </span>
                          </div>
                          <div className="flex gap-4 text-xs">
                            <span className="text-green-600">Synced: {erpSyncResult.synced_count}</span>
                            {erpSyncResult.skipped_count > 0 && (
                              <span className="text-yellow-600">Skipped: {erpSyncResult.skipped_count}</span>
                            )}
                            {erpSyncResult.failed_count > 0 && (
                              <span className="text-red-600">Failed: {erpSyncResult.failed_count}</span>
                            )}
                          </div>
                          {erpSyncResult.errors.length > 0 && (
                            <div className="mt-2 text-xs text-red-600 max-h-24 overflow-y-auto">
                              {erpSyncResult.errors.slice(0, 5).map((err, i) => (
                                <div key={i}>{err}</div>
                              ))}
                              {erpSyncResult.errors.length > 5 && (
                                <div className="text-gray-500">... and {erpSyncResult.errors.length - 5} more errors</div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Action Buttons */}
                      <div className="flex items-center gap-3">
                        <button
                          onClick={testErpConnection}
                          disabled={erpTesting || !erpConfig.api_key}
                          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2 text-sm"
                          type="button"
                        >
                          {erpTesting ? (
                            <>
                              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                              Testing...
                            </>
                          ) : (
                            <>
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              Test Connection
                            </>
                          )}
                        </button>

                        <button
                          onClick={syncToErp}
                          disabled={erpSyncing || !erpConfig.api_key || filteredSummary.length === 0}
                          className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2 text-sm"
                          type="button"
                        >
                          {erpSyncing ? (
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
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                              </svg>
                              Sync {filteredSummary.length} Records to ERP
                            </>
                          )}
                        </button>
                      </div>

                      <p className="mt-3 text-xs text-gray-500">
                        Syncs the filtered daily summary data to your ERP system. User IDs are mapped to faculty IDs.
                      </p>
                    </div>
                  )}
                </div>
                
                {/* SUMMARY VIEW */}
                {viewMode === "summary" && (
                  <>
                    <div className="mb-2 text-xs text-gray-500">
                      Showing {filteredSummary.length > 0 ? ((summaryPage - 1) * RECORDS_PER_PAGE) + 1 : 0} - {Math.min(summaryPage * RECORDS_PER_PAGE, filteredSummary.length)} of {filteredSummary.length.toLocaleString()} daily records
                    </div>
                    
                    {/* Pagination */}
                    {totalSummaryPages > 1 && (
                      <div className="mb-4 flex items-center gap-2">
                        <button onClick={() => setSummaryPage(1)} disabled={summaryPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50">First</button>
                        <button onClick={() => setSummaryPage(p => Math.max(1, p - 1))} disabled={summaryPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50">Prev</button>
                        <span className="px-3 py-1 text-sm">Page {summaryPage} of {totalSummaryPages}</span>
                        <button onClick={() => setSummaryPage(p => Math.min(totalSummaryPages, p + 1))} disabled={summaryPage === totalSummaryPages} className="px-3 py-1 text-sm border rounded disabled:opacity-50">Next</button>
                        <button onClick={() => setSummaryPage(totalSummaryPages)} disabled={summaryPage === totalSummaryPages} className="px-3 py-1 text-sm border rounded disabled:opacity-50">Last</button>
                      </div>
                    )}
                    
                    <div className="overflow-x-auto border border-gray-200 rounded-lg">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">User ID</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">User Name</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Check In</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Check Out</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Punches</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Hours</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {paginatedSummary.map((record, idx) => (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm text-gray-400">{((summaryPage - 1) * RECORDS_PER_PAGE) + idx + 1}</td>
                              <td className="px-4 py-3 text-sm text-gray-900">{record.user_id}</td>
                              <td className="px-4 py-3 text-sm text-gray-900">{record.user_name}</td>
                              <td className="px-4 py-3 text-sm text-gray-500">{record.date}</td>
                              <td className="px-4 py-3 text-sm">
                                <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">
                                  {record.first_punch}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-sm">
                                <span className="px-2 py-1 text-xs font-medium rounded-full bg-red-100 text-red-800">
                                  {record.last_punch}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-500">{record.total_punches}</td>
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">{record.working_hours}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                
                {/* RAW DATA VIEW */}
                {viewMode === "raw" && (
                  <>
                    <div className="mb-2 text-xs text-gray-500">
                      Showing {filteredRawData.length > 0 ? ((currentPage - 1) * RECORDS_PER_PAGE) + 1 : 0} - {Math.min(currentPage * RECORDS_PER_PAGE, filteredRawData.length)} of {filteredRawData.length.toLocaleString()} raw records
                    </div>
                    
                    {/* Pagination */}
                    {totalPages > 1 && (
                      <div className="mb-4 flex items-center gap-2">
                        <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50">First</button>
                        <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 text-sm border rounded disabled:opacity-50">Prev</button>
                        <span className="px-3 py-1 text-sm">Page {currentPage} of {totalPages}</span>
                        <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-3 py-1 text-sm border rounded disabled:opacity-50">Next</button>
                        <button onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className="px-3 py-1 text-sm border rounded disabled:opacity-50">Last</button>
                      </div>
                    )}
                    
                    <div className="overflow-x-auto border border-gray-200 rounded-lg">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">#</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">User ID</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">User Name</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Punch</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {paginatedData.map((record, idx) => (
                            <tr key={idx} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-sm text-gray-400">{((currentPage - 1) * RECORDS_PER_PAGE) + idx + 1}</td>
                              <td className="px-4 py-3 text-sm text-gray-900">{record.user_id}</td>
                              <td className="px-4 py-3 text-sm text-gray-900">{record.user_name}</td>
                              <td className="px-4 py-3 text-sm text-gray-500">{record.date}</td>
                              <td className="px-4 py-3 text-sm text-gray-500">{record.time}</td>
                              <td className="px-4 py-3 text-sm text-gray-500">{record.status}</td>
                              <td className="px-4 py-3 text-sm text-gray-500">{record.punch}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
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

