use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use std::sync::Arc;
use log::{info, warn};
use crate::zkteco_client::get_device_info_quick;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiometricDevice {
    pub ip: String,
    pub mac: String,
    pub open_ports: Vec<u16>,
    pub device_name: Option<String>,
    pub firmware_version: Option<String>,
    pub serial_number: Option<String>,
}

// Common ports for biometric/time-attendance devices
// ZKTeco protocol ports
const ZKTECO_PORTS: &[u16] = &[4370, 4360, 5005, 5010, 89];
// Web/service ports
const OTHER_PORTS: &[u16] = &[80, 8080, 443, 8443];

// Max concurrent connections for scanning
const MAX_CONCURRENT: usize = 100;

fn get_local_ip() -> Result<Ipv4Addr, String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("Failed to bind socket: {}", e))?;
    
    socket
        .connect("8.8.8.8:80")
        .map_err(|e| format!("Failed to connect: {}", e))?;
    
    let local_addr = socket
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?;
    
    match local_addr.ip() {
        IpAddr::V4(ip) => Ok(ip),
        IpAddr::V6(_) => Err("IPv6 not supported".to_string()),
    }
}

async fn check_port(ip: &str, port: u16, timeout_ms: u64) -> bool {
    let addr = format!("{}:{}", ip, port);
    match tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        TcpStream::connect(&addr),
    )
    .await
    {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

/// Check if IP has biometric port open (fast check)
async fn check_biometric_ip(ip: String, semaphore: Arc<Semaphore>) -> Option<BiometricDevice> {
    let _permit = semaphore.acquire().await.ok()?;
    
    // Check all ZKTeco ports to find the main one
    let mut main_port: Option<u16> = None;
    for port in ZKTECO_PORTS {
        if check_port(&ip, *port, 300).await {
            main_port = Some(*port);
            break;
        }
    }
    
    if let Some(port) = main_port {
        let mut open_ports = vec![port];
        
        // Check all other ZKTeco ports
        for p in ZKTECO_PORTS {
            if *p != port && check_port(&ip, *p, 200).await {
                open_ports.push(*p);
            }
        }
        
        // Check web/service ports
        for p in OTHER_PORTS {
            if check_port(&ip, *p, 200).await {
                open_ports.push(*p);
            }
        }
        
        // Sort ports for consistent display
        open_ports.sort();
        
        // Fetch device info
        let device_info = get_device_info_quick(&ip, port).await;
        
        return Some(BiometricDevice {
            ip,
            mac: "Unknown".to_string(),
            open_ports,
            device_name: device_info.as_ref().map(|d| d.device_name.clone()).filter(|s| !s.is_empty()),
            firmware_version: device_info.as_ref().map(|d| d.firmware_version.clone()).filter(|s| !s.is_empty()),
            serial_number: device_info.as_ref().map(|d| d.serial_number.clone()).filter(|s| !s.is_empty()),
        });
    }
    
    None
}

// Common subnets to scan (in addition to local subnet)
const COMMON_SUBNETS: &[(u8, u8, u8)] = &[
    (192, 168, 1),
    (192, 168, 0),
    (192, 168, 2),
    (10, 0, 0),
    (10, 0, 1),
    (172, 16, 0),
];

pub async fn scan_network() -> Result<Vec<BiometricDevice>, String> {
    let local_ip = get_local_ip()?;
    let local_parts: Vec<u8> = local_ip.octets().to_vec();
    
    // Build list of subnets to scan
    let mut subnets_to_scan: Vec<(u8, u8, u8)> = vec![
        (local_parts[0], local_parts[1], local_parts[2])
    ];
    
    // Add common subnets if not already included
    for subnet in COMMON_SUBNETS {
        if !subnets_to_scan.contains(subnet) {
            subnets_to_scan.push(*subnet);
        }
    }
    
    info!("🔍 Scanning {} subnets: local + common", subnets_to_scan.len());
    
    // Create semaphore for concurrent connections
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    
    // Spawn tasks for all IPs in all subnets
    let mut handles = Vec::new();
    
    for (a, b, c) in &subnets_to_scan {
        for i in 1..255u8 {
            let ip = format!("{}.{}.{}.{}", a, b, c, i);
            let sem = Arc::clone(&semaphore);
            
            let handle = tokio::spawn(async move {
                check_biometric_ip(ip, sem).await
            });
            handles.push(handle);
        }
    }
    
    info!("🔍 Checking {} IPs...", handles.len());
    
    // Collect results
    let mut biometric_devices = Vec::new();
    
    for handle in handles {
        if let Ok(Some(device)) = handle.await {
            info!("✅ Found: {}", device.ip);
            biometric_devices.push(device);
        }
    }
    
    if !biometric_devices.is_empty() {
        info!("✅ Found {} device(s)", biometric_devices.len());
    } else {
        warn!("🚫 No biometric devices found");
    }
    
    Ok(biometric_devices)
}
