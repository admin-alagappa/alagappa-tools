//! Alagappa AI Assistant - Local and Cloud AI support

use serde::{Deserialize, Serialize};
use std::process::Command;
use std::path::PathBuf;
use tokio::process::Command as TokioCommand;
use log::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,      // "user", "assistant", "system"
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub model: Option<String>,
    pub provider: String,  // "ollama", "openai", "bitnet"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIProvider {
    pub name: String,
    pub available: bool,
    pub models: Vec<String>,
}

// ============================================================================
// Provider Detection
// ============================================================================

/// Check if Ollama is installed and running
pub fn check_ollama() -> Option<Vec<String>> {
    // Check if ollama command exists
    let output = Command::new("ollama")
        .arg("list")
        .output()
        .ok()?;
    
    if !output.status.success() {
        return None;
    }
    
    // Parse available models
    let stdout = String::from_utf8_lossy(&output.stdout);
    let models: Vec<String> = stdout
        .lines()
        .skip(1) // Skip header
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            parts.first().map(|s| s.to_string())
        })
        .collect();
    
    Some(models)
}

/// Check if BitNet is installed and find available models
pub fn check_bitnet() -> Option<(PathBuf, Vec<String>)> {
    // Common BitNet installation paths
    let possible_paths = vec![
        dirs::home_dir().map(|h| h.join("BitNet")),
        dirs::home_dir().map(|h| h.join(".bitnet")),
        dirs::home_dir().map(|h| h.join("bitnet.cpp")),
        Some(PathBuf::from("/opt/bitnet")),
        Some(PathBuf::from("/usr/local/bitnet")),
    ];

    for path_opt in possible_paths {
        if let Some(path) = path_opt {
            let run_inference = path.join("run_inference.py");
            if run_inference.exists() {
                // Found BitNet installation, look for models
                let models_dir = path.join("models");
                let mut models = Vec::new();

                if models_dir.exists() {
                    if let Ok(entries) = std::fs::read_dir(&models_dir) {
                        for entry in entries.flatten() {
                            let entry_path = entry.path();
                            // BitNet models are directories containing model files
                            if entry_path.is_dir() {
                                if let Some(name) = entry_path.file_name() {
                                    models.push(name.to_string_lossy().to_string());
                                }
                            }
                            // Also check for .gguf files (quantized models)
                            if entry_path.extension().map(|e| e == "gguf").unwrap_or(false) {
                                if let Some(name) = entry_path.file_name() {
                                    models.push(name.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                }

                // Add default model if no models found but BitNet is installed
                if models.is_empty() {
                    models.push("BitNet-b1.58-2B-4T".to_string());
                }

                return Some((path, models));
            }
        }
    }

    None
}

/// Get available AI providers
pub fn get_providers() -> Vec<AIProvider> {
    let mut providers = Vec::new();
    
    // Check Ollama
    match check_ollama() {
        Some(models) => {
            providers.push(AIProvider {
                name: "ollama".to_string(),
                available: true,
                models,
            });
        }
        None => {
            providers.push(AIProvider {
                name: "ollama".to_string(),
                available: false,
                models: vec![],
            });
        }
    }
    
    // Check BitNet (1-bit LLM)
    match check_bitnet() {
        Some((_path, models)) => {
            providers.push(AIProvider {
                name: "bitnet".to_string(),
                available: true,
                models,
            });
        }
        None => {
            providers.push(AIProvider {
                name: "bitnet".to_string(),
                available: false,
                models: vec![],
            });
        }
    }

    // OpenAI - always "available" but requires API key
    providers.push(AIProvider {
        name: "openai".to_string(),
        available: true, // Will fail at runtime if no API key
        models: vec![
            "gpt-4o".to_string(),
            "gpt-4o-mini".to_string(),
            "gpt-4-turbo".to_string(),
            "gpt-3.5-turbo".to_string(),
        ],
    });

    providers
}

// ============================================================================
// Chat with Ollama (Local)
// ============================================================================

pub async fn chat_ollama(
    messages: Vec<ChatMessage>,
    model: String,
) -> Result<ChatResponse, String> {
    info!("🤖 Ollama chat: model={}", model);
    
    // Build the prompt from messages
    let prompt = messages
        .iter()
        .map(|m| {
            match m.role.as_str() {
                "system" => format!("System: {}\n", m.content),
                "user" => format!("User: {}\n", m.content),
                "assistant" => format!("Assistant: {}\n", m.content),
                _ => format!("{}: {}\n", m.role, m.content),
            }
        })
        .collect::<String>() + "Assistant:";
    
    // Call ollama
    let output = TokioCommand::new("ollama")
        .arg("run")
        .arg(&model)
        .arg(&prompt)
        .output()
        .await
        .map_err(|e| format!("Failed to run Ollama: {}", e))?;
    
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Ollama error: {}", error));
    }
    
    let content = String::from_utf8_lossy(&output.stdout).trim().to_string();
    
    Ok(ChatResponse {
        content,
        model,
        provider: "ollama".to_string(),
    })
}

// ============================================================================
// Chat with OpenAI API
// ============================================================================

pub async fn chat_openai(
    messages: Vec<ChatMessage>,
    model: String,
    api_key: String,
) -> Result<ChatResponse, String> {
    info!("🤖 OpenAI chat: model={}", model);
    
    // Build request body
    let request_body = serde_json::json!({
        "model": model,
        "messages": messages.iter().map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content
            })
        }).collect::<Vec<_>>()
    });
    
    // Use curl for simplicity (avoiding additional dependencies)
    let output = TokioCommand::new("curl")
        .arg("-s")
        .arg("-X").arg("POST")
        .arg("https://api.openai.com/v1/chat/completions")
        .arg("-H").arg("Content-Type: application/json")
        .arg("-H").arg(format!("Authorization: Bearer {}", api_key))
        .arg("-d").arg(request_body.to_string())
        .output()
        .await
        .map_err(|e| format!("Failed to call OpenAI: {}", e))?;
    
    let response_text = String::from_utf8_lossy(&output.stdout);
    
    // Parse response
    let response: serde_json::Value = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse OpenAI response: {}", e))?;
    
    // Check for errors
    if let Some(error) = response.get("error") {
        let message = error.get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Unknown error");
        return Err(format!("OpenAI API error: {}", message));
    }
    
    // Extract content
    let content = response
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or("Failed to extract response content")?
        .to_string();
    
    Ok(ChatResponse {
        content,
        model,
        provider: "openai".to_string(),
    })
}

