use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::Path;
use tokio::process::Command as TokioCommand;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoConversionOptions {
    pub input_path: String,
    pub output_path: String,
    pub output_format: String, // mp4, avi, mov, mkv, etc.
    pub quality: Option<String>, // high, medium, low, or specific bitrate
    pub resolution: Option<String>, // 1080p, 720p, 480p, or custom like "1920x1080"
    pub bitrate: Option<String>, // e.g., "2000k"
    pub frame_rate: Option<f32>, // e.g., 30.0, 24.0, 60.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ConversionProgress {
    pub percentage: f32,
    pub status: String,
    pub current_time: Option<String>,
    pub total_time: Option<String>,
}

// Check if FFmpeg is available on the system
pub fn check_ffmpeg_available() -> Result<String, String> {
    let output = Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map_err(|e| format!("FFmpeg not found: {}. Please install FFmpeg first.", e))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        Ok(format!("FFmpeg available: {}", version.lines().next().unwrap_or("Unknown version")))
    } else {
        Err("FFmpeg command failed".to_string())
    }
}

// Get video file information
pub async fn get_video_info(input_path: &str) -> Result<serde_json::Value, String> {
    let output = Command::new("ffprobe")
        .arg("-v")
        .arg("quiet")
        .arg("-print_format")
        .arg("json")
        .arg("-show_format")
        .arg("-show_streams")
        .arg(input_path)
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe error: {}", error));
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse video info: {}", e))
}

// Convert video format
pub async fn convert_video(options: VideoConversionOptions) -> Result<String, String> {
    // Validate input file exists
    if !Path::new(&options.input_path).exists() {
        return Err(format!("Input file not found: {}", options.input_path));
    }

    // Build FFmpeg command
    let mut cmd = TokioCommand::new("ffmpeg");
    
    // Input file
    cmd.arg("-i").arg(&options.input_path);
    
    // Overwrite output file if exists
    cmd.arg("-y");
    
    // Video codec based on output format
    match options.output_format.to_lowercase().as_str() {
        "mp4" => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-c:a").arg("aac");
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
            cmd.arg("-c:a").arg("copy");
        }
        _ => {
            cmd.arg("-c:v").arg("libx264");
            cmd.arg("-c:a").arg("aac");
        }
    }
    
    // Quality settings
    if let Some(quality) = &options.quality {
        match quality.to_lowercase().as_str() {
            "high" => {
                cmd.arg("-crf").arg("18");
            }
            "medium" => {
                cmd.arg("-crf").arg("23");
            }
            "low" => {
                cmd.arg("-crf").arg("28");
            }
            _ => {
                // Assume it's a CRF value
                cmd.arg("-crf").arg(quality);
            }
        }
    } else {
        cmd.arg("-crf").arg("23"); // Default medium quality
    }
    
    // Resolution
    if let Some(resolution) = &options.resolution {
        let scale_value = match resolution.to_lowercase().as_str() {
            "1080p" => "scale=1920:1080".to_string(),
            "720p" => "scale=1280:720".to_string(),
            "480p" => "scale=854:480".to_string(),
            "360p" => "scale=640:360".to_string(),
            _ => {
                // Custom resolution - assume format like "1920x1080"
                if resolution.contains('x') {
                    format!("scale={}", resolution)
                } else {
                    format!("scale={}", resolution)
                }
            }
        };
        cmd.arg("-vf").arg(scale_value);
    }
    
    // Bitrate
    if let Some(bitrate) = &options.bitrate {
        cmd.arg("-b:v").arg(bitrate);
    }
    
    // Frame rate
    if let Some(frame_rate) = options.frame_rate {
        cmd.arg("-r").arg(&frame_rate.to_string());
    }
    
    // Output file
    cmd.arg(&options.output_path);
    
    // Execute conversion
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?;
    
    if output.status.success() {
        Ok(format!("Video converted successfully: {}", options.output_path))
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("FFmpeg conversion failed: {}", error))
    }
}

// Compress video (reduce file size)
pub async fn compress_video(
    input_path: String,
    output_path: String,
    target_size_mb: Option<f32>,
) -> Result<String, String> {
    let options = VideoConversionOptions {
        input_path,
        output_path,
        output_format: "mp4".to_string(),
        quality: Some("medium".to_string()),
        resolution: None,
        bitrate: target_size_mb.map(|size| format!("{}k", (size * 1000.0) as u32)),
        frame_rate: None,
    };
    
    convert_video(options).await
}

// Extract audio from video
pub async fn extract_audio(
    input_path: String,
    output_path: String,
    audio_format: String, // mp3, aac, wav, etc.
) -> Result<String, String> {
    if !Path::new(&input_path).exists() {
        return Err(format!("Input file not found: {}", input_path));
    }
    
    let mut cmd = TokioCommand::new("ffmpeg");
    cmd.arg("-i").arg(&input_path);
    cmd.arg("-vn"); // No video
    cmd.arg("-y"); // Overwrite
    
    match audio_format.to_lowercase().as_str() {
        "mp3" => {
            cmd.arg("-acodec").arg("libmp3lame");
        }
        "aac" => {
            cmd.arg("-acodec").arg("aac");
        }
        "wav" => {
            cmd.arg("-acodec").arg("pcm_s16le");
        }
        "flac" => {
            cmd.arg("-acodec").arg("flac");
        }
        _ => {
            cmd.arg("-acodec").arg("libmp3lame");
        }
    }
    
    cmd.arg(&output_path);
    
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?;
    
    if output.status.success() {
        Ok(format!("Audio extracted successfully: {}", output_path))
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Audio extraction failed: {}", error))
    }
}

