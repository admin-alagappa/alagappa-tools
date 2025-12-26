use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use tokio::process::Command as TokioCommand;
use log::info;

// ============================================================================
// Common Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaInfo {
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub format: String,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bitrate: Option<u64>,
    pub codec: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionResult {
    pub success: bool,
    pub output_path: String,
    pub message: String,
    pub output_size: Option<u64>,
}

// ============================================================================
// FFmpeg Check
// ============================================================================

pub fn check_ffmpeg() -> Result<String, String> {
    let output = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map_err(|e| format!("FFmpeg not found: {}. Please install FFmpeg.", e))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        let first_line = version.lines().next().unwrap_or("Unknown");
        Ok(first_line.to_string())
    } else {
        Err("FFmpeg check failed".to_string())
    }
}

// ============================================================================
// Video Conversion
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoConvertOptions {
    pub input_path: String,
    pub output_path: String,
    pub format: String,        // mp4, webm, avi, mov, mkv
    pub quality: String,       // high, medium, low
    pub resolution: Option<String>,  // 1080p, 720p, 480p, or custom
    pub fps: Option<u32>,
}

pub async fn convert_video(options: VideoConvertOptions) -> Result<ConversionResult, String> {
    if !Path::new(&options.input_path).exists() {
        return Err(format!("Input file not found: {}", options.input_path));
    }

    info!("🎬 Converting video: {} -> {}", options.input_path, options.output_path);

    let mut cmd = TokioCommand::new("ffmpeg");
    cmd.arg("-i").arg(&options.input_path);
    cmd.arg("-y"); // Overwrite

    // Video codec based on format
    match options.format.to_lowercase().as_str() {
        "mp4" => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-c:a").arg("aac");
            cmd.arg("-movflags").arg("+faststart");
        }
        "webm" => {
            cmd.arg("-c:v").arg("libvpx-vp9");
            cmd.arg("-c:a").arg("libopus");
        }
        "avi" => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-c:a").arg("mp3");
        }
        "mov" => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-c:a").arg("aac");
        }
        "mkv" => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-c:a").arg("aac");
        }
        "gif" => {
            cmd.arg("-vf").arg("fps=10,scale=480:-1:flags=lanczos");
        }
        _ => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-c:a").arg("aac");
        }
    }

    // Quality (CRF for x264)
    if options.format != "gif" {
        let crf = match options.quality.to_lowercase().as_str() {
            "high" => "18",
            "medium" => "23",
            "low" => "28",
            _ => "23",
        };
        cmd.arg("-crf").arg(crf);
    }

    // Resolution
    if let Some(res) = &options.resolution {
        let scale = match res.as_str() {
            "1080p" => "scale=1920:1080",
            "720p" => "scale=1280:720",
            "480p" => "scale=854:480",
            "360p" => "scale=640:360",
            _ => {
                if res.contains('x') {
                    &format!("scale={}", res.replace('x', ":"))
                } else {
                    "scale=-1:-1"
                }
            }
        };
        if options.format != "gif" {
            cmd.arg("-vf").arg(scale);
        }
    }

    // Frame rate
    if let Some(fps) = options.fps {
        cmd.arg("-r").arg(fps.to_string());
    }

    cmd.arg(&options.output_path);

    let output = cmd.output().await
        .map_err(|e| format!("FFmpeg execution failed: {}", e))?;

    if output.status.success() {
        let output_size = std::fs::metadata(&options.output_path)
            .map(|m| m.len())
            .ok();
        
        info!("✅ Video converted: {}", options.output_path);
        Ok(ConversionResult {
            success: true,
            output_path: options.output_path,
            message: "Video converted successfully".to_string(),
            output_size,
        })
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Conversion failed: {}", error))
    }
}

pub async fn compress_video(
    input_path: String,
    output_path: String,
    target_bitrate: Option<String>,
) -> Result<ConversionResult, String> {
    if !Path::new(&input_path).exists() {
        return Err(format!("Input file not found: {}", input_path));
    }

    info!("📦 Compressing video: {}", input_path);

    let mut cmd = TokioCommand::new("ffmpeg");
    cmd.arg("-i").arg(&input_path);
    cmd.arg("-y");
    cmd.arg("-c:v").arg("libx264");
    cmd.arg("-c:a").arg("aac");
    
    if let Some(bitrate) = target_bitrate {
        cmd.arg("-b:v").arg(&bitrate);
    } else {
        cmd.arg("-crf").arg("28"); // Default compression
    }
    
    cmd.arg("-preset").arg("medium");
    cmd.arg(&output_path);

    let output = cmd.output().await
        .map_err(|e| format!("FFmpeg execution failed: {}", e))?;

    if output.status.success() {
        let output_size = std::fs::metadata(&output_path).map(|m| m.len()).ok();
        info!("✅ Video compressed: {}", output_path);
        Ok(ConversionResult {
            success: true,
            output_path,
            message: "Video compressed successfully".to_string(),
            output_size,
        })
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Compression failed: {}", error))
    }
}

