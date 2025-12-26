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
    pub timestamp: String,
    pub status: u8,
    pub punch: u8,
    pub date: String,
    pub time: String,
    pub event: String,
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
        
        debug!("Response: cmd={}, data_len={}", response_cmd, response_data.len());
        
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
            debug!("Device requires authentication");
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
        
        Ok((all_data, all_data.len()))
    }
    
    /// Read a chunk - matches pyzk's __read_chunk exactly
    fn read_chunk_pyzk(&mut self, start: usize, size: usize) -> Result<Vec<u8>, String> {
        info!("read_chunk_pyzk: reading chunk at start={}, size={}", start, size);
        
        // pyzk: command = const._CMD_READ_BUFFER (1504)
        // pyzk: command_string = pack('<ii', start, size)
        let mut cmd_string = Vec::with_capacity(8);
        cmd_string.extend_from_slice(&(start as i32).to_le_bytes());
        cmd_string.extend_from_slice(&(size as i32).to_le_bytes());
        
        // pyzk: if self.tcp: response_size = size + 32
        let _response_size = size + 32;
        
        // Send command
        let buf = self.create_header(CMD_DATA_RDY, &cmd_string);
        let top = self.create_tcp_top(&buf);
        
        info!("read_chunk_pyzk: sending CMD_DATA_RDY (1504)...");
        self.stream.write_all(&top)
            .map_err(|e| format!("Send CMD_DATA_RDY failed: {}", e))?;
        self.stream.flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        
        // pyzk: recv(response_size + 8) - but TCP may fragment
        // Read initial response
        info!("read_chunk_pyzk: waiting for response...");
        let mut tcp_header = [0u8; 8];
        self.stream.read_exact(&mut tcp_header)
            .map_err(|e| format!("Read chunk TCP header: {}", e))?;
        info!("read_chunk_pyzk: got TCP header");
        
        let tcp_length = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
        
        if tcp_length < 8 {
            return Err(format!("TCP length too small: {}", tcp_length));
        }
        
        let mut packet_data = vec![0u8; tcp_length];
        self.stream.read_exact(&mut packet_data)
            .map_err(|e| format!("Read chunk packet: {}", e))?;
        
        let response_cmd = u16::from_le_bytes([packet_data[0], packet_data[1]]);
        self.reply_id = u16::from_le_bytes([packet_data[6], packet_data[7]]);
        
        // Data after ZK header (8 bytes)
        let zk_data = if packet_data.len() > 8 { &packet_data[8..] } else { &[] as &[u8] };
        
        info!("read_chunk_pyzk: cmd={}, tcp_len={}, zk_data_len={}", response_cmd, tcp_length, zk_data.len());
        
        // Handle CMD_ACK_OK - this can happen when device is in a different state
        // or when using draining approach. Try reading data directly from socket.
        if response_cmd == CMD_ACK_OK {
            info!("read_chunk_pyzk: got ACK_OK instead of DATA, trying to read data directly...");
            
            // The device might be streaming data differently
            // Try reading the next packet which might contain actual data
            let mut next_tcp_header = [0u8; 8];
            match self.stream.read_exact(&mut next_tcp_header) {
                Ok(_) => {
                    let next_tcp_len = u32::from_le_bytes([next_tcp_header[4], next_tcp_header[5], 
                                                          next_tcp_header[6], next_tcp_header[7]]) as usize;
                    info!("read_chunk_pyzk: next packet tcp_len={}", next_tcp_len);
                    
                    if next_tcp_len >= 8 {
                        let mut next_packet = vec![0u8; next_tcp_len];
                        self.stream.read_exact(&mut next_packet)
                            .map_err(|e| format!("Read next packet: {}", e))?;
                        
                        let next_cmd = u16::from_le_bytes([next_packet[0], next_packet[1]]);
                        self.reply_id = u16::from_le_bytes([next_packet[6], next_packet[7]]);
                        
                        info!("read_chunk_pyzk: next packet cmd={}", next_cmd);
                        
                        if next_cmd == CMD_DATA && next_packet.len() > 8 {
                            let next_data = &next_packet[8..];
                            let mut result = next_data.to_vec();
                            
                            // Read remaining if needed
                            if result.len() < size {
                                let need = size - result.len();
                                let mut more = vec![0u8; need];
                                self.stream.read_exact(&mut more)
                                    .map_err(|e| format!("Read remaining after ACK: {}", e))?;
                                result.extend_from_slice(&more);
                            }
                            
                            return Ok(result[..size.min(result.len())].to_vec());
                        }
                        
                        // Handle PREPARE_DATA followed by DATA stream
                        if next_cmd == CMD_PREPARE_DATA {
                            let inner_size = if next_packet.len() >= 12 {
                                u32::from_le_bytes([next_packet[8], next_packet[9], next_packet[10], next_packet[11]]) as usize
                            } else {
                                size
                            };
                            info!("read_chunk_pyzk: PREPARE_DATA inner_size={}", inner_size);
                            
                            // Read DATA packets until we have enough
                            let mut all_data = Vec::with_capacity(size);
                            
                            while all_data.len() < inner_size {
                                let mut data_tcp_header = [0u8; 8];
                                self.stream.read_exact(&mut data_tcp_header)
                                    .map_err(|e| format!("Read DATA TCP header: {}", e))?;
                                
                                let data_tcp_len = u32::from_le_bytes([data_tcp_header[4], data_tcp_header[5],
                                                                        data_tcp_header[6], data_tcp_header[7]]) as usize;
                                
                                if data_tcp_len < 8 {
                                    break;
                                }
                                
                                let mut data_packet = vec![0u8; data_tcp_len];
                                self.stream.read_exact(&mut data_packet)
                                    .map_err(|e| format!("Read DATA packet: {}", e))?;
                                
                                let data_cmd = u16::from_le_bytes([data_packet[0], data_packet[1]]);
                                self.reply_id = u16::from_le_bytes([data_packet[6], data_packet[7]]);
                                
                                if data_cmd == CMD_DATA && data_packet.len() > 8 {
                                    all_data.extend_from_slice(&data_packet[8..]);
                                } else if data_cmd == CMD_ACK_OK {
                                    break;
                                } else {
                                    break;
                                }
                            }
                            
                            return Ok(all_data[..size.min(all_data.len())].to_vec());
                        }
                    }
                }
                Err(e) => {
                    info!("read_chunk_pyzk: no data after ACK: {}", e);
                }
            }
            
            // If we couldn't get data after ACK, return empty
            return Ok(Vec::new());
        }
        
        if response_cmd == CMD_DATA {
            // Direct data response
            let mut result = zk_data.to_vec();
            
            // If we need more data, read it directly
            if result.len() < size {
                let need = size - result.len();
                let mut more = vec![0u8; need];
                self.stream.read_exact(&mut more)
                    .map_err(|e| format!("Read remaining {} bytes: {}", need, e))?;
                result.extend_from_slice(&more);
            }
            
            // Try to read trailing ACK (don't fail if missing)
            let _ = self.try_read_ack();
            
            return Ok(result[..size.min(result.len())].to_vec());
        }
        
        if response_cmd == CMD_PREPARE_DATA {
            // pyzk: size = self.__get_data_size() = unpack('I', self.__data[:4])[0]
            if zk_data.len() < 4 {
                return Err("PREPARE_DATA: no size in response".to_string());
            }
            
            let inner_size = u32::from_le_bytes([zk_data[0], zk_data[1], zk_data[2], zk_data[3]]) as usize;
            debug!("read_chunk_pyzk: PREPARE_DATA inner_size={}", inner_size);
            
            // pyzk uses __recieve_tcp_data which reads data following PREPARE_DATA
            // The actual data comes in CMD_DATA packets
            let mut all_data = Vec::with_capacity(inner_size);
            
            // Read CMD_DATA packets until we have enough
            while all_data.len() < inner_size {
                let mut next_tcp_header = [0u8; 8];
                self.stream.read_exact(&mut next_tcp_header)
                    .map_err(|e| format!("Read data TCP header: {}", e))?;
                
                let next_tcp_len = u32::from_le_bytes([next_tcp_header[4], next_tcp_header[5], 
                                                        next_tcp_header[6], next_tcp_header[7]]) as usize;
                
                if next_tcp_len == 0 {
                    warn!("Got empty TCP packet");
                    continue;
                }
                
                let mut next_packet = vec![0u8; next_tcp_len];
                self.stream.read_exact(&mut next_packet)
                    .map_err(|e| format!("Read data packet: {}", e))?;
                
                if next_packet.len() < 8 {
                    warn!("Packet too short: {} bytes", next_packet.len());
                    continue;
                }
                
                let next_cmd = u16::from_le_bytes([next_packet[0], next_packet[1]]);
                self.reply_id = u16::from_le_bytes([next_packet[6], next_packet[7]]);
                
                if next_cmd == CMD_DATA {
                    // Append data after ZK header
                    if next_packet.len() > 8 {
                        all_data.extend_from_slice(&next_packet[8..]);
                    }
                } else if next_cmd == CMD_ACK_OK {
                    // Done receiving
                    break;
                } else {
                    warn!("Unexpected cmd in data stream: {}", next_cmd);
                    break;
                }
            }
            
            debug!("read_chunk_pyzk: received {} bytes of {} expected", all_data.len(), inner_size);
            return Ok(all_data[..size.min(all_data.len())].to_vec());
        }
        
        Err(format!("Unexpected chunk response cmd={}", response_cmd))
    }
    
    /// Try to read an ACK packet (non-blocking, used after data read)
    fn try_read_ack(&mut self) -> Result<(), String> {
        // Set short timeout for ACK
        let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_millis(100)));
        
        let mut tcp_header = [0u8; 8];
        match self.stream.read_exact(&mut tcp_header) {
            Ok(_) => {
                let tcp_len = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
                if tcp_len > 0 && tcp_len <= 64 {
                    let mut packet = vec![0u8; tcp_len];
                    let _ = self.stream.read_exact(&mut packet);
                    if packet.len() >= 8 {
                        self.reply_id = u16::from_le_bytes([packet[6], packet[7]]);
                    }
                }
            }
            Err(_) => {}
        }
        
        // Restore normal timeout
        let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
        Ok(())
    }
    
    /// Read data stream after CMD_PREPARE_DATA response (pyzk's __recieve_chunk for PREPARE_DATA)
    fn read_prepare_data_stream(&mut self, size: usize) -> Result<(Vec<u8>, usize), String> {
        info!("read_prepare_data_stream: expecting {} bytes", size);
        
        let mut all_data = Vec::with_capacity(size);
        let start_time = std::time::Instant::now();
        
        // Read CMD_DATA packets until we have all data or get ACK_OK
        while all_data.len() < size {
            let mut tcp_header = [0u8; 8];
            self.stream.read_exact(&mut tcp_header)
                .map_err(|e| format!("Read data TCP header: {}", e))?;
            
            let tcp_len = u32::from_le_bytes([tcp_header[4], tcp_header[5], tcp_header[6], tcp_header[7]]) as usize;
            
            if tcp_len < 8 {
                warn!("TCP packet too short: {}", tcp_len);
                continue;
            }
            
            let mut packet = vec![0u8; tcp_len];
            self.stream.read_exact(&mut packet)
                .map_err(|e| format!("Read data packet: {}", e))?;
            
            let cmd = u16::from_le_bytes([packet[0], packet[1]]);
            self.reply_id = u16::from_le_bytes([packet[6], packet[7]]);
            
            if cmd == CMD_DATA {
                if packet.len() > 8 {
                    all_data.extend_from_slice(&packet[8..]);
                }
                
                // Log progress every ~1MB
                if all_data.len() % (1024 * 1024) < 65536 {
                    let elapsed = start_time.elapsed().as_secs_f32();
                    let speed = if elapsed > 0.0 { (all_data.len() as f32 / 1024.0) / elapsed } else { 0.0 };
                    info!("  📥 {} / {} bytes ({:.1} KB/s)", all_data.len(), size, speed);
                }
            } else if cmd == CMD_ACK_OK {
                info!("read_prepare_data_stream: got ACK_OK, done");
                break;
        } else {
                warn!("read_prepare_data_stream: unexpected cmd={}", cmd);
                break;
            }
        }
        
        // Free data buffer
        let (free_cmd, _) = self.send_command(CMD_FREE_DATA, &[])?;
        if free_cmd != CMD_ACK_OK {
            warn!("FREE_DATA returned cmd={}", free_cmd);
        }
        
        let elapsed = start_time.elapsed().as_secs_f32();
        let speed = if elapsed > 0.0 { (all_data.len() as f32 / 1024.0) / elapsed } else { 0.0 };
        info!("read_prepare_data_stream: received {} bytes in {:.1}s ({:.1} KB/s)", all_data.len(), elapsed, speed);
        
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
        info!("👥 Fetching users...");
        
        // pyzk: userdata, size = self.read_with_buffer(const.CMD_USERTEMP_RRQ, const.FCT_USER)
        let (data, size) = self.read_with_buffer_pyzk(CMD_USERTEMP_RRQ, FCT_USER)?;
        let mut users = Vec::new();
        
        // Save raw user data to file for debugging
        if !data.is_empty() {
            if let Ok(mut file) = std::fs::File::create("/tmp/zk_users_raw.bin") {
                use std::io::Write;
                let _ = file.write_all(&data);
                info!("💾 Saved raw user data to /tmp/zk_users_raw.bin ({} bytes)", data.len());
            }
        }
        
        info!("👥 User data: {} bytes (size={})", data.len(), size);
        
        if data.len() <= 4 {
            info!("👥 No user data received");
            return Ok(users);
        }
        
        // pyzk: total_size = unpack("I",userdata[:4])[0]
        let total_size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        info!("👥 total_size from header: {}", total_size);
        
        // pyzk: userdata = userdata[4:] - skip the 4-byte header
        let userdata = &data[4..];
        
        // pyzk: self.user_packet_size = total_size / self.users
        // We need to determine record size from data
        // Try 28 (ZK6) or 72 (ZK8)
        let record_size = if userdata.len() > 0 && total_size > 0 {
            // Check which record size makes sense
            if userdata.len() >= 72 && userdata.len() % 72 == 0 {
                72
            } else if userdata.len() >= 28 && userdata.len() % 28 == 0 {
                28
            } else {
                // Fallback: estimate from data
                28
            }
        } else {
            28
        };
        
        info!("👥 Using record size: {} bytes", record_size);
        
        let user_count = userdata.len() / record_size;
        info!("👥 Parsing {} user records", user_count);
        
        if record_size == 28 {
            // pyzk ZK6: uid, privilege, password, name, card, group_id, timezone, user_id = 
            //           unpack('<HB5s8sIxBhI', userdata[:28])
            // H=2, B=1, 5s=5, 8s=8, I=4, x=1, B=1, h=2, I=4 = 28 bytes
            let mut offset = 0;
            while offset + 28 <= userdata.len() {
                let record = &userdata[offset..offset + 28];
                
                let uid = u16::from_le_bytes([record[0], record[1]]) as u32;
                let _privilege = record[2];
                let password_bytes = &record[3..8];
                let name_bytes = &record[8..16];
                let _card = u32::from_le_bytes([record[16], record[17], record[18], record[19]]);
                // skip 1 byte (x)
                let _group_id = record[21];
                let _timezone = i16::from_le_bytes([record[22], record[23]]);
                let user_id_num = u32::from_le_bytes([record[24], record[25], record[26], record[27]]);
                
                let password = String::from_utf8_lossy(password_bytes)
                    .trim_end_matches('\0')
                    .to_string();
                        let name = String::from_utf8_lossy(name_bytes)
                            .trim_end_matches('\0')
                    .trim()
                            .to_string();
                        
                let name = if name.is_empty() { format!("NN-{}", user_id_num) } else { name };
                        
                        users.push(User {
                            uid,
                    user_id: user_id_num.to_string(),
                    name,
                });
                
                offset += 28;
            }
                            } else {
            // pyzk ZK8: uid, privilege, password, name, card, group_id, user_id =
            //           unpack('<HB8s24sIx7sx24s', userdata[:72])
            // H=2, B=1, 8s=8, 24s=24, I=4, x=1, 7s=7, x=1, 24s=24 = 72 bytes
            let mut offset = 0;
            while offset + 72 <= userdata.len() {
                let record = &userdata[offset..offset + 72];
                
                let uid = u16::from_le_bytes([record[0], record[1]]) as u32;
                let _privilege = record[2];
                let password_bytes = &record[3..11];
                let name_bytes = &record[11..35];
                let _card = u32::from_le_bytes([record[35], record[36], record[37], record[38]]);
                // skip 1 byte
                let group_id_bytes = &record[40..47];
                // skip 1 byte  
                let user_id_bytes = &record[48..72];
                
                let _password = String::from_utf8_lossy(password_bytes)
                    .trim_end_matches('\0')
                    .to_string();
                let name = String::from_utf8_lossy(name_bytes)
                    .trim_end_matches('\0')
                    .trim()
                    .to_string();
                let _group_id = String::from_utf8_lossy(group_id_bytes)
                    .trim_end_matches('\0')
                    .to_string();
                let user_id = String::from_utf8_lossy(user_id_bytes)
                    .trim_end_matches('\0')
                    .to_string();
                
                let name = if name.is_empty() { format!("NN-{}", user_id) } else { name };
                let user_id = if user_id.is_empty() { uid.to_string() } else { user_id };
                
                users.push(User {
                    uid,
                    user_id,
                    name,
                });
                
                offset += 72;
            }
        }
        
        info!("👥 Found {} users", users.len());
        Ok(users)
    }
    
    /// Large buffer read - mimics pyzk's recv(1032) behavior
    /// pyzk reads large buffers which can contain multiple TCP packets
    fn send_command_large_recv(&mut self, command: u16, command_string: &[u8]) -> Result<(u16, Vec<u8>), String> {
        let buf = self.create_header(command, command_string);
        let top = self.create_tcp_top(&buf);
        
        self.stream.write_all(&top)
            .map_err(|e| format!("Failed to write command: {}", e))?;
        self.stream.flush()
            .map_err(|e| format!("Failed to flush: {}", e))?;
        
        // Like pyzk: recv(response_size + 8) where response_size=1024 for buffered reads
        // This reads UP TO 1032 bytes - may include multiple packets
        let mut large_buf = vec![0u8; 1032];
        
        // Set a short timeout for this initial read
        let old_timeout = self.stream.read_timeout().ok().flatten();
        let _ = self.stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
        
        // Use read() instead of read_exact() to get whatever is available
        let bytes_read = self.stream.read(&mut large_buf)
            .map_err(|e| format!("Failed to read large buffer: {}", e))?;
        
        let _ = self.stream.set_read_timeout(old_timeout);
        
        info!("send_command_large_recv: read {} bytes", bytes_read);
        
        if bytes_read < 16 {
            return Err(format!("Response too short: {} bytes", bytes_read));
        }
        
        // Parse first packet's TCP header
        let tcp_magic1 = u16::from_le_bytes([large_buf[0], large_buf[1]]);
        let tcp_magic2 = u16::from_le_bytes([large_buf[2], large_buf[3]]);
        let tcp_length = u32::from_le_bytes([large_buf[4], large_buf[5], large_buf[6], large_buf[7]]) as usize;
        
        info!("send_command_large_recv: tcp_magic=0x{:04X} 0x{:04X}, tcp_len={}", tcp_magic1, tcp_magic2, tcp_length);
        
        if tcp_magic1 != MACHINE_PREPARE_DATA_1 || tcp_magic2 != MACHINE_PREPARE_DATA_2 {
            return Err(format!("Invalid TCP magic: 0x{:04X} 0x{:04X}", tcp_magic1, tcp_magic2));
        }
        
        // Parse first packet's ZK header (bytes 8-15)
        let response_cmd = u16::from_le_bytes([large_buf[8], large_buf[9]]);
        let response_session = u16::from_le_bytes([large_buf[12], large_buf[13]]);
        let response_reply_id = u16::from_le_bytes([large_buf[14], large_buf[15]]);
        
        if response_session != 0 {
            self.session_id = response_session;
        }
        self.reply_id = response_reply_id;
        
        info!("  📥 Large recv: cmd={}, session={}, reply={}, total_bytes={}", 
              response_cmd, response_session, response_reply_id, bytes_read);
        
        // Return ALL data after TCP header (like pyzk's __data_recv = __tcp_data_recv[8:])
        // This includes the ZK header + data of first packet, and potentially more packets
        let all_data = large_buf[8..bytes_read].to_vec();
        
        Ok((response_cmd, all_data))
    }
    
    /// Simple read - send command directly and handle PREPARE_DATA/DATA response
    /// This is the fallback for devices that don't support buffered reads
    fn read_simple(&mut self, command: u16) -> Result<(Vec<u8>, usize), String> {
        info!("read_simple: sending command {}", command);
        
        // Send the command directly (no wrapper)
        let (cmd, data) = self.send_command(command, &[])?;
        
        info!("read_simple: response cmd={}, data_len={}", cmd, data.len());
        
        // If we get CMD_DATA directly, return it
        if cmd == CMD_DATA {
            return Ok((data.clone(), data.len()));
        }
        
        // If we get CMD_PREPARE_DATA, read the data stream
        if cmd == CMD_PREPARE_DATA {
            if data.len() >= 4 {
                let size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
                info!("read_simple: PREPARE_DATA size = {} bytes", size);
                
                if size > 0 {
                    return self.read_prepare_data_stream(size);
                }
            }
            return Ok((Vec::new(), 0));
        }
        
        // If we get CMD_ACK_OK with data, return it
        if cmd == CMD_ACK_OK && !data.is_empty() {
            return Ok((data.clone(), data.len()));
        }
        
        // Empty response
        Ok((Vec::new(), 0))
    }
    
    fn get_attendance(&mut self, users: &[User], expected_records: u32) -> Result<Vec<AttendanceRecord>, String> {
        info!("🕒 Fetching attendance logs (expecting {} records)...", expected_records);
        
        // Try simple read first (direct CMD_ATTLOG_RRQ) - this works on more devices
        info!("🕒 Trying simple read (CMD_ATTLOG_RRQ directly)...");
        let (mut data, mut size) = self.read_simple(CMD_ATTLOG_RRQ)?;
        
        // If simple read fails, try buffered read with fct=0
        if data.len() < 4 && expected_records > 0 {
            info!("🕒 Simple read empty; trying buffered read with fct=0...");
            let (data2, size2) = self.read_with_buffer_pyzk(CMD_ATTLOG_RRQ, 0)?;
            data = data2;
            size = size2;
        }
        
        // If buffered read with fct=0 fails, try fct=1
        if data.len() < 4 && expected_records > 0 {
            warn!("🕒 Buffered read with fct=0 empty; trying fct=1...");
            let (data2, size2) = self.read_with_buffer_pyzk(CMD_ATTLOG_RRQ, 1)?;
            data = data2;
            size = size2;
        }
        let mut records = Vec::new();
        
        // Save raw attendance data to file for debugging
        if !data.is_empty() {
            if let Ok(mut file) = std::fs::File::create("/tmp/zk_attendance_raw.bin") {
                use std::io::Write;
                let _ = file.write_all(&data);
                info!("💾 Saved raw attendance data to /tmp/zk_attendance_raw.bin ({} bytes)", data.len());
            }
        }
        
        info!("🕒 Attendance data: {} bytes (size={})", data.len(), size);
        
        if data.len() < 4 {
            info!("🕒 No attendance data received");
            return Ok(records);
        }
        
        // pyzk: total_size = unpack("I", attendance_data[:4])[0]
        let total_size = u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as usize;
        info!("🕒 total_size from header: {}", total_size);
        
        // pyzk: record_size = total_size // self.records
        let record_size = if expected_records > 0 && total_size > 0 {
            total_size / expected_records as usize
        } else {
            // Fallback: try common sizes
            if (data.len() - 4) % 40 == 0 {
                40
            } else if (data.len() - 4) % 16 == 0 {
                16
            } else if (data.len() - 4) % 8 == 0 {
                8
            } else {
                16 // default
            }
        };
        
        info!("🕒 record_size: {} bytes", record_size);
        
        // pyzk: attendance_data = attendance_data[4:] - skip 4-byte header
        let attendance_data = &data[4..];
        
        // Build user lookup (by uid and user_id)
        let mut user_lookup: HashMap<String, String> = HashMap::new();
        for user in users {
            user_lookup.insert(user.uid.to_string(), user.name.clone());
            user_lookup.insert(user.user_id.clone(), user.name.clone());
        }
        
        // Parse based on record size
        // pyzk handles: 8, 16, 40 byte records
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
                        .unwrap_or_else(|| format!("Unknown (ID: {})", uid));
                    
                    let dt = Self::decode_time(timestamp);
                    let event = Self::status_to_event(status);
                    
                    records.push(AttendanceRecord {
                        user_id: uid as u32,
                        user_name,
                        timestamp: dt.to_rfc3339(),
                        status,
                        punch,
                        date: dt.format("%Y-%m-%d").to_string(),
                        time: dt.format("%H:%M:%S").to_string(),
                        event: event.to_string(),
                    });
                    
                    offset += 8;
                }
            }
            16 => {
                // pyzk: user_id, timestamp, status, punch, reserved, workcode = 
                //       unpack('<I4sBB2sI', ...)
                let mut offset = 0;
                while offset + 16 <= attendance_data.len() {
                    let record = &attendance_data[offset..offset + 16];
                    
                    let user_id = u32::from_le_bytes([record[0], record[1], record[2], record[3]]);
                    let timestamp = u32::from_le_bytes([record[4], record[5], record[6], record[7]]);
                    let status = record[8];
                    let punch = record[9];
                    // reserved 2 bytes
                    // workcode 4 bytes
                    
                    let user_id_str = user_id.to_string();
                    let user_name = user_lookup
                        .get(&user_id_str)
                        .cloned()
                        .unwrap_or_else(|| format!("Unknown (ID: {})", user_id));
                    
                    let dt = Self::decode_time(timestamp);
                    let event = Self::status_to_event(status);
                    
                    records.push(AttendanceRecord {
                        user_id,
                        user_name,
                        timestamp: dt.to_rfc3339(),
                        status,
                        punch,
                        date: dt.format("%Y-%m-%d").to_string(),
                        time: dt.format("%H:%M:%S").to_string(),
                        event: event.to_string(),
                    });
                    
                    offset += 16;
                }
            }
            40 | _ => {
                // pyzk 40-byte: uid, user_id, status, timestamp, punch, space =
                //              unpack('<H24sB4sB8s', ...)
                let actual_record_size = if record_size >= 40 { 40 } else { record_size };
                let mut offset = 0;
                
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
                            .to_string();
                        
                        let user_name = if !user_id_str.is_empty() {
                            user_lookup.get(&user_id_str)
                                .or_else(|| user_lookup.get(&uid.to_string()))
                                .cloned()
                                .unwrap_or_else(|| format!("Unknown (ID: {})", user_id_str))
                        } else {
                            user_lookup.get(&uid.to_string())
                            .cloned()
                                .unwrap_or_else(|| format!("Unknown (UID: {})", uid))
                        };
                        
                        let dt = Self::decode_time(timestamp);
                        let event = Self::status_to_event(status);
                        
                        let final_user_id: u32 = user_id_str.parse().unwrap_or(uid as u32);
                        
                        records.push(AttendanceRecord {
                            user_id: final_user_id,
                            user_name,
                            timestamp: dt.to_rfc3339(),
                            status,
                            punch,
                            date: dt.format("%Y-%m-%d").to_string(),
                            time: dt.format("%H:%M:%S").to_string(),
                            event: event.to_string(),
                        });
                    }
                    
                    offset += actual_record_size;
                }
            }
        }
        
        info!("🕒 Parsed {} attendance records", records.len());
        
        // Log progress
        if records.len() > 0 && records.len() % 1000 == 0 {
            info!("🕒 Processed {} records...", records.len());
        }
        
        Ok(records)
    }
    
    /// Convert status code to event string
    fn status_to_event(status: u8) -> &'static str {
        match status {
            0 => "Check In",
            1 => "Check Out",
            2 => "Break Out",
            3 => "Break In",
            4 => "OT In",
            5 => "OT Out",
            _ => "Unknown",
        }
    }
    
    fn disconnect(&mut self) -> Result<(), String> {
        let _ = self.enable_device();
        let _ = self.send_command(CMD_EXIT, &[]);
        info!("🔌 Disconnected");
        Ok(())
    }
}

