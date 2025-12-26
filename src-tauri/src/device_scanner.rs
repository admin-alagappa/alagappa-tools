use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use std::sync::Arc;
use log::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiometricDevice {
    pub ip: String,
    pub mac: String,
    pub open_ports: Vec<u16>,
}

// Common ports for biometric/time-attendance devices
// Port 4370 is the main ZKTeco protocol port
#[allow(dead_code)]
const BIOMETRIC_PORTS: &[u16] = &[4370, 4360];
const OTHER_PORTS: &[u16] = &[80, 8080];

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
    
    // First check the main ZKTeco port (4370)
    if check_port(&ip, 4370, 300).await {
        let mut open_ports = vec![4370];
        
        // Check other ports
        for port in OTHER_PORTS {
            if check_port(&ip, *port, 200).await {
                open_ports.push(*port);
            }
        }
        
        // Check secondary biometric port
        if check_port(&ip, 4360, 200).await {
            open_ports.push(4360);
        }
        
        return Some(BiometricDevice {
            ip,
            mac: "Unknown".to_string(),
            open_ports,
        });
    }
    
    // Check secondary port 4360
    if check_port(&ip, 4360, 300).await {
        return Some(BiometricDevice {
            ip,
            mac: "Unknown".to_string(),
            open_ports: vec![4360],
        });
    }
    
    None
}

pub async fn scan_network() -> Result<Vec<BiometricDevice>, String> {
    let local_ip = get_local_ip()?;
    let network = format!("{}/24", local_ip);
    
    info!("🌐 Scanning network: {}", network);
    info!("🔍 Looking for ZKTeco devices on port 4370...");
    
    let parts: Vec<u8> = local_ip.octets().to_vec();
    
    // Create semaphore for concurrent connections
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    
    // Spawn tasks for all IPs in parallel
    let mut handles = Vec::new();
    
    for i in 1..255u8 {
        let ip = format!("{}.{}.{}.{}", parts[0], parts[1], parts[2], i);
        let sem = Arc::clone(&semaphore);
        
        let handle = tokio::spawn(async move {
            check_biometric_ip(ip, sem).await
        });
        handles.push(handle);
    }
    
    // Collect results
    let mut biometric_devices = Vec::new();
    
    for handle in handles {
        if let Ok(Some(device)) = handle.await {
            info!("✅ Found biometric device at {} (ports: {:?})", device.ip, device.open_ports);
            biometric_devices.push(device);
        }
    }
    
    info!("📋 Scan complete:");
    if !biometric_devices.is_empty() {
        info!("🎯 Found {} biometric device(s)", biometric_devices.len());
        for device in &biometric_devices {
            info!("   {} → ports {:?}", device.ip, device.open_ports);
        }
    } else {
        warn!("🚫 No biometric devices found on this network");
        warn!("   Tip: Use 'Direct Connection' if you know the device IP");
    }
    
    Ok(biometric_devices)
}