// ============================================================================
// Chat with BitNet (1-bit LLM - Local CPU Inference)
// ============================================================================

pub async fn chat_bitnet(
    messages: Vec<ChatMessage>,
    model: String,
) -> Result<ChatResponse, String> {
    info!("🤖 BitNet chat: model={}", model);

    // Find BitNet installation
    let (bitnet_path, _models) = check_bitnet()
        .ok_or("BitNet not found. Please install from https://github.com/microsoft/BitNet")?;

    // Build the prompt from messages
    let prompt = messages
        .iter()
        .map(|m| {
            match m.role.as_str() {
                "system" => format!("System: {}\n", m.content),
                "user" => format!("User: {}\n", m.content),
                "assistant" => format!("Assistant: {}\n", m.content),
                _ => format!("{}: {}\n", m.role, m.content),
            }
        })
        .collect::<String>() + "Assistant:";

    // Determine model path - need to find the .gguf file
    let model_dir = bitnet_path.join("models").join(&model);
    let model_path = if model.ends_with(".gguf") {
        PathBuf::from(&model)
    } else if model_dir.is_dir() {
        // Look for ggml-model-i2_s.gguf inside the model directory
        let gguf_path = model_dir.join("ggml-model-i2_s.gguf");
        if gguf_path.exists() {
            gguf_path
        } else {
            // Try to find any .gguf file
            let mut found_gguf = None;
            if let Ok(entries) = std::fs::read_dir(&model_dir) {
                for entry in entries.flatten() {
                    if entry.path().extension().map(|e| e == "gguf").unwrap_or(false) {
                        found_gguf = Some(entry.path());
                        break;
                    }
                }
            }
            found_gguf.ok_or_else(|| format!("No .gguf model file found in {}", model_dir.display()))?
        }
    } else {
        return Err(format!("Model not found: {}", model));
    };

    // Run BitNet inference using python
    let run_inference = bitnet_path.join("run_inference.py");

    let output = TokioCommand::new("python")
        .arg(&run_inference)
        .arg("-m")
        .arg(&model_path)
        .arg("-p")
        .arg(&prompt)
        .arg("-n")
        .arg("256")  // Max tokens
        .arg("-t")
        .arg("4")  // Number of threads
        .arg("-temp")
        .arg("0.7")  // Temperature
        .current_dir(&bitnet_path)
        .output()
        .await
        .map_err(|e| format!("Failed to run BitNet: {}", e))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("BitNet error: {}", error));
    }

    // Parse the output - BitNet outputs some metadata, we need to extract the actual response
    let full_output = String::from_utf8_lossy(&output.stdout);

    // The response typically comes after the prompt, look for "Assistant:" response
    let content = full_output
        .lines()
        .skip_while(|line| !line.contains("Assistant:") || line.starts_with("System:") || line.starts_with("User:"))
        .skip(1)  // Skip the "Assistant:" line itself
        .collect::<Vec<&str>>()
        .join("\n")
        .trim()
        .to_string();

    let content = if content.is_empty() {
        full_output.trim().to_string()
    } else {
        content
    };

    Ok(ChatResponse {
        content,
        model,
        provider: "bitnet".to_string(),
    })
}

