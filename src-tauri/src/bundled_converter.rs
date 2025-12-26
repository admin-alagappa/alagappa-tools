//! Bundled document converter - no external dependencies required
//! Uses pure Rust libraries that are compiled into the app

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::fs;
use std::io::BufReader;
use log::info;
use lopdf::Document as PdfDocument;
use calamine::{Reader, open_workbook, Xlsx, Xls, Ods};
use image::ImageFormat;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionResult {
    pub success: bool,
    pub output_path: String,
    pub message: String,
    pub output_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentInfo {
    pub file_path: String,
    pub file_name: String,
    pub file_size: u64,
    pub extension: String,
    pub page_count: Option<usize>,
    pub sheet_names: Option<Vec<String>>,
}

// ============================================================================
// PDF Operations (using lopdf - bundled)
// ============================================================================

/// Merge multiple PDF files into one
pub fn merge_pdfs(input_paths: Vec<String>, output_path: String) -> Result<ConversionResult, String> {
    if input_paths.len() < 2 {
        return Err("Need at least 2 PDFs to merge".to_string());
    }

    info!("📄 Merging {} PDFs (bundled)", input_paths.len());

    // Load first document as base
    let first_path = &input_paths[0];
    let mut merged = PdfDocument::load(first_path)
        .map_err(|e| format!("Failed to load {}: {}", first_path, e))?;

    // Merge remaining documents
    for path in input_paths.iter().skip(1) {
        let doc = PdfDocument::load(path)
            .map_err(|e| format!("Failed to load {}: {}", path, e))?;
        
        // Get pages from source document and add to merged
        let pages = doc.get_pages();
        for (_page_num, page_id) in pages {
            if let Ok(page_content) = doc.get_page_content(page_id) {
                // Simple merge - copy page references
                let _ = merged.add_object(lopdf::Object::Stream(
                    lopdf::Stream::new(lopdf::dictionary! {}, page_content)
                ));
            }
        }
    }

    // Save merged document
    merged.save(&output_path)
        .map_err(|e| format!("Failed to save merged PDF: {}", e))?;

    let output_size = fs::metadata(&output_path).map(|m| m.len()).ok();
    
    info!("✅ PDFs merged: {}", output_path);
    Ok(ConversionResult {
        success: true,
        output_path,
        message: format!("Successfully merged {} PDFs", input_paths.len()),
        output_size,
    })
}

/// Get PDF page count
pub fn get_pdf_info(file_path: &str) -> Result<usize, String> {
    let doc = PdfDocument::load(file_path)
        .map_err(|e| format!("Failed to load PDF: {}", e))?;
    Ok(doc.get_pages().len())
}

/// Extract text from PDF (basic)
#[allow(dead_code)]
pub fn pdf_to_text(input_path: String, output_path: String) -> Result<ConversionResult, String> {
    info!("📄 Extracting text from PDF (bundled)");

    let doc = PdfDocument::load(&input_path)
        .map_err(|e| format!("Failed to load PDF: {}", e))?;

    let mut text = String::new();
    let pages = doc.get_pages();
    
    for (page_num, page_id) in pages {
        if let Ok(content) = doc.get_page_content(page_id) {
            // Basic text extraction - lopdf gives raw content
            // This is simplified and may not work for all PDFs
            let content_str = String::from_utf8_lossy(&content);
            text.push_str(&format!("--- Page {} ---\n", page_num));
            text.push_str(&content_str);
            text.push_str("\n\n");
        }
    }

    fs::write(&output_path, &text)
        .map_err(|e| format!("Failed to write text file: {}", e))?;

    let output_size = fs::metadata(&output_path).map(|m| m.len()).ok();

    Ok(ConversionResult {
        success: true,
        output_path,
        message: "Text extracted from PDF".to_string(),
        output_size,
    })
}

// ============================================================================
// Excel/Spreadsheet Operations (using calamine - bundled)
// ============================================================================

/// Convert Excel to CSV
pub fn excel_to_csv(input_path: String, output_path: String, sheet_index: Option<usize>) -> Result<ConversionResult, String> {
    info!("📊 Converting Excel to CSV (bundled)");

    let ext = Path::new(&input_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let sheet_data: Vec<Vec<String>> = match ext.as_str() {
        "xlsx" => {
            let mut workbook: Xlsx<_> = open_workbook(&input_path)
                .map_err(|e| format!("Failed to open Excel file: {}", e))?;
            extract_sheet_data(&mut workbook, sheet_index)?
        }
        "xls" => {
            let mut workbook: Xls<_> = open_workbook(&input_path)
                .map_err(|e| format!("Failed to open Excel file: {}", e))?;
            extract_sheet_data(&mut workbook, sheet_index)?
        }
        "ods" => {
            let mut workbook: Ods<_> = open_workbook(&input_path)
                .map_err(|e| format!("Failed to open ODS file: {}", e))?;
            extract_sheet_data(&mut workbook, sheet_index)?
        }
        _ => return Err(format!("Unsupported format: {}", ext)),
    };

    // Write to CSV
    let mut wtr = csv::Writer::from_path(&output_path)
        .map_err(|e| format!("Failed to create CSV: {}", e))?;

    for row in sheet_data {
        wtr.write_record(&row)
            .map_err(|e| format!("Failed to write row: {}", e))?;
    }

    wtr.flush().map_err(|e| format!("Failed to flush CSV: {}", e))?;

    let output_size = fs::metadata(&output_path).map(|m| m.len()).ok();

    info!("✅ Excel converted to CSV: {}", output_path);
    Ok(ConversionResult {
        success: true,
        output_path,
        message: "Excel converted to CSV".to_string(),
        output_size,
    })
}

fn extract_sheet_data<R: Reader<BufReader<std::fs::File>>>(
    workbook: &mut R,
    sheet_index: Option<usize>,
) -> Result<Vec<Vec<String>>, String> {
    let sheets = workbook.sheet_names().to_owned();
    if sheets.is_empty() {
        return Err("No sheets found in workbook".to_string());
    }

    let sheet_name = sheets.get(sheet_index.unwrap_or(0))
        .ok_or("Sheet not found")?
        .clone();

    let range = workbook.worksheet_range(&sheet_name)
        .map_err(|e| format!("Failed to read sheet: {:?}", e))?;

    let mut data = Vec::new();
    for row in range.rows() {
        let row_data: Vec<String> = row.iter()
            .map(|cell| cell.to_string())
            .collect();
        data.push(row_data);
    }

    Ok(data)
}

/// Get Excel sheet names
pub fn get_excel_sheets(file_path: &str) -> Result<Vec<String>, String> {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let sheets = match ext.as_str() {
        "xlsx" => {
            let workbook: Xlsx<_> = open_workbook(file_path)
                .map_err(|e| format!("Failed to open: {}", e))?;
            workbook.sheet_names().to_vec()
        }
        "xls" => {
            let workbook: Xls<_> = open_workbook(file_path)
                .map_err(|e| format!("Failed to open: {}", e))?;
            workbook.sheet_names().to_vec()
        }
        "ods" => {
            let workbook: Ods<_> = open_workbook(file_path)
                .map_err(|e| format!("Failed to open: {}", e))?;
            workbook.sheet_names().to_vec()
        }
        _ => return Err(format!("Unsupported format: {}", ext)),
    };

    Ok(sheets)
}

// ============================================================================
// Image Operations (using image crate - bundled)
// ============================================================================

/// Convert image format
pub fn convert_image_format(
    input_path: String,
    output_path: String,
    quality: Option<u8>,
) -> Result<ConversionResult, String> {
    info!("🖼️ Converting image (bundled)");

    let img = image::open(&input_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    let output_ext = Path::new(&output_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let format = match output_ext.as_str() {
        "jpg" | "jpeg" => ImageFormat::Jpeg,
        "png" => ImageFormat::Png,
        "gif" => ImageFormat::Gif,
        "bmp" => ImageFormat::Bmp,
        "webp" => ImageFormat::WebP,
        "tiff" | "tif" => ImageFormat::Tiff,
        "ico" => ImageFormat::Ico,
        _ => return Err(format!("Unsupported output format: {}", output_ext)),
    };

    // For JPEG, use quality setting
    if format == ImageFormat::Jpeg {
        let q = quality.unwrap_or(90);
        let mut output_file = fs::File::create(&output_path)
            .map_err(|e| format!("Failed to create output: {}", e))?;
        
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output_file, q);
        encoder.encode_image(&img)
            .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
    } else {
        img.save_with_format(&output_path, format)
            .map_err(|e| format!("Failed to save image: {}", e))?;
    }

    let output_size = fs::metadata(&output_path).map(|m| m.len()).ok();

    info!("✅ Image converted: {}", output_path);
    Ok(ConversionResult {
        success: true,
        output_path,
        message: "Image converted successfully".to_string(),
        output_size,
    })
}

/// Resize image
pub fn resize_image(
    input_path: String,
    output_path: String,
    width: u32,
    height: u32,
    maintain_aspect: bool,
) -> Result<ConversionResult, String> {
    info!("🖼️ Resizing image (bundled)");

    let img = image::open(&input_path)
        .map_err(|e| format!("Failed to open image: {}", e))?;

    let resized = if maintain_aspect {
        img.resize(width, height, image::imageops::FilterType::Lanczos3)
    } else {
        img.resize_exact(width, height, image::imageops::FilterType::Lanczos3)
    };

    resized.save(&output_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    let output_size = fs::metadata(&output_path).map(|m| m.len()).ok();

    Ok(ConversionResult {
        success: true,
        output_path,
        message: format!("Image resized to {}x{}", resized.width(), resized.height()),
        output_size,
    })
}

// ============================================================================
// CSV Operations
// ============================================================================

/// Convert CSV to JSON
pub fn csv_to_json(input_path: String, output_path: String) -> Result<ConversionResult, String> {
    info!("📊 Converting CSV to JSON (bundled)");

    let mut rdr = csv::Reader::from_path(&input_path)
        .map_err(|e| format!("Failed to open CSV: {}", e))?;

    let headers: Vec<String> = rdr.headers()
        .map_err(|e| format!("Failed to read headers: {}", e))?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let mut records: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();

    for result in rdr.records() {
        let record = result.map_err(|e| format!("Failed to read record: {}", e))?;
        let mut obj = serde_json::Map::new();
        
        for (i, field) in record.iter().enumerate() {
            if let Some(key) = headers.get(i) {
                obj.insert(key.clone(), serde_json::Value::String(field.to_string()));
            }
        }
        records.push(obj);
    }

    let json = serde_json::to_string_pretty(&records)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))?;

    fs::write(&output_path, json)
        .map_err(|e| format!("Failed to write JSON: {}", e))?;

    let output_size = fs::metadata(&output_path).map(|m| m.len()).ok();

    Ok(ConversionResult {
        success: true,
        output_path,
        message: format!("Converted {} records to JSON", records.len()),
        output_size,
    })
}

/// Convert JSON array to CSV
pub fn json_to_csv(input_path: String, output_path: String) -> Result<ConversionResult, String> {
    info!("📊 Converting JSON to CSV (bundled)");

    let content = fs::read_to_string(&input_path)
        .map_err(|e| format!("Failed to read JSON: {}", e))?;

    let records: Vec<serde_json::Map<String, serde_json::Value>> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    if records.is_empty() {
        return Err("JSON array is empty".to_string());
    }

    // Get all unique keys as headers
    let mut headers: Vec<String> = records[0].keys().cloned().collect();
    headers.sort();

    let mut wtr = csv::Writer::from_path(&output_path)
        .map_err(|e| format!("Failed to create CSV: {}", e))?;

    wtr.write_record(&headers)
        .map_err(|e| format!("Failed to write headers: {}", e))?;

    for record in &records {
        let row: Vec<String> = headers.iter()
            .map(|h| {
                record.get(h)
                    .map(|v| match v {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .unwrap_or_default()
            })
            .collect();
        wtr.write_record(&row)
            .map_err(|e| format!("Failed to write row: {}", e))?;
    }

    wtr.flush().map_err(|e| format!("Failed to flush: {}", e))?;

    let output_size = fs::metadata(&output_path).map(|m| m.len()).ok();

    Ok(ConversionResult {
        success: true,
        output_path,
        message: format!("Converted {} records to CSV", records.len()),
        output_size,
    })
}

// ============================================================================
// Document Info
// ============================================================================

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

    let file_size = fs::metadata(file_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Get extra info based on file type
    let page_count = if extension == "pdf" {
        get_pdf_info(file_path).ok()
    } else {
        None
    };

    let sheet_names = if ["xlsx", "xls", "ods"].contains(&extension.as_str()) {
        get_excel_sheets(file_path).ok()
    } else {
        None
    };

    Ok(DocumentInfo {
        file_path: file_path.to_string(),
        file_name,
        file_size,
        extension,
        page_count,
        sheet_names,
    })
}