pub async fn connect_and_fetch_attendance(
    ip: &str,
    port: u16,
) -> Result<Vec<AttendanceRecord>, String> {
    let ip = ip.to_string();
    
    tokio::task::spawn_blocking(move || {
        info!("🚀 Starting connection to {}:{}", ip, port);
        
        let mut client = ZKClient::connect(&ip, port)?;
        
        // Disable device during data transfer (like pyzk does)
        if let Err(e) = client.disable_device() {
            warn!("Failed to disable device: {} (continuing anyway)", e);
        }
        
        // Read device sizes first (required before getting attendance)
        let (user_count, _finger_count, record_count) = client.read_sizes().unwrap_or((0, 0, 0));
        
        // Get users first
        let users = client.get_users().unwrap_or_else(|e| {
            warn!("Failed to get users: {} (using empty list)", e);
            Vec::new()
        });
        info!("👥 Total users: {} (device reports: {})", users.len(), user_count);
        
        // Get attendance logs
        if record_count == 0 {
            info!("🕒 Device reports 0 attendance records");
        }
        let records = client.get_attendance(&users, record_count)?;
        info!("🕒 Total attendance logs: {} (device reports: {})", records.len(), record_count);
        
        // Re-enable device and disconnect
        client.disconnect()?;
        
        Ok(records)
    })
    .await
    .map_err(|e| format!("Task error: {}", e))?
}
