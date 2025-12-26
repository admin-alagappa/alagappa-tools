use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use tokio::process::Command as TokioCommand;
use log::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentInfo {
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub extension: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionResult {
    pub success: bool,
    pub output_path: String,
    pub message: String,
    pub output_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
}

// Check available conversion tools
pub fn check_tools() -> Vec<ToolStatus> {
    let mut tools = Vec::new();
    
    // Check LibreOffice (soffice)
    let soffice = check_command("soffice", &["--version"]);
    tools.push(ToolStatus {
        name: "LibreOffice".to_string(),
        available: soffice.is_some(),
        version: soffice,
    });
    
    // Check Pandoc
    let pandoc = check_command("pandoc", &["--version"]);
    tools.push(ToolStatus {
        name: "Pandoc".to_string(),
        available: pandoc.is_some(),
        version: pandoc.map(|v| v.lines().next().unwrap_or("").to_string()),
    });
    
    // Check wkhtmltopdf
    let wkhtmltopdf = check_command("wkhtmltopdf", &["--version"]);
    tools.push(ToolStatus {
        name: "wkhtmltopdf".to_string(),
        available: wkhtmltopdf.is_some(),
        version: wkhtmltopdf,
    });
    
    // Check FFmpeg (for PDF to image)
    let ffmpeg = check_command("ffmpeg", &["-version"]);
    tools.push(ToolStatus {
        name: "FFmpeg".to_string(),
        available: ffmpeg.is_some(),
        version: ffmpeg.map(|v| v.lines().next().unwrap_or("").to_string()),
    });
    
    tools
}

fn check_command(cmd: &str, args: &[&str]) -> Option<String> {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

// Convert document using LibreOffice
pub async fn convert_with_libreoffice(
    input_path: String,
    output_format: String,
    output_dir: String,
) -> Result<ConversionResult, String> {
    if !Path::new(&input_path).exists() {
        return Err(format!("File not found: {}", input_path));
    }

    info!("📄 Converting with LibreOffice: {} -> {}", input_path, output_format);

    let mut cmd = TokioCommand::new("soffice");
    cmd.arg("--headless");
    cmd.arg("--convert-to").arg(&output_format);
    cmd.arg("--outdir").arg(&output_dir);
    cmd.arg(&input_path);

    let output = cmd.output().await
        .map_err(|e| format!("Failed to run LibreOffice: {}", e))?;

    if output.status.success() {
        // Determine output filename
        let input_name = Path::new(&input_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("output");
        let output_path = format!("{}/{}.{}", output_dir, input_name, output_format);
        
        let output_size = std::fs::metadata(&output_path).map(|m| m.len()).ok();
        
        info!("✅ Document converted: {}", output_path);
        Ok(ConversionResult {
            success: true,
            output_path,
            message: "Document converted successfully".to_string(),
            output_size,
        })
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Conversion failed: {}", error))
    }
}

// Convert with Pandoc (markdown, text, html, etc.)
pub async fn convert_with_pandoc(
    input_path: String,
    output_path: String,
    from_format: Option<String>,
    to_format: Option<String>,
) -> Result<ConversionResult, String> {
    if !Path::new(&input_path).exists() {
        return Err(format!("File not found: {}", input_path));
    }

    info!("📄 Converting with Pandoc: {} -> {}", input_path, output_path);

    let mut cmd = TokioCommand::new("pandoc");
    cmd.arg(&input_path);
    cmd.arg("-o").arg(&output_path);
    
    if let Some(from) = from_format {
        cmd.arg("-f").arg(from);
    }
    if let Some(to) = to_format {
        cmd.arg("-t").arg(to);
    }
    
    // Enable smart quotes and other niceties
    cmd.arg("--standalone");

    let output = cmd.output().await
        .map_err(|e| format!("Failed to run Pandoc: {}", e))?;

    if output.status.success() {
        let output_size = std::fs::metadata(&output_path).map(|m| m.len()).ok();
        
        info!("✅ Document converted: {}", output_path);
        Ok(ConversionResult {
            success: true,
            output_path,
            message: "Document converted successfully".to_string(),
            output_size,
        })
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Conversion failed: {}", error))
    }
}

// Convert HTML to PDF using wkhtmltopdf
pub async fn html_to_pdf(
    input_path: String,
    output_path: String,
) -> Result<ConversionResult, String> {
    if !Path::new(&input_path).exists() {
        return Err(format!("File not found: {}", input_path));
    }

    info!("📄 Converting HTML to PDF: {}", input_path);

    let mut cmd = TokioCommand::new("wkhtmltopdf");
    cmd.arg("--quiet");
    cmd.arg(&input_path);
    cmd.arg(&output_path);

    let output = cmd.output().await
        .map_err(|e| format!("Failed to run wkhtmltopdf: {}", e))?;

    if output.status.success() {
        let output_size = std::fs::metadata(&output_path).map(|m| m.len()).ok();
        
        Ok(ConversionResult {
            success: true,
            output_path,
            message: "HTML converted to PDF successfully".to_string(),
            output_size,
        })
    } else {
        let error = String::from_utf8_lossy(&output.stderr);
        Err(format!("Conversion failed: {}", error))
    }
}

// Merge multiple PDFs (requires pdftk or qpdf)
pub async fn merge_pdfs(
    input_paths: Vec<String>,
    output_path: String,
) -> Result<ConversionResult, String> {
    if input_paths.is_empty() {
        return Err("No input files provided".to_string());
    }

    for path in &input_paths {
        if !Path::new(path).exists() {
            return Err(format!("File not found: {}", path));
        }
    }

    info!("📄 Merging {} PDFs", input_paths.len());

    // Try qpdf first (more commonly available on macOS)
    let mut cmd = TokioCommand::new("qpdf");
    cmd.arg("--empty");
    cmd.arg("--pages");
    for path in &input_paths {
        cmd.arg(path);
    }
    cmd.arg("--");
    cmd.arg(&output_path);

    let output = cmd.output().await;
    
    match output {
        Ok(o) if o.status.success() => {
            let output_size = std::fs::metadata(&output_path).map(|m| m.len()).ok();
            return Ok(ConversionResult {
                success: true,
                output_path,
                message: format!("Merged {} PDFs successfully", input_paths.len()),
                output_size,
            });
        }
        _ => {
            // Try pdftk as fallback
            let mut cmd = TokioCommand::new("pdftk");
            for path in &input_paths {
                cmd.arg(path);
            }
            cmd.arg("cat");
            cmd.arg("output").arg(&output_path);

            let output = cmd.output().await
                .map_err(|e| format!("No PDF tools available (qpdf or pdftk): {}", e))?;

            if output.status.success() {
                let output_size = std::fs::metadata(&output_path).map(|m| m.len()).ok();
                Ok(ConversionResult {
                    success: true,
                    output_path,
                    message: format!("Merged {} PDFs successfully", input_paths.len()),
                    output_size,
                })
            } else {
                let error = String::from_utf8_lossy(&output.stderr);
                Err(format!("PDF merge failed: {}", error))
            }
        }
    }
}

// Get document info
pub fn get_document_info(file_path: &str) -> Result<DocumentInfo, String> {
    let path = Path::new(file_path);
    
    if !path.exists() {
        return Err(format!("File not found: {}", file_path));
    }

    let file_name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();

    let extension = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(DocumentInfo {
        file_path: file_path.to_string(),
        file_name,
        file_size,
        extension,
    })
}
