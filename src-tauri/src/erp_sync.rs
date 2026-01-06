//! ERP Sync - Push attendance data to Student Registration API

use serde::{Deserialize, Serialize};
use log::info;

/// Default API URL
pub const DEFAULT_API_URL: &str = "https://api.alagappa.org";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErpConfig {
    pub api_key: String,           // API key for authentication
    pub api_url: Option<String>,   // Custom API URL (optional, defaults to production)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FacultyAttendancePayload {
    pub faculty: i32,              // Faculty ID in ERP system
    pub date: String,              // YYYY-MM-DD
    pub check_in_time: Option<String>,   // HH:MM:SS
    pub check_out_time: Option<String>,  // HH:MM:SS
    pub is_present: bool,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttendanceSyncRequest {
    pub config: ErpConfig,
    pub records: Vec<FacultyAttendancePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub success: bool,
    pub synced_count: i32,
    pub skipped_count: i32,
    pub failed_count: i32,
    pub errors: Vec<String>,
}

/// Sync attendance records to ERP system (bulk)
pub async fn sync_attendance_to_erp(request: AttendanceSyncRequest) -> Result<SyncResult, String> {
    let base_url = request.config.api_url.as_deref().unwrap_or(DEFAULT_API_URL);
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/v1/attendance/faculty-attendance/bulk/", base_url.trim_end_matches('/'));

    info!("🔄 Bulk syncing {} records to ERP: {}", request.records.len(), endpoint);

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Api-Key {}", request.config.api_key))
        .header("Content-Type", "application/json")
        .json(&request.records)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        let json: serde_json::Value = response.json().await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        let created = json.get("created_count").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let updated = json.get("updated_count").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let skipped = json.get("skipped_count").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let failed = json.get("failed_count").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let errors: Vec<String> = json.get("errors")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|e| e.as_str().map(String::from)).collect())
            .unwrap_or_default();

        info!("✓ Bulk sync complete: created={}, updated={}, skipped={}, failed={}", created, updated, skipped, failed);

        Ok(SyncResult {
            success: failed == 0 && skipped == 0,
            synced_count: created + updated,
            skipped_count: skipped,
            failed_count: failed,
            errors,
        })
    } else {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());

        // Return special error for unauthorized - frontend will handle logout
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            Err(format!("AUTH_ERROR: {}", error_text))
        } else {
            Err(format!("API Error ({}): {}", status, error_text))
        }
    }
}

/// API Key verification response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyInfo {
    pub valid: bool,
    pub app_name: Option<String>,
    pub app_identifier: Option<String>,
    pub platform: Option<String>,
    pub intent: Option<String>,
}

/// Verify API key and return details
pub async fn verify_api_key(api_key: &str, api_url: Option<&str>) -> Result<ApiKeyInfo, String> {
    let base_url = api_url.unwrap_or(DEFAULT_API_URL);
    let client = reqwest::Client::new();
    let endpoint = format!("{}/api/v1/access-control/api-keys/verify/", base_url.trim_end_matches('/'));

    info!("🔑 Verifying API key at: {}", endpoint);

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Api-Key {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    if response.status().is_success() {
        let json: serde_json::Value = response.json().await
            .map_err(|e| format!("Failed to parse response: {}", e))?;

        Ok(ApiKeyInfo {
            valid: json.get("valid").and_then(|v| v.as_bool()).unwrap_or(false),
            app_name: json.get("app_name").and_then(|v| v.as_str()).map(String::from),
            app_identifier: json.get("app_identifier").and_then(|v| v.as_str()).map(String::from),
            platform: json.get("platform").and_then(|v| v.as_str()).map(String::from),
            intent: json.get("intent").and_then(|v| v.as_str()).map(String::from),
        })
    } else {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());

        // Try to parse error response
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&error_text) {
            if let Some(error) = json.get("error").and_then(|v| v.as_str()) {
                return Err(error.to_string());
            }
        }

        Err(format!("API Error ({}): {}", status, error_text))
    }
}

/// Test ERP connection / Verify API key (simple version for UI)
pub async fn test_erp_connection(config: ErpConfig) -> Result<String, String> {
    let result = verify_api_key(&config.api_key, config.api_url.as_deref()).await?;

    if result.valid {
        Ok(format!("Connection successful! App: {}", result.app_name.unwrap_or_else(|| "Unknown".to_string())))
    } else {
        Err("API key is not valid".to_string())
    }
}