// ============================================================================
// Unified Chat Interface
// ============================================================================

pub async fn chat(
    request: ChatRequest,
    api_key: Option<String>,
) -> Result<ChatResponse, String> {
    let model = request.model.unwrap_or_else(|| {
        match request.provider.as_str() {
            "ollama" => "llama3.2".to_string(),
            "openai" => "gpt-4o-mini".to_string(),
            "bitnet" => "BitNet-b1.58-2B-4T".to_string(),
            _ => "llama3.2".to_string(),
        }
    });

    match request.provider.as_str() {
        "ollama" => chat_ollama(request.messages, model).await,
        "bitnet" => chat_bitnet(request.messages, model).await,
        "openai" => {
            let key = api_key.ok_or("OpenAI API key required")?;
            chat_openai(request.messages, model, key).await
        }
        _ => Err(format!("Unknown provider: {}", request.provider)),
    }
}

// ============================================================================
// System Prompts
// ============================================================================

pub fn get_system_prompt() -> String {
    r#"You are Alagappa AI, a helpful assistant built into Alagappa Tools - a desktop application for:
- Biometric attendance management (ZKTeco devices)
- Document conversion (Excel, CSV, JSON, PDF)
- Image processing (resize, convert, compress)
- Video processing (convert, compress, extract audio)

You help users with:
1. Using the app's features effectively
2. Troubleshooting issues
3. General questions and tasks
4. Data analysis and insights

Be concise, friendly, and helpful. Use emojis sparingly for clarity."#.to_string()
}

// ============================================================================
// BitNet Setup & Download
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BitNetSetupStatus {
    pub installed: bool,
    pub built: bool,
    pub install_path: Option<String>,
    pub has_models: bool,
    pub models: Vec<String>,
    pub prerequisites: BitNetPrerequisites,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BitNetPrerequisites {
    pub git: bool,
    pub python: bool,
    pub cmake: bool,
    pub conda: bool,
}

/// Check BitNet prerequisites
pub fn check_bitnet_prerequisites() -> BitNetPrerequisites {
    let git = Command::new("git").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    let python = Command::new("python3").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
        || Command::new("python").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    let cmake = Command::new("cmake").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    let conda = Command::new("conda").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);

    BitNetPrerequisites { git, python, cmake, conda }
}

