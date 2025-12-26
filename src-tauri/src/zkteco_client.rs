use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;
use chrono::{DateTime, Local, TimeZone};
use log::{debug, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttendanceRecord {
    pub user_id: u32,
    pub user_name: String,
    pub timestamp: String,  // ISO format for sorting
    pub status: u8,         // Raw status from device
    pub punch: u8,          // Raw punch from device
    pub date: String,       // YYYY-MM-DD
    pub time: String,       // HH:MM:SS
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub device_name: String,
    pub firmware_version: String,
    pub serial_number: String,
    pub platform: String,
    pub mac_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttendanceResponse {
    pub device_info: DeviceInfo,
    pub records: Vec<AttendanceRecord>,
}

#[derive(Debug, Clone)]
struct User {
    uid: u32,
    user_id: String,
    name: String,
}

// ZKTeco protocol constants (from pyzk const.py)
const USHRT_MAX: u16 = 65535;

const CMD_CONNECT: u16 = 1000;
const CMD_EXIT: u16 = 1001;
const CMD_ENABLEDEVICE: u16 = 1002;
const CMD_DISABLEDEVICE: u16 = 1003;
const CMD_USERTEMP_RRQ: u16 = 9;
const CMD_ATTLOG_RRQ: u16 = 13;
const CMD_PREPARE_DATA: u16 = 1500;
const CMD_DATA: u16 = 1501;
const CMD_FREE_DATA: u16 = 1502;
const CMD_ACK_OK: u16 = 2000;
#[allow(dead_code)]
const CMD_ACK_ERROR: u16 = 2001;
#[allow(dead_code)]
const CMD_ACK_DATA: u16 = 2002;
const CMD_ACK_UNAUTH: u16 = 2005;
const CMD_AUTH: u16 = 1102;
const CMD_GET_FREE_SIZES: u16 = 50;
const CMD_DATA_WRRQ: u16 = 1503;  // Buffered data request
const CMD_DATA_RDY: u16 = 1504;   // Read chunk
const CMD_OPTIONS_RRQ: u16 = 11;  // Get option value
const CMD_VERSION: u16 = 1100;    // Get firmware version
const CMD_SERIALNUMBER: u16 = 1101; // Get serial number (alternative)

// TCP header constants (from pyzk)
const MACHINE_PREPARE_DATA_1: u16 = 20560; // 0x5050
const MACHINE_PREPARE_DATA_2: u16 = 32130; // 0x7D82 (pyzk const.py has wrong comment 0x7282)

// FCT constants from pyzk const.py
#[allow(dead_code)]
const FCT_ATTLOG: i32 = 1;
#[allow(dead_code)]
const FCT_USER: i32 = 5;

struct ZKClient {
    stream: TcpStream,
    session_id: u16,
    reply_id: u16,
}

impl ZKClient {
    fn connect(ip: &str, port: u16) -> Result<Self, String> {
        info!("Connecting to {}:{}...", ip, port);
        let addr = format!("{}:{}", ip, port);
        
        let stream = TcpStream::connect_timeout(
            &addr.parse().map_err(|e| format!("Invalid address: {}", e))?,
            Duration::from_secs(10)
        ).map_err(|e| format!("Failed to connect to {}: {}", addr, e))?;
        
        stream.set_read_timeout(Some(Duration::from_secs(30)))
            .map_err(|e| format!("Failed to set read timeout: {}", e))?;
        
        stream.set_write_timeout(Some(Duration::from_secs(30)))
            .map_err(|e| format!("Failed to set write timeout: {}", e))?;
        
        let mut client = ZKClient {
            stream,
            session_id: 0,
            reply_id: USHRT_MAX - 1,
        };
        
        client.do_handshake()?;
        
        Ok(client)
    }
    
    /// Calculate checksum (matching pyzk __create_checksum exactly)
    fn calc_checksum(data: &[u8]) -> u16 {
        let mut checksum: i32 = 0;
        let mut i = 0;
        
        while i + 1 < data.len() {
            let val = u16::from_le_bytes([data[i], data[i + 1]]) as i32;
            checksum += val;
            if checksum > USHRT_MAX as i32 {
                checksum -= USHRT_MAX as i32;
            }
            i += 2;
        }
        
        // Handle odd byte
        if i < data.len() {
            checksum += data[i] as i32;
        }
        
        while checksum > USHRT_MAX as i32 {
            checksum -= USHRT_MAX as i32;
        }
        
        // Bitwise NOT (Python style)
        checksum = !checksum;
        
        while checksum < 0 {
            checksum += USHRT_MAX as i32;
        }
        
        checksum as u16
    }
    
    /// Create packet header (matching pyzk __create_header)
    fn create_header(&self, command: u16, command_string: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&command.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&self.session_id.to_le_bytes());
        buf.extend_from_slice(&self.reply_id.to_le_bytes());
        buf.extend_from_slice(command_string);
        
        let checksum = Self::calc_checksum(&buf);
        
        let mut next_reply_id = self.reply_id.wrapping_add(1);
        if next_reply_id >= USHRT_MAX {
            next_reply_id = next_reply_id.wrapping_sub(USHRT_MAX);
        }
        
        let mut result = Vec::new();
        result.extend_from_slice(&command.to_le_bytes());
        result.extend_from_slice(&checksum.to_le_bytes());
        result.extend_from_slice(&self.session_id.to_le_bytes());
        result.extend_from_slice(&next_reply_id.to_le_bytes());
        result.extend_from_slice(command_string);
        
        result
    }
    
    /// Create TCP top header
    fn create_tcp_top(&self, packet: &[u8]) -> Vec<u8> {
        let length = packet.len() as u32;
        let mut top = Vec::new();
        top.extend_from_slice(&MACHINE_PREPARE_DATA_1.to_le_bytes());
        top.extend_from_slice(&MACHINE_PREPARE_DATA_2.to_le_bytes());
        top.extend_from_slice(&length.to_le_bytes());
        top.extend_from_slice(packet);
        top
    }
    
    /// Send command and receive response
    fn send_command(&mut self, command: u16, command_string: &[u8]) -> Result<(u16, Vec<u8>), String> {
        let buf = self.create_header(command, command_string);
        let top = self.create_tcp_top(&buf);
        
        self.stream.write_all(&top)
            .map_err(|e| format!("Failed to send: {}", e))?;
        self.stream.flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        
        let mut tcp_header = [0u8; 8];
        self.stream.read_exact(&mut tcp_header)
            .map_err(|e| format!("Failed to read TCP header: {}", e))?;
        
        let h1 = u16::from_le_bytes([tcp_header[0], tcp_header[1]]);
        let h2 = u16::from_le_bytes([tcp_header[2], tcp_header[3]]);
        if h1 != MACHINE_PREPARE_DATA_1 || h2 != MACHINE_PREPARE_DATA_2 {
            return Err(format!("Invalid TCP header: {:02X?}", tcp_header));
        }
        
        let tcp_length = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
        
        let mut data = vec![0u8; tcp_length];
        self.stream.read_exact(&mut data)
            .map_err(|e| format!("Failed to read packet data: {}", e))?;
        
        if data.len() < 8 {
            return Err(format!("Response too short: {} bytes", data.len()));
        }
        
        let response_cmd = u16::from_le_bytes([data[0], data[1]]);
        let response_session = u16::from_le_bytes([data[4], data[5]]);
        let response_reply_id = u16::from_le_bytes([data[6], data[7]]);
        
        if response_session != 0 {
            self.session_id = response_session;
        }
        self.reply_id = response_reply_id;
        
        let response_data = if data.len() > 8 { data[8..].to_vec() } else { Vec::new() };
        
        
        Ok((response_cmd, response_data))
    }

    /// Receive one TCP-framed ZK packet (for draining follow-up packets)
    fn recv_packet(&mut self) -> Result<(u16, Vec<u8>), String> {
        let mut tcp_header = [0u8; 8];
        self.stream.read_exact(&mut tcp_header)
            .map_err(|e| format!("Failed to read TCP header: {}", e))?;

        let h1 = u16::from_le_bytes([tcp_header[0], tcp_header[1]]);
        let h2 = u16::from_le_bytes([tcp_header[2], tcp_header[3]]);
        if h1 != MACHINE_PREPARE_DATA_1 || h2 != MACHINE_PREPARE_DATA_2 {
            return Err(format!("Invalid TCP header: {:02X?}", tcp_header));
        }

        let tcp_length = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
        if tcp_length < 8 {
            return Err(format!("Invalid tcp_length: {}", tcp_length));
        }

        let mut data = vec![0u8; tcp_length];
        self.stream.read_exact(&mut data)
            .map_err(|e| format!("Failed to read packet data: {}", e))?;

        let response_cmd = u16::from_le_bytes([data[0], data[1]]);
        let response_session = u16::from_le_bytes([data[4], data[5]]);
        let response_reply_id = u16::from_le_bytes([data[6], data[7]]);

        if response_session != 0 {
            self.session_id = response_session;
        }
        self.reply_id = response_reply_id;

        let response_data = if data.len() > 8 { data[8..].to_vec() } else { Vec::new() };
        Ok((response_cmd, response_data))
    }
    
    /// Make commkey for authentication
    fn make_commkey(password: u32, session_id: u16) -> Vec<u8> {
        let key = password;
        let session_id = session_id as u32;
        
        let mut k: u32 = 0;
        for i in 0..32 {
            if (key & (1 << i)) != 0 {
                k = (k << 1) | 1;
            } else {
                k = k << 1;
            }
        }
        k = k.wrapping_add(session_id);
        
        let k_bytes = k.to_le_bytes();
        let xored = [
            k_bytes[0] ^ b'Z',
            k_bytes[1] ^ b'K',
            k_bytes[2] ^ b'S',
            k_bytes[3] ^ b'O',
        ];
        
        let h1 = u16::from_le_bytes([xored[0], xored[1]]);
        let h2 = u16::from_le_bytes([xored[2], xored[3]]);
        let mut result = Vec::new();
        result.extend_from_slice(&h2.to_le_bytes());
        result.extend_from_slice(&h1.to_le_bytes());
        
        let b: u8 = 50;
        let r = result.clone();
        result[0] = r[0] ^ b;
        result[1] = r[1] ^ b;
        result[2] = b;
        result[3] = r[3] ^ b;
        
        result
    }
    
    /// Handshake with device (with authentication support)
    fn do_handshake(&mut self) -> Result<(), String> {
        let (cmd, data) = self.send_command(CMD_CONNECT, &[])?;
        
        if cmd == CMD_ACK_UNAUTH {
            let commkey = Self::make_commkey(0, self.session_id);
            let (auth_cmd, _) = self.send_command(CMD_AUTH, &commkey)?;
            
            if auth_cmd == CMD_ACK_OK {
                info!("Connected (authenticated)");
                Ok(())
            } else {
                Err(format!("Authentication failed: cmd={}", auth_cmd))
            }
        } else if cmd == CMD_ACK_OK {
            if data.len() >= 2 {
                self.session_id = u16::from_le_bytes([data[0], data[1]]);
            }
            info!("Connected");
            Ok(())
        } else {
            Err(format!("Handshake failed: cmd={}", cmd))
        }
    }
    
    fn disable_device(&mut self) -> Result<(), String> {
        let (cmd, _) = self.send_command(CMD_DISABLEDEVICE, &[])?;
        if cmd == CMD_ACK_OK { Ok(()) } else { Err(format!("Failed to disable device: cmd={}", cmd)) }
    }
    
    fn read_sizes(&mut self) -> Result<(u32, u32, u32), String> {
        let (cmd, data) = self.send_command(CMD_GET_FREE_SIZES, &[])?;
        
        if cmd == CMD_ACK_OK && data.len() >= 80 {
            let users = i32::from_le_bytes([data[16], data[17], data[18], data[19]]) as u32;
            let fingers = i32::from_le_bytes([data[24], data[25], data[26], data[27]]) as u32;
            let records = i32::from_le_bytes([data[32], data[33], data[34], data[35]]) as u32;
            
            info!("Device: {} users, {} records", users, records);
            Ok((users, fingers, records))
        } else {
            warn!("Could not read device sizes");
            Ok((0, 0, 0))
        }
    }
    
    /// Get a device option value
    fn get_option(&mut self, option: &str) -> Result<String, String> {
        let mut cmd_data = option.as_bytes().to_vec();
        cmd_data.push(0x00); // null terminate
        
        let (cmd, data) = self.send_command(CMD_OPTIONS_RRQ, &cmd_data)?;
        
        if cmd == CMD_ACK_OK && !data.is_empty() {
            // Response format: "option=value\0" - extract value after '='
            let response = String::from_utf8_lossy(&data);
            let response = response.trim_end_matches('\0');
            
            if let Some(pos) = response.find('=') {
                let value = response[pos + 1..].to_string();
                Ok(value)
            } else {
                Ok(response.to_string())
            }
        } else {
            Ok(String::new())
        }
    }
    
    /// Get device information (name, firmware, serial, etc.)
    /// Get firmware version using direct command
    fn get_firmware_version(&mut self) -> String {
        // Try direct version command first (CMD_VERSION = 1100)
        if let Ok((cmd, data)) = self.send_command(CMD_VERSION, &[]) {
            if cmd == CMD_ACK_OK && !data.is_empty() {
                let version = String::from_utf8_lossy(&data).trim_end_matches('\0').to_string();
                if !version.is_empty() {
                    return version;
                }
            }
        }
        
        // Fallback to options
        let options = ["~ZKFPVersion", "FWVersion", "~FWVersion", "ZKFPVersion"];
        for opt in options {
            let v = self.get_option(opt).unwrap_or_default();
            if !v.is_empty() { return v; }
        }
        String::new()
    }
    
    /// Get serial number using direct command or options
    fn get_serial_number(&mut self) -> String {
        // Try direct serial number command (CMD_SERIALNUMBER = 1101)
        if let Ok((cmd, data)) = self.send_command(CMD_SERIALNUMBER, &[]) {
            if cmd == CMD_ACK_OK && !data.is_empty() {
                let serial = String::from_utf8_lossy(&data).trim_end_matches('\0').to_string();
                if !serial.is_empty() {
                    return serial;
                }
            }
        }
        
        // Fallback to options
        let options = ["~SerialNumber", "SerialNumber", "SN"];
        for opt in options {
            let v = self.get_option(opt).unwrap_or_default();
            if !v.is_empty() { return v; }
        }
        String::new()
    }
    
    fn get_device_info(&mut self) -> DeviceInfo {
        let device_name = self.get_option("~DeviceName").unwrap_or_default();
        let firmware_version = self.get_firmware_version();
        let serial_number = self.get_serial_number();
        let platform = self.get_option("~Platform").unwrap_or_default();
        let mac_address = self.get_option("MAC").unwrap_or_default();
        
        // Log device info on single line
        info!("📟 {} | {} | S/N: {}", 
            if device_name.is_empty() { "Unknown" } else { &device_name },
            if firmware_version.is_empty() { "-" } else { &firmware_version },
            if serial_number.is_empty() { "-" } else { &serial_number }
        );
        
        DeviceInfo {
            device_name,
            firmware_version,
            serial_number,
            platform,
            mac_address,
        }
    }
    
    fn enable_device(&mut self) -> Result<(), String> {
        let (cmd, _) = self.send_command(CMD_ENABLEDEVICE, &[])?;
        if cmd == CMD_ACK_OK { Ok(()) } else { Err(format!("Failed to enable device: cmd={}", cmd)) }
    }
    
    /// Read data using buffered transfer (CMD_DATA_WRRQ)
    fn read_with_buffer_pyzk(&mut self, command: u16, fct: i32) -> Result<(Vec<u8>, usize), String> {
        const MAX_CHUNK: usize = 0xFFc0;
        
        let mut cmd_string = Vec::new();
        cmd_string.push(1u8);
        cmd_string.extend_from_slice(&(command as i16).to_le_bytes());
        cmd_string.extend_from_slice(&fct.to_le_bytes());
        cmd_string.extend_from_slice(&0i32.to_le_bytes());
        
        let (mut cmd, all_data) = self.send_command_large_recv(CMD_DATA_WRRQ, &cmd_string)?;
        let mut data = if all_data.len() > 8 { all_data[8..].to_vec() } else { Vec::new() };
        
        if cmd == CMD_DATA {
            return Ok((data.clone(), data.len()));
        }
        
        // Handle empty ACKs - drain follow-up packets
        if cmd == CMD_ACK_OK && data.len() < 5 {
            let old_timeout = self.stream.read_timeout().ok().flatten();
            let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));

            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(35);
            let mut seen = 0usize;

            while std::time::Instant::now() < deadline && seen < 25 {
                match self.recv_packet() {
                    Ok((cmd2, data2)) => {
                        seen += 1;
                        cmd = cmd2;
                        data = data2;

                        if cmd == CMD_DATA { return Ok((data.clone(), data.len())); }
                        if cmd == CMD_PREPARE_DATA { break; }
                        if cmd == CMD_ACK_OK && data.len() >= 5 { break; }
                    }
                    Err(e) => {
                        if e.contains("os error 35") || e.contains("timed out") || e.contains("Resource temporarily unavailable") {
                            continue;
                        }
                        break;
                    }
                }
            }
            let _ = self.stream.set_read_timeout(old_timeout);
        }
        
        if cmd == CMD_PREPARE_DATA {
            if data.len() >= 4 {
                let size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
                if size > 0 {
                    return self.read_prepare_data_stream(size);
                }
            }
            return Ok((Vec::new(), 0));
        }
        
        // Extract size and read chunks
        if data.len() >= 5 {
            let size = u32::from_le_bytes([data[1], data[2], data[3], data[4]]) as usize;
            if size > 0 && size < 100_000_000 {
                return self.read_chunks(size, MAX_CHUNK);
            }
        }
        
        // Check for second packet in buffer
        if data.len() >= 24 {
            let tcp_magic1 = u16::from_le_bytes([data[0], data[1]]);
            let tcp_magic2 = u16::from_le_bytes([data[2], data[3]]);
            
            if tcp_magic1 == MACHINE_PREPARE_DATA_1 && tcp_magic2 == MACHINE_PREPARE_DATA_2 {
                let payload2 = &data[16..];
                if payload2.len() >= 5 {
                    let size = u32::from_le_bytes([payload2[1], payload2[2], payload2[3], payload2[4]]) as usize;
                    if size > 0 && size < 100_000_000 {
                        self.reply_id = u16::from_le_bytes([data[14], data[15]]);
                        return self.read_chunks(size, MAX_CHUNK);
                    }
                }
            }
        }
        
        let _ = self.send_command(CMD_FREE_DATA, &[]);
        Ok((Vec::new(), 0))
    }
    
    /// Read data in chunks
    fn read_chunks(&mut self, size: usize, max_chunk: usize) -> Result<(Vec<u8>, usize), String> {
        let remain = size % max_chunk;
        let packets = (size - remain) / max_chunk;
        
        let mut all_data = Vec::with_capacity(size);
        let mut start = 0usize;
        let start_time = std::time::Instant::now();
        
        for i in 0..packets {
            let chunk = self.read_chunk_pyzk(start, max_chunk)?;
            all_data.extend_from_slice(&chunk);
            start += max_chunk;
            
            if (i + 1) % 10 == 0 {
                let elapsed = start_time.elapsed().as_secs_f32();
                let speed = if elapsed > 0.0 { (all_data.len() as f32 / 1024.0) / elapsed } else { 0.0 };
                debug!("Progress: {}/{} chunks ({:.1} KB/s)", i + 1, packets, speed);
        }
        }
        
        if remain > 0 {
            let chunk = self.read_chunk_pyzk(start, remain)?;
            all_data.extend_from_slice(&chunk);
        }
        
        let _ = self.send_command(CMD_FREE_DATA, &[]);
        
        let elapsed = start_time.elapsed().as_secs_f32();
        let speed = if elapsed > 0.0 { (all_data.len() as f32 / 1024.0) / elapsed } else { 0.0 };
        info!("Downloaded {} bytes in {:.1}s ({:.1} KB/s)", all_data.len(), elapsed, speed);
        
        let len = all_data.len();
        Ok((all_data, len))
    }
    
    /// Read a single chunk of data
    fn read_chunk_pyzk(&mut self, start: usize, size: usize) -> Result<Vec<u8>, String> {
        let mut cmd_string = Vec::with_capacity(8);
        cmd_string.extend_from_slice(&(start as i32).to_le_bytes());
        cmd_string.extend_from_slice(&(size as i32).to_le_bytes());
        
        let buf = self.create_header(CMD_DATA_RDY, &cmd_string);
        let top = self.create_tcp_top(&buf);
        
        self.stream.write_all(&top).map_err(|e| format!("Send failed: {}", e))?;
        self.stream.flush().map_err(|e| format!("Flush failed: {}", e))?;
        
        let mut tcp_header = [0u8; 8];
        self.stream.read_exact(&mut tcp_header).map_err(|e| format!("Read TCP header: {}", e))?;
        
        let tcp_length = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
        if tcp_length < 8 {
            return Err(format!("TCP length too small: {}", tcp_length));
        }
        
        let mut packet_data = vec![0u8; tcp_length];
        self.stream.read_exact(&mut packet_data).map_err(|e| format!("Read packet: {}", e))?;
        
        let response_cmd = u16::from_le_bytes([packet_data[0], packet_data[1]]);
        self.reply_id = u16::from_le_bytes([packet_data[6], packet_data[7]]);
        let zk_data = if packet_data.len() > 8 { &packet_data[8..] } else { &[] as &[u8] };
        
        // Handle ACK_OK - read next packet for data
        if response_cmd == CMD_ACK_OK {
            let mut next_tcp_header = [0u8; 8];
            if self.stream.read_exact(&mut next_tcp_header).is_ok() {
                let next_tcp_len = u32::from_le_bytes([next_tcp_header[4], next_tcp_header[5], next_tcp_header[6], next_tcp_header[7]]) as usize;
                if next_tcp_len >= 8 {
                    let mut next_packet = vec![0u8; next_tcp_len];
                    self.stream.read_exact(&mut next_packet).map_err(|e| format!("Read next packet: {}", e))?;
                    
                    let next_cmd = u16::from_le_bytes([next_packet[0], next_packet[1]]);
                    self.reply_id = u16::from_le_bytes([next_packet[6], next_packet[7]]);
                    
                    if next_cmd == CMD_DATA && next_packet.len() > 8 {
                        let mut result = next_packet[8..].to_vec();
                        if result.len() < size {
                            let mut more = vec![0u8; size - result.len()];
                            self.stream.read_exact(&mut more).map_err(|e| format!("Read remaining: {}", e))?;
                            result.extend_from_slice(&more);
                        }
                        return Ok(result[..size.min(result.len())].to_vec());
                    }
                    
                    if next_cmd == CMD_PREPARE_DATA {
                        let inner_size = if next_packet.len() >= 12 {
                            u32::from_le_bytes([next_packet[8], next_packet[9], next_packet[10], next_packet[11]]) as usize
                        } else { size };
                        
                        let mut all_data = Vec::with_capacity(size);
                        while all_data.len() < inner_size {
                            let mut data_tcp_header = [0u8; 8];
                            self.stream.read_exact(&mut data_tcp_header).map_err(|e| format!("Read DATA header: {}", e))?;
                            let data_tcp_len = u32::from_le_bytes([data_tcp_header[4], data_tcp_header[5], data_tcp_header[6], data_tcp_header[7]]) as usize;
                            if data_tcp_len < 8 { break; }
                            
                            let mut data_packet = vec![0u8; data_tcp_len];
                            self.stream.read_exact(&mut data_packet).map_err(|e| format!("Read DATA: {}", e))?;
                            
                            let data_cmd = u16::from_le_bytes([data_packet[0], data_packet[1]]);
                            self.reply_id = u16::from_le_bytes([data_packet[6], data_packet[7]]);
                            
                            if data_cmd == CMD_DATA && data_packet.len() > 8 {
                                all_data.extend_from_slice(&data_packet[8..]);
                            } else { break; }
                        }
                        return Ok(all_data[..size.min(all_data.len())].to_vec());
                    }
                }
            }
            return Ok(Vec::new());
        }
        
        if response_cmd == CMD_DATA {
            let mut result = zk_data.to_vec();
            if result.len() < size {
                let mut more = vec![0u8; size - result.len()];
                self.stream.read_exact(&mut more).map_err(|e| format!("Read remaining: {}", e))?;
                result.extend_from_slice(&more);
            }
            let _ = self.try_read_ack();
            return Ok(result[..size.min(result.len())].to_vec());
        }
        
        if response_cmd == CMD_PREPARE_DATA {
            if zk_data.len() < 4 {
                return Err("PREPARE_DATA: no size".to_string());
            }
            let inner_size = u32::from_le_bytes([zk_data[0], zk_data[1], zk_data[2], zk_data[3]]) as usize;
            let mut all_data = Vec::with_capacity(inner_size);
            
            while all_data.len() < inner_size {
                let mut next_tcp_header = [0u8; 8];
                self.stream.read_exact(&mut next_tcp_header).map_err(|e| format!("Read header: {}", e))?;
                let next_tcp_len = u32::from_le_bytes([next_tcp_header[4], next_tcp_header[5], next_tcp_header[6], next_tcp_header[7]]) as usize;
                if next_tcp_len == 0 { continue; }
        
                let mut next_packet = vec![0u8; next_tcp_len];
                self.stream.read_exact(&mut next_packet).map_err(|e| format!("Read packet: {}", e))?;
                if next_packet.len() < 8 { continue; }
                
                let next_cmd = u16::from_le_bytes([next_packet[0], next_packet[1]]);
                self.reply_id = u16::from_le_bytes([next_packet[6], next_packet[7]]);
                
                if next_cmd == CMD_DATA && next_packet.len() > 8 {
                    all_data.extend_from_slice(&next_packet[8..]);
                } else if next_cmd == CMD_ACK_OK { break; }
                else { break; }
            }
            return Ok(all_data[..size.min(all_data.len())].to_vec());
        }
        
        Err(format!("Unexpected response cmd={}", response_cmd))
    }
    
    /// Try to read a trailing ACK packet
    fn try_read_ack(&mut self) -> Result<(), String> {
        let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_millis(100)));
        let mut tcp_header = [0u8; 8];
        if let Ok(_) = self.stream.read_exact(&mut tcp_header) {
            let tcp_len = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
            if tcp_len > 0 && tcp_len <= 64 {
                let mut packet = vec![0u8; tcp_len];
                let _ = self.stream.read_exact(&mut packet);
                if packet.len() >= 8 {
                    self.reply_id = u16::from_le_bytes([packet[6], packet[7]]);
                }
            }
        }
        let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
        Ok(())
    }
    
    /// Read data stream after PREPARE_DATA response
    fn read_prepare_data_stream(&mut self, size: usize) -> Result<(Vec<u8>, usize), String> {
        let mut all_data = Vec::with_capacity(size);
        let start_time = std::time::Instant::now();
        
        while all_data.len() < size {
            let mut tcp_header = [0u8; 8];
            self.stream.read_exact(&mut tcp_header).map_err(|e| format!("Read header: {}", e))?;
            
            let tcp_len = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
            if tcp_len < 8 { continue; }
            
            let mut packet = vec![0u8; tcp_len];
            self.stream.read_exact(&mut packet).map_err(|e| format!("Read packet: {}", e))?;
            
            let cmd = u16::from_le_bytes([packet[0], packet[1]]);
            self.reply_id = u16::from_le_bytes([packet[6], packet[7]]);
        
            if cmd == CMD_DATA && packet.len() > 8 {
                all_data.extend_from_slice(&packet[8..]);
            } else if cmd == CMD_ACK_OK {
                break;
        } else {
                break;
            }
        }
        
        let _ = self.send_command(CMD_FREE_DATA, &[]);
        
        let elapsed = start_time.elapsed().as_secs_f32();
        let speed = if elapsed > 0.0 { (all_data.len() as f32 / 1024.0) / elapsed } else { 0.0 };
        info!("Downloaded {} bytes in {:.1}s ({:.1} KB/s)", all_data.len(), elapsed, speed);
        
        let len = all_data.len();
        Ok((all_data, len))
    }
    
    /// Decode ZKTeco timestamp
    fn decode_time(t: u32) -> DateTime<Local> {
        let second = t % 60;
        let t = t / 60;
        let minute = t % 60;
        let t = t / 60;
        let hour = t % 24;
        let t = t / 24;
        let day = (t % 31) + 1;
        let t = t / 31;
        let month = (t % 12) + 1;
        let t = t / 12;
        let year = (t + 2000) as i32;
        
        Local.with_ymd_and_hms(year, month as u32, day as u32, hour as u32, minute as u32, second as u32)
            .single()
            .unwrap_or_else(|| Local::now())
    }
    
    fn get_users(&mut self) -> Result<Vec<User>, String> {
        let (data, _) = self.read_with_buffer_pyzk(CMD_USERTEMP_RRQ, FCT_USER)?;
        let mut users = Vec::new();
        
        if data.len() <= 4 {
            return Ok(users);
        }
        
        let total_size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        let userdata = &data[4..];
        
        let record_size = if userdata.len() > 0 && total_size > 0 {
            if userdata.len() >= 72 && userdata.len() % 72 == 0 { 72 }
            else if userdata.len() >= 28 && userdata.len() % 28 == 0 { 28 }
            else { 28 }
        } else { 28 };
        
        if record_size == 28 {
            let mut offset = 0;
            while offset + 28 <= userdata.len() {
                let record = &userdata[offset..offset + 28];
                let uid = u16::from_le_bytes([record[0], record[1]]) as u32;
                // Name field: bytes 2-10 (8 bytes) or bytes 8-24 (16 bytes) - try larger range
                let name_bytes = &record[2..26];
                
                        let name = String::from_utf8_lossy(name_bytes)
                            .trim_end_matches('\0')
                    .trim()
                            .to_string();
                let name = if name.is_empty() { format!("User-{}", uid) } else { name };
                
                // For 28-byte records, uid IS the user_id for lookup
                users.push(User { uid, user_id: uid.to_string(), name });
                offset += 28;
            }
                            } else {
            // 72-byte record format (pyzk)
            let mut offset = 0;
            while offset + 72 <= userdata.len() {
                let record = &userdata[offset..offset + 72];
                let uid = u16::from_le_bytes([record[0], record[1]]) as u32;
                // Name: bytes 11-35 (24 chars)
                let name_bytes = &record[11..35];
                // User ID (badge/employee ID): bytes 48-72 (24 chars)
                let user_id_bytes = &record[48..72];
                
                let name = String::from_utf8_lossy(name_bytes).trim_end_matches('\0').trim().to_string();
                let badge_id = String::from_utf8_lossy(user_id_bytes).trim_end_matches('\0').trim().to_string();
                
                let name = if name.is_empty() { format!("User-{}", uid) } else { name };
                // Use badge_id as user_id (this is what attendance records use)
                // If badge_id is empty, fall back to uid
                let user_id = if badge_id.is_empty() { uid.to_string() } else { badge_id };
                
                users.push(User { uid, user_id, name });
                offset += 72;
            }
        }
        
        info!("Found {} users", users.len());
        // Log first few users for debugging
        for (i, user) in users.iter().take(5).enumerate() {
            info!("  User {}: uid={}, badge='{}', name='{}'", i+1, user.uid, user.user_id, user.name);
        }
        Ok(users)
    }
    
    /// Large buffer read (captures multiple packets)
    fn send_command_large_recv(&mut self, command: u16, command_string: &[u8]) -> Result<(u16, Vec<u8>), String> {
        let buf = self.create_header(command, command_string);
        let top = self.create_tcp_top(&buf);
        
        self.stream.write_all(&top).map_err(|e| format!("Write failed: {}", e))?;
        self.stream.flush().map_err(|e| format!("Flush failed: {}", e))?;
        
        let mut large_buf = vec![0u8; 1032];
        let old_timeout = self.stream.read_timeout().ok().flatten();
        let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
        
        let bytes_read = self.stream.read(&mut large_buf).map_err(|e| format!("Read failed: {}", e))?;
        let _ = self.stream.set_read_timeout(old_timeout);
        
        if bytes_read < 16 {
            return Err(format!("Response too short: {} bytes", bytes_read));
        }
        
        let tcp_magic1 = u16::from_le_bytes([large_buf[0], large_buf[1]]);
        let tcp_magic2 = u16::from_le_bytes([large_buf[2], large_buf[3]]);
        
        if tcp_magic1 != MACHINE_PREPARE_DATA_1 || tcp_magic2 != MACHINE_PREPARE_DATA_2 {
            return Err(format!("Invalid TCP magic"));
        }
        
        let response_cmd = u16::from_le_bytes([large_buf[8], large_buf[9]]);
        let response_session = u16::from_le_bytes([large_buf[12], large_buf[13]]);
        let response_reply_id = u16::from_le_bytes([large_buf[14], large_buf[15]]);
        
        if response_session != 0 { self.session_id = response_session; }
        self.reply_id = response_reply_id;
        
        Ok((response_cmd, large_buf[8..bytes_read].to_vec()))
    }
    
    /// Simple read (direct command)
    fn read_simple(&mut self, command: u16) -> Result<(Vec<u8>, usize), String> {
        let (cmd, data) = self.send_command(command, &[])?;
        
        if cmd == CMD_DATA {
            return Ok((data.clone(), data.len()));
        }
        
        if cmd == CMD_PREPARE_DATA && data.len() >= 4 {
            let size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
            if size > 0 {
                return self.read_prepare_data_stream(size);
            }
        }
        
        if cmd == CMD_ACK_OK && !data.is_empty() {
            return Ok((data.clone(), data.len()));
        }
        
        Ok((Vec::new(), 0))
    }
    
    fn get_attendance(&mut self, users: &[User], expected_records: u32) -> Result<Vec<AttendanceRecord>, String> {
        info!("Fetching attendance logs (expecting {})...", expected_records);
        
        // Try simple read first
        let (mut data, _) = self.read_simple(CMD_ATTLOG_RRQ)?;
        
        // If empty, try buffered read
        if data.len() < 4 && expected_records > 0 {
            let (data2, _) = self.read_with_buffer_pyzk(CMD_ATTLOG_RRQ, 0)?;
            data = data2;
        }
        
        // If still empty, try with fct=1
        if data.len() < 4 && expected_records > 0 {
            let (data2, _) = self.read_with_buffer_pyzk(CMD_ATTLOG_RRQ, 1)?;
            data = data2;
        }
        
        let mut records = Vec::new();
        
        if data.len() < 4 {
            return Ok(records);
        }
        
        let total_size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        
        let record_size = if expected_records > 0 && total_size > 0 {
            total_size / expected_records as usize
        } else {
            if (data.len() - 4) % 40 == 0 { 40 }
            else if (data.len() - 4) % 16 == 0 { 16 }
            else if (data.len() - 4) % 8 == 0 { 8 }
            else { 16 }
        };
        
        let attendance_data = &data[4..];
        
        // Build user lookup (by uid and user_id, with multiple key formats)
        let mut user_lookup: HashMap<String, String> = HashMap::new();
        for user in users {
            // Add by uid (internal ID)
            user_lookup.insert(user.uid.to_string(), user.name.clone());
            // Add by user_id string
            user_lookup.insert(user.user_id.clone(), user.name.clone());
            // Also try parsing user_id as number
            if let Ok(num) = user.user_id.parse::<u32>() {
                user_lookup.insert(num.to_string(), user.name.clone());
            }
            // Extract leading digits from user_id (e.g., "101Emplo" -> "101")
            let digits: String = user.user_id.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !digits.is_empty() && digits != user.user_id {
                user_lookup.insert(digits, user.name.clone());
            }
        }
        info!("User lookup: {} keys for {} users", user_lookup.len(), users.len());
        
        // Parse based on record size
        // pyzk handles: 8, 16, 40 byte records
        info!("Attendance record size: {} bytes", record_size);
        match record_size {
            8 => {
                // pyzk: uid, status, timestamp, punch = unpack('HB4sB', ...)
                let mut offset = 0;
                while offset + 8 <= attendance_data.len() {
                    let record = &attendance_data[offset..offset + 8];
                    
                    let uid = u16::from_le_bytes([record[0], record[1]]);
                    let status = record[2];
                    let timestamp = u32::from_le_bytes([record[3], record[4], record[5], record[6]]);
                    let punch = record[7];
                    
                    let user_id_str = uid.to_string();
                    let user_name = user_lookup
                        .get(&user_id_str)
                        .cloned()
                        .unwrap_or_else(|| format!("ID: {}", uid));
                    
                    let dt = Self::decode_time(timestamp);
                    
                    records.push(AttendanceRecord {
                        user_id: uid as u32,
                        user_name,
                        timestamp: dt.to_rfc3339(),
                        status,
                        punch,
                        date: dt.format("%Y-%m-%d").to_string(),
                        time: dt.format("%H:%M:%S").to_string(),
                    });
                    
                    offset += 8;
                }
            }
            16 => {
                // pyzk: user_id, timestamp, status, punch, reserved, workcode = 
                //       unpack('<I4sBB2sI', ...)
                let mut offset = 0;
                let mut sample_logged = false;
                while offset + 16 <= attendance_data.len() {
                    let record = &attendance_data[offset..offset + 16];
                    
                    let user_id = u32::from_le_bytes([record[0], record[1], record[2], record[3]]);
                    let timestamp = u32::from_le_bytes([record[4], record[5], record[6], record[7]]);
                    let status = record[8];
                    let punch = record[9];
                    // reserved 2 bytes
                    // workcode 4 bytes
                    
                    // Log first attendance record for debugging
                    if !sample_logged {
                        info!("Sample attendance: user_id={}, bytes={:02X?}", user_id, &record[0..4]);
                        sample_logged = true;
                    }
                    
                    let user_id_str = user_id.to_string();
                    let user_name = user_lookup
                        .get(&user_id_str)
                        .cloned()
                        .unwrap_or_else(|| format!("ID: {}", user_id));
                    
                    let dt = Self::decode_time(timestamp);
                    
                    records.push(AttendanceRecord {
                        user_id,
                        user_name,
                        timestamp: dt.to_rfc3339(),
                        status,
                        punch,
                        date: dt.format("%Y-%m-%d").to_string(),
                        time: dt.format("%H:%M:%S").to_string(),
                    });
                    
                    offset += 16;
                }
            }
            40 | _ => {
                // pyzk 40-byte: uid, user_id, status, timestamp, punch, space =
                //              unpack('<H24sB4sB8s', ...)
                let actual_record_size = if record_size >= 40 { 40 } else { record_size };
                let mut offset = 0;
                let mut sample_logged = false;
                
                while offset + actual_record_size <= attendance_data.len() {
                    let record = &attendance_data[offset..offset + actual_record_size];
                    
                    if actual_record_size >= 40 {
                        let uid = u16::from_le_bytes([record[0], record[1]]);
                        let user_id_bytes = &record[2..26];
                        let status = record[26];
                        let timestamp = u32::from_le_bytes([record[27], record[28], record[29], record[30]]);
                        let punch = record[31];
                        
                        let user_id_str = String::from_utf8_lossy(user_id_bytes)
                            .trim_end_matches('\0')
                            .trim()
                            .to_string();
                        
                        // Log first few attendance records for debugging
                        if !sample_logged && records.len() < 3 {
                            info!("  Attendance: uid={}, badge='{}', found={}", 
                                uid, user_id_str, user_lookup.contains_key(&user_id_str));
                            if records.len() >= 2 { sample_logged = true; }
                        }
                        
                        let user_name = if !user_id_str.is_empty() {
                            user_lookup.get(&user_id_str)
                                .or_else(|| user_lookup.get(&uid.to_string()))
                                .cloned()
                                .unwrap_or_else(|| format!("ID: {}", user_id_str))
                        } else {
                            user_lookup.get(&uid.to_string())
                            .cloned()
                                .unwrap_or_else(|| format!("ID: {}", uid))
                        };
                        
                        let dt = Self::decode_time(timestamp);
                        let final_user_id: u32 = user_id_str.parse().unwrap_or(uid as u32);
                        
                        records.push(AttendanceRecord {
                            user_id: final_user_id,
                            user_name,
                            timestamp: dt.to_rfc3339(),
                            status,
                            punch,
                            date: dt.format("%Y-%m-%d").to_string(),
                            time: dt.format("%H:%M:%S").to_string(),
                        });
                    }
                    
                    offset += actual_record_size;
                }
            }
        }
        
        info!("Parsed {} attendance records", records.len());
        Ok(records)
    }
    
    fn disconnect(&mut self) -> Result<(), String> {
        let _ = self.enable_device();
        let _ = self.send_command(CMD_EXIT, &[]);
        info!("Disconnected");
        Ok(())
    }
}

