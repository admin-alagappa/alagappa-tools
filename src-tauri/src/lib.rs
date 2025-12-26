mod device_scanner;
mod zkteco_client;
mod video_converter;
mod media_converter;
mod document_converter;
mod bundled_converter;

use device_scanner::{scan_network, BiometricDevice};
use zkteco_client::{connect_and_fetch_attendance, AttendanceResponse};
use media_converter::{
    VideoConvertOptions, ImageConvertOptions, ConversionResult, MediaInfo,
};
use document_converter::ToolStatus;

// ============================================================================
// Attendance Commands
// ============================================================================

#[tauri::command]
async fn scan_for_devices() -> Result<Vec<BiometricDevice>, String> {
    scan_network().await
}

#[tauri::command]
async fn fetch_attendance(ip: String, port: u16) -> Result<AttendanceResponse, String> {
    connect_and_fetch_attendance(&ip, port).await
}

// ============================================================================
// Media Commands - FFmpeg
// ============================================================================

#[tauri::command]
fn check_ffmpeg_status() -> Result<String, String> {
    media_converter::check_ffmpeg()
}

#[tauri::command]
async fn get_media_information(file_path: String) -> Result<MediaInfo, String> {
    media_converter::get_media_info(&file_path).await
}

// ============================================================================
// Video Commands
// ============================================================================

#[tauri::command]
async fn video_convert(options: VideoConvertOptions) -> Result<ConversionResult, String> {
    media_converter::convert_video(options).await
}

#[tauri::command]
async fn video_compress(
    input_path: String,
    output_path: String,
    target_bitrate: Option<String>,
) -> Result<ConversionResult, String> {
    media_converter::compress_video(input_path, output_path, target_bitrate).await
}

#[tauri::command]
async fn video_extract_audio(
    input_path: String,
    output_path: String,
    format: String,
) -> Result<ConversionResult, String> {
    media_converter::extract_audio(input_path, output_path, format).await
}

// ============================================================================
// Image Commands
// ============================================================================

#[tauri::command]
async fn image_convert(options: ImageConvertOptions) -> Result<ConversionResult, String> {
    media_converter::convert_image(options).await
}

#[tauri::command]
async fn image_compress(
    input_path: String,
    output_path: String,
    quality: u32,
) -> Result<ConversionResult, String> {
    media_converter::compress_image(input_path, output_path, quality).await
}

#[tauri::command]
async fn image_resize(
    input_path: String,
    output_path: String,
    width: u32,
    height: u32,
    maintain_aspect: bool,
) -> Result<ConversionResult, String> {
    media_converter::resize_image(input_path, output_path, width, height, maintain_aspect).await
}

// ============================================================================
// Document Commands (External tools - optional)
// ============================================================================

#[tauri::command]
fn check_document_tools() -> Vec<ToolStatus> {
    document_converter::check_tools()
}

#[tauri::command]
async fn document_convert_office(
    input_path: String,
    output_format: String,
    output_dir: String,
) -> Result<document_converter::ConversionResult, String> {
    document_converter::convert_with_libreoffice(input_path, output_format, output_dir).await
}

#[tauri::command]
async fn document_convert_pandoc(
    input_path: String,
    output_path: String,
    from_format: Option<String>,
    to_format: Option<String>,
) -> Result<document_converter::ConversionResult, String> {
    document_converter::convert_with_pandoc(input_path, output_path, from_format, to_format).await
}

// ============================================================================
// Bundled Document Commands (No external dependencies!)
// ============================================================================

#[tauri::command]
fn bundled_get_doc_info(file_path: String) -> Result<bundled_converter::DocumentInfo, String> {
    bundled_converter::get_document_info(&file_path)
}

#[tauri::command]
fn bundled_merge_pdfs(
    input_paths: Vec<String>,
    output_path: String,
) -> Result<bundled_converter::ConversionResult, String> {
    bundled_converter::merge_pdfs(input_paths, output_path)
}

#[tauri::command]
fn bundled_excel_to_csv(
    input_path: String,
    output_path: String,
    sheet_index: Option<usize>,
) -> Result<bundled_converter::ConversionResult, String> {
    bundled_converter::excel_to_csv(input_path, output_path, sheet_index)
}

#[tauri::command]
fn bundled_csv_to_json(
    input_path: String,
    output_path: String,
) -> Result<bundled_converter::ConversionResult, String> {
    bundled_converter::csv_to_json(input_path, output_path)
}

#[tauri::command]
fn bundled_json_to_csv(
    input_path: String,
    output_path: String,
) -> Result<bundled_converter::ConversionResult, String> {
    bundled_converter::json_to_csv(input_path, output_path)
}

#[tauri::command]
fn bundled_convert_image(
    input_path: String,
    output_path: String,
    quality: Option<u8>,
) -> Result<bundled_converter::ConversionResult, String> {
    bundled_converter::convert_image_format(input_path, output_path, quality)
}

#[tauri::command]
fn bundled_resize_image(
    input_path: String,
    output_path: String,
    width: u32,
    height: u32,
    maintain_aspect: bool,
) -> Result<bundled_converter::ConversionResult, String> {
    bundled_converter::resize_image(input_path, output_path, width, height, maintain_aspect)
}

// ============================================================================
// App Entry Point
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();
    
    log::info!("🚀 Starting Alagappa Tools application");
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // Attendance
            scan_for_devices,
            fetch_attendance,
            // Media (FFmpeg)
            check_ffmpeg_status,
            get_media_information,
            // Video (FFmpeg)
            video_convert,
            video_compress,
            video_extract_audio,
            // Image (FFmpeg)
            image_convert,
            image_compress,
            image_resize,
            // Document (external tools - optional)
            check_document_tools,
            document_convert_office,
            document_convert_pandoc,
            // Bundled (no external deps!)
            bundled_get_doc_info,
            bundled_merge_pdfs,
            bundled_excel_to_csv,
            bundled_csv_to_json,
            bundled_json_to_csv,
            bundled_convert_image,
            bundled_resize_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