pub async fn extract_audio(
    input_path: String,
    output_path: String,
    format: String,
) -> Result<ConversionResult, String> {
    if !Path::new(&input_path).exists() {
        return Err(format!("Input file not found: {}", input_path));
    }

    info!("🎵 Extracting audio: {} -> {}", input_path, output_path);

    let mut cmd = TokioCommand::new("ffmpeg");
    cmd.arg("-i").arg(&input_path);
    cmd.arg("-vn"); // No video
    cmd.arg("-y");

    match format.to_lowercase().as_str() {
        "mp3" => {
            cmd.arg("-acodec").arg("libmp3lame");
            cmd.arg("-ab").arg("192k");
        }
        "aac" | "m4a" => {
            cmd.arg("-acodec").arg("aac");
            cmd.arg("-ab").arg("192k");
        }
        "wav" => {
            cmd.arg("-acodec").arg("pcm_s16le");
        }
        "flac" => {
            cmd.arg("-acodec").arg("flac");
        }
        "ogg" => {
            cmd.arg("-acodec").arg("libvorbis");
        }
        _ => {
            cmd.arg("-acodec").arg("libmp3lame");
        }
    }

    cmd.arg(&output_path);

    let output = cmd.output().await
        .map_err(|e| format!("FFmpeg execution failed: {}", e))?;

    if output.status.success() {
        let output_size = std::fs::metadata(&output_path).map(|m| m.len()).ok();
        info!("✅ Audio extracted: {}", output_path);
        Ok(ConversionResult {
            success: true,
            output_path,
            message: "Audio extracted successfully".to_string(),
            output_size,
        })
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Audio extraction failed: {}", error))
    }
}

// ============================================================================
// Image Conversion
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageConvertOptions {
    pub input_path: String,
    pub output_path: String,
    pub format: String,        // jpg, png, webp, gif, bmp, tiff
    pub quality: Option<u32>,  // 1-100 for lossy formats
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub maintain_aspect: bool,
}

pub async fn convert_image(options: ImageConvertOptions) -> Result<ConversionResult, String> {
    if !Path::new(&options.input_path).exists() {
        return Err(format!("Input file not found: {}", options.input_path));
    }

    info!("🖼️ Converting image: {} -> {}", options.input_path, options.output_path);

    let mut cmd = TokioCommand::new("ffmpeg");
    cmd.arg("-i").arg(&options.input_path);
    cmd.arg("-y");

    // Build filter for resizing
    let mut filters: Vec<String> = vec![];

    if let (Some(w), Some(h)) = (options.width, options.height) {
        if options.maintain_aspect {
            filters.push(format!("scale={}:{}:force_original_aspect_ratio=decrease", w, h));
        } else {
            filters.push(format!("scale={}:{}", w, h));
        }
    } else if let Some(w) = options.width {
        filters.push(format!("scale={}:-1", w));
    } else if let Some(h) = options.height {
        filters.push(format!("scale=-1:{}", h));
    }

    if !filters.is_empty() {
        cmd.arg("-vf").arg(filters.join(","));
    }

    // Format-specific options
    match options.format.to_lowercase().as_str() {
        "jpg" | "jpeg" => {
            let q = options.quality.unwrap_or(90);
            cmd.arg("-q:v").arg(((100 - q) / 3 + 1).to_string()); // FFmpeg uses 1-31
        }
        "png" => {
            cmd.arg("-compression_level").arg("6");
        }
        "webp" => {
            let q = options.quality.unwrap_or(90);
            cmd.arg("-quality").arg(q.to_string());
        }
        "gif" => {
            // GIF specific handling
        }
        "bmp" | "tiff" | "tif" => {
            // Lossless formats
        }
        _ => {}
    }

    cmd.arg(&options.output_path);

    let output = cmd.output().await
        .map_err(|e| format!("FFmpeg execution failed: {}", e))?;

    if output.status.success() {
        let output_size = std::fs::metadata(&options.output_path).map(|m| m.len()).ok();
        info!("✅ Image converted: {}", options.output_path);
        Ok(ConversionResult {
            success: true,
            output_path: options.output_path,
            message: "Image converted successfully".to_string(),
            output_size,
        })
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Image conversion failed: {}", error))
    }
}

pub async fn compress_image(
    input_path: String,
    output_path: String,
    quality: u32,
) -> Result<ConversionResult, String> {
    let ext = Path::new(&output_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    let options = ImageConvertOptions {
        input_path,
        output_path,
        format: ext,
        quality: Some(quality),
        width: None,
        height: None,
        maintain_aspect: true,
    };

    convert_image(options).await
}

pub async fn resize_image(
    input_path: String,
    output_path: String,
    width: u32,
    height: u32,
    maintain_aspect: bool,
) -> Result<ConversionResult, String> {
    let ext = Path::new(&output_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("jpg")
        .to_lowercase();

    let options = ImageConvertOptions {
        input_path,
        output_path,
        format: ext,
        quality: Some(90),
        width: Some(width),
        height: Some(height),
        maintain_aspect,
    };

    convert_image(options).await
}

// ============================================================================
// Media Info
// ============================================================================

pub async fn get_media_info(file_path: &str) -> Result<MediaInfo, String> {
    if !Path::new(file_path).exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let output = Command::new("ffprobe")
        .arg("-v").arg("quiet")
        .arg("-print_format").arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(file_path)
        .output()
        .map_err(|e| format!("ffprobe failed: {}", e))?;

    if !output.status.success() {
        return Err("ffprobe execution failed".to_string());
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;

    let file_name = Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let format = json["format"]["format_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    let duration = json["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok());

    // Find video stream
    let streams = json["streams"].as_array();
    let video_stream = streams.and_then(|s| {
        s.iter().find(|stream| stream["codec_type"] == "video")
    });

    let (width, height, codec) = if let Some(stream) = video_stream {
        (
            stream["width"].as_u64().map(|w| w as u32),
            stream["height"].as_u64().map(|h| h as u32),
            stream["codec_name"].as_str().map(|s| s.to_string()),
        )
    } else {
        (None, None, None)
    };

    let bitrate = json["format"]["bit_rate"]
        .as_str()
        .and_then(|b| b.parse::<u64>().ok());

    Ok(MediaInfo {
        file_path: file_path.to_string(),
        file_name,
        file_size,
        format,
        duration,
        width,
        height,
        bitrate,
        codec,
    })
}