pub async fn connect_and_fetch_attendance(
    ip: &str,
    port: u16,
) -> Result<AttendanceResponse, String> {
    let ip = ip.to_string();
    
    tokio::task::spawn_blocking(move || {
        let mut client = ZKClient::connect(&ip, port)?;
        
        // Get device info first
        let device_info = client.get_device_info();
        
        if let Err(e) = client.disable_device() {
            warn!("Failed to disable device: {}", e);
        }
        
        let (_, _, record_count) = client.read_sizes().unwrap_or((0, 0, 0));
        
        let users = client.get_users().unwrap_or_else(|_| Vec::new());
        info!("Users: {}, Expected records: {}", users.len(), record_count);
        
        let records = client.get_attendance(&users, record_count)?;
        info!("Fetched {} attendance records", records.len());
        
        client.disconnect()?;
        
        Ok(AttendanceResponse {
            device_info,
            records,
        })
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}

/// Quick function to get device info without fetching attendance
/// Used during network scanning
pub async fn get_device_info_quick(ip: &str, port: u16) -> Option<DeviceInfo> {
    let ip = ip.to_string();
    
    tokio::task::spawn_blocking(move || {
        // Quick connect with shorter timeout
        let addr = format!("{}:{}", ip, port);
        let stream = std::net::TcpStream::connect_timeout(
            &addr.parse().ok()?,
            std::time::Duration::from_secs(3)
        ).ok()?;
        
        stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).ok()?;
        stream.set_write_timeout(Some(std::time::Duration::from_secs(3))).ok()?;
        
        let mut client = ZKClient {
            stream,
            session_id: 0,
            reply_id: USHRT_MAX - 1,
        };
        
        // Try to handshake
        if client.do_handshake().is_err() {
            return None;
        }
        
        // Get device info
        let device_info = client.get_device_info();
        
        // Disconnect
        let _ = client.disconnect();
        
        Some(device_info)
    })
    .await
    .ok()?
}
