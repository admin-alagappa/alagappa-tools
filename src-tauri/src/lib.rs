mod device_scanner;
mod zkteco_client;
mod video_converter;

use device_scanner::{scan_network, BiometricDevice};
use zkteco_client::{connect_and_fetch_attendance, AttendanceRecord};
use video_converter::{
    check_ffmpeg_available, convert_video, compress_video, extract_audio, get_video_info,
    VideoConversionOptions,
};

#[tauri::command]
async fn scan_for_devices() -> Result<Vec<BiometricDevice>, String> {
    scan_network().await
}

#[tauri::command]
async fn fetch_attendance(
    ip: String,
    port: u16,
) -> Result<Vec<AttendanceRecord>, String> {
    connect_and_fetch_attendance(&ip, port).await
}

// Video conversion commands
#[tauri::command]
async fn check_ffmpeg() -> Result<String, String> {
    check_ffmpeg_available()
}

#[tauri::command]
async fn get_video_information(input_path: String) -> Result<serde_json::Value, String> {
    get_video_info(&input_path).await
}

#[tauri::command]
async fn convert_video_format(options: VideoConversionOptions) -> Result<String, String> {
    convert_video(options).await
}

#[tauri::command]
async fn compress_video_file(
    input_path: String,
    output_path: String,
    target_size_mb: Option<f32>,
) -> Result<String, String> {
    compress_video(input_path, output_path, target_size_mb).await
}

#[tauri::command]
async fn extract_audio_from_video(
    input_path: String,
    output_path: String,
    audio_format: String,
) -> Result<String, String> {
    extract_audio(input_path, output_path, audio_format).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize logger
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();
    
    log::info!("🚀 Starting Alagappa Tools application");
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_for_devices,
            fetch_attendance,
            check_ffmpeg,
            get_video_information,
            convert_video_format,
            compress_video_file,
            extract_audio_from_video,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