/// Get BitNet setup status
pub fn get_bitnet_status() -> BitNetSetupStatus {
    let prerequisites = check_bitnet_prerequisites();
    let built = is_bitnet_built();

    match check_bitnet() {
        Some((path, models)) => BitNetSetupStatus {
            installed: true,
            built,
            install_path: Some(path.to_string_lossy().to_string()),
            has_models: !models.is_empty(),
            models,
            prerequisites,
        },
        None => {
            // Check if BitNet folder exists but run_inference.py is not there
            let home = dirs::home_dir();
            let bitnet_path = home.as_ref().map(|h| h.join("BitNet"));
            let folder_exists = bitnet_path.as_ref().map(|p| p.exists()).unwrap_or(false);
            BitNetSetupStatus {
                installed: folder_exists,
                built,
                install_path: if folder_exists {
                    bitnet_path.map(|p| p.to_string_lossy().to_string())
                } else {
                    None
                },
                has_models: false,
                models: vec![],
                prerequisites,
            }
        },
    }
}

/// Step 1: Clone BitNet repository
pub async fn install_bitnet() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let install_path = home.join("BitNet");

    if install_path.exists() {
        return Ok("BitNet already cloned. Click 'Build' next.".to_string());
    }

    info!("📦 Cloning BitNet repository...");

    let clone_output = TokioCommand::new("git")
        .arg("clone")
        .arg("--recursive")
        .arg("https://github.com/microsoft/BitNet.git")
        .arg(&install_path)
        .output()
        .await
        .map_err(|e| format!("Failed to clone BitNet: {}", e))?;

    if !clone_output.status.success() {
        let error = String::from_utf8_lossy(&clone_output.stderr);
        return Err(format!("Git clone failed: {}", error));
    }

    // Create models directory
    let models_dir = install_path.join("models");
    std::fs::create_dir_all(&models_dir).ok();

    Ok("BitNet cloned! Click 'Download Model' next.".to_string())
}

/// Step 2: Download model from HuggingFace
pub async fn download_bitnet_model(model_name: String) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let install_path = home.join("BitNet");

    if !install_path.exists() {
        return Err("BitNet not cloned. Click 'Clone' first.".to_string());
    }

    let models_dir = install_path.join("models");
    std::fs::create_dir_all(&models_dir).ok();

    let model_dir = models_dir.join(&model_name);

    info!("📥 Downloading model: {}", model_name);

    // Download using huggingface-cli
    let output = TokioCommand::new("huggingface-cli")
        .arg("download")
        .arg(format!("microsoft/{}", model_name))
        .arg("--local-dir")
        .arg(&model_dir)
        .output()
        .await
        .map_err(|e| format!("Failed to download: {}", e))?;

    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Download failed: {}", error));
    }

    Ok("Model downloaded! Click 'Build' next.".to_string())
}

/// Step 3: Build BitNet (compile + convert model)
pub async fn build_bitnet() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let install_path = home.join("BitNet");

    if !install_path.exists() {
        return Err("BitNet not cloned. Click 'Clone' first.".to_string());
    }

    info!("🔨 Building BitNet...");

    let setup_script = install_path.join("setup_env.py");
    if !setup_script.exists() {
        return Err("setup_env.py not found.".to_string());
    }

    // Run setup_env.py to build and convert model
    let output = TokioCommand::new("python")
        .arg(&setup_script)
        .arg("--hf-repo")
        .arg("microsoft/BitNet-b1.58-2B-4T")
        .arg("-q")
        .arg("i2_s")
        .current_dir(&install_path)
        .output()
        .await
        .map_err(|e| format!("Failed to build: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("Build failed:\n{}\n{}", stdout, stderr));
    }

    Ok("BitNet ready! You can now chat.".to_string())
}

/// Check if BitNet is built
pub fn is_bitnet_built() -> bool {
    if let Some(home) = dirs::home_dir() {
        let binary_path = home.join("BitNet").join("build").join("bin").join("llama-cli");
        return binary_path.exists();
    }
    false
}

/// Uninstall BitNet
pub async fn uninstall_bitnet() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let install_path = home.join("BitNet");

    if !install_path.exists() {
        return Err("BitNet is not installed".to_string());
    }

    std::fs::remove_dir_all(&install_path)
        .map_err(|e| format!("Failed to remove BitNet: {}", e))?;

    Ok("BitNet uninstalled successfully".to_string())
}
