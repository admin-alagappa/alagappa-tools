import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

// Types
interface MediaInfo {
  file_path: string;
  file_name: string;
  file_size: number;
  format: string;
  width?: number;
  height?: number;
}

interface ConversionResult {
  success: boolean;
  output_path: string;
  message: string;
  output_size?: number;
}

interface ImageConvertOptions {
  input_path: string;
  output_path: string;
  format: string;
  quality?: number;
  width?: number;
  height?: number;
  maintain_aspect: boolean;
}

// Constants
const IMAGE_FORMATS = [
  { value: "jpg", label: "JPEG", ext: "jpg" },
  { value: "png", label: "PNG", ext: "png" },
  { value: "webp", label: "WebP", ext: "webp" },
  { value: "gif", label: "GIF", ext: "gif" },
  { value: "bmp", label: "BMP", ext: "bmp" },
  { value: "tiff", label: "TIFF", ext: "tiff" },
];

const QUALITY_PRESETS = [
  { value: 100, label: "Maximum (100%)" },
  { value: 90, label: "High (90%)" },
  { value: 80, label: "Good (80%)" },
  { value: 60, label: "Medium (60%)" },
  { value: 40, label: "Low (40%)" },
];

const SIZE_PRESETS = [
  { width: 0, height: 0, label: "Original Size" },
  { width: 1920, height: 1080, label: "1920×1080 (Full HD)" },
  { width: 1280, height: 720, label: "1280×720 (HD)" },
  { width: 800, height: 600, label: "800×600" },
  { width: 640, height: 480, label: "640×480" },
  { width: 320, height: 240, label: "320×240 (Thumbnail)" },
];

// Helpers
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ImageConverter() {
  // State
  const [ffmpegStatus, setFfmpegStatus] = useState<string | null>(null);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  const [inputFiles, setInputFiles] = useState<string[]>([]);
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [results, setResults] = useState<ConversionResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Conversion options
  const [outputFormat, setOutputFormat] = useState("jpg");
  const [quality, setQuality] = useState(90);
  const [selectedSize, setSelectedSize] = useState(0); // Index into SIZE_PRESETS
  const [customWidth, setCustomWidth] = useState<number | "">("");
  const [customHeight, setCustomHeight] = useState<number | "">("");
  const [maintainAspect, setMaintainAspect] = useState(true);

  // Active tab
  const [activeTab, setActiveTab] = useState<"convert" | "resize" | "compress">("convert");

  // Check FFmpeg on mount
  useEffect(() => {
    checkFfmpeg();
  }, []);

  const checkFfmpeg = async () => {
    try {
      const status = await invoke<string>("check_ffmpeg_status");
      setFfmpegStatus(status);
      setFfmpegError(null);
    } catch (err) {
      setFfmpegError(err instanceof Error ? err.message : String(err));
      setFfmpegStatus(null);
    }
  };

  const selectInputFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: "Image Files", extensions: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "tiff", "tif", "heic"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (selected) {
        const files = Array.isArray(selected) ? selected : [selected];
        setInputFiles(files);
        setResults([]);
        setError(null);
        
        // Load info for first file
        const firstFile = files[0];
        if (firstFile) {
          await loadMediaInfo(firstFile);
        }
      }
    } catch (err) {
      setError(`Failed to select files: ${err}`);
    }
  };

  const loadMediaInfo = async (filePath: string) => {
    setLoading(true);
    try {
      const info = await invoke<MediaInfo>("get_media_information", { filePath });
      setMediaInfo(info);
    } catch {
      // Silently fail for info loading
      setMediaInfo(null);
    } finally {
      setLoading(false);
    }
  };

  const getOutputDimensions = (): { width?: number; height?: number } => {
    if (selectedSize > 0 && selectedSize < SIZE_PRESETS.length) {
      const preset = SIZE_PRESETS[selectedSize]!;
      return { width: preset.width, height: preset.height };
    }
    if (customWidth || customHeight) {
      return {
        width: customWidth ? Number(customWidth) : undefined,
        height: customHeight ? Number(customHeight) : undefined,
      };
    }
    return {};
  };

  const handleConvert = async () => {
    if (inputFiles.length === 0) return;

    setConverting(true);
    setResults([]);
    setError(null);

    const format = IMAGE_FORMATS.find(f => f.value === outputFormat);
    const ext = format?.ext || "jpg";
    const newResults: ConversionResult[] = [];

    for (let i = 0; i < inputFiles.length; i++) {
      const inputFile = inputFiles[i]!;
      const fileName = inputFile.split("/").pop() || "file";
      setProgress(`Converting ${i + 1}/${inputFiles.length}: ${fileName}`);

      const defaultName = inputFile.replace(/\.[^/.]+$/, `_converted.${ext}`);
      
      let outputPath: string;
      if (inputFiles.length === 1) {
        const selected = await save({
          defaultPath: defaultName,
          filters: [{ name: format?.label || "Image", extensions: [ext] }],
        });
        if (!selected) {
          setConverting(false);
          setProgress("");
          return;
        }
        outputPath = selected;
      } else {
        // Batch mode - auto-generate output path
        outputPath = defaultName;
      }

      try {
        const dims = getOutputDimensions();
        const options: ImageConvertOptions = {
          input_path: inputFile,
          output_path: outputPath,
          format: outputFormat,
          quality: ["jpg", "jpeg", "webp"].includes(outputFormat) ? quality : undefined,
          width: dims.width,
          height: dims.height,
          maintain_aspect: maintainAspect,
        };

        const result = await invoke<ConversionResult>("image_convert", { options });
        newResults.push(result);
      } catch (err) {
        newResults.push({
          success: false,
          output_path: outputPath,
          message: `Failed: ${err}`,
        });
      }
    }

    setResults(newResults);
    setProgress("");
    setConverting(false);
  };

  const handleResize = async () => {
    if (inputFiles.length === 0) return;

    const dims = getOutputDimensions();
    if (!dims.width && !dims.height) {
      setError("Please select a size or enter custom dimensions");
      return;
    }

    setConverting(true);
    setResults([]);
    setError(null);

    const newResults: ConversionResult[] = [];

    for (let i = 0; i < inputFiles.length; i++) {
      const inputFile = inputFiles[i]!;
      const ext = inputFile.split(".").pop() || "jpg";
      const fileName = inputFile.split("/").pop() || "file";
      setProgress(`Resizing ${i + 1}/${inputFiles.length}: ${fileName}`);

      const defaultName = inputFile.replace(/\.[^/.]+$/, `_resized.${ext}`);
      
      let outputPath: string;
      if (inputFiles.length === 1) {
        const selected = await save({
          defaultPath: defaultName,
          filters: [{ name: "Image", extensions: [ext] }],
        });
        if (!selected) {
          setConverting(false);
          setProgress("");
          return;
        }
        outputPath = selected;
      } else {
        outputPath = defaultName;
      }

      try {
        const result = await invoke<ConversionResult>("image_resize", {
          inputPath: inputFile,
          outputPath,
          width: dims.width || 0,
          height: dims.height || 0,
          maintainAspect,
        });
        newResults.push(result);
      } catch (err) {
        newResults.push({
          success: false,
          output_path: outputPath,
          message: `Failed: ${err}`,
        });
      }
    }

    setResults(newResults);
    setProgress("");
    setConverting(false);
  };

  const handleCompress = async () => {
    if (inputFiles.length === 0) return;

    setConverting(true);
    setResults([]);
    setError(null);

    const newResults: ConversionResult[] = [];

    for (let i = 0; i < inputFiles.length; i++) {
      const inputFile = inputFiles[i]!;
      const ext = inputFile.split(".").pop() || "jpg";
      const fileName = inputFile.split("/").pop() || "file";
      setProgress(`Compressing ${i + 1}/${inputFiles.length}: ${fileName}`);

      const defaultName = inputFile.replace(/\.[^/.]+$/, `_compressed.${ext}`);
      
      let outputPath: string;
      if (inputFiles.length === 1) {
        const selected = await save({
          defaultPath: defaultName,
          filters: [{ name: "Image", extensions: [ext] }],
        });
        if (!selected) {
          setConverting(false);
          setProgress("");
          return;
        }
        outputPath = selected;
      } else {
        outputPath = defaultName;
      }

      try {
        const result = await invoke<ConversionResult>("image_compress", {
          inputPath: inputFile,
          outputPath,
          quality,
        });
        newResults.push(result);
      } catch (err) {
        newResults.push({
          success: false,
          output_path: outputPath,
          message: `Failed: ${err}`,
        });
      }
    }

    setResults(newResults);
    setProgress("");
    setConverting(false);
  };

  const successCount = results.filter(r => r.success).length;
  const totalSavedBytes = results.reduce((sum, r) => sum + (r.output_size || 0), 0);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h2 className="text-2xl font-bold text-gray-800">Image Converter</h2>
        <p className="text-sm text-gray-600 mt-1">Convert, resize, and compress images</p>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* FFmpeg Status */}
        {ffmpegError ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-center gap-2 text-red-800">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="font-medium">FFmpeg not found</span>
            </div>
            <p className="text-sm text-red-700 mt-1">Please install FFmpeg for image conversion.</p>
          </div>
        ) : ffmpegStatus ? (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="text-sm text-green-800">{ffmpegStatus}</span>
          </div>
        ) : null}

        {/* File Selection */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">Select Images</h3>
          
          <button
            onClick={selectInputFiles}
            disabled={loading || converting}
            className="w-full p-8 border-2 border-dashed border-gray-300 rounded-lg hover:border-purple-400 hover:bg-purple-50 transition-colors disabled:opacity-50"
          >
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <p className="text-gray-600 font-medium">Click to select images</p>
              <p className="text-sm text-gray-400 mt-1">JPEG, PNG, WebP, GIF, BMP, TIFF, HEIC</p>
            </div>
          </button>

          {/* Selected Files */}
          {inputFiles.length > 0 && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-gray-800">
                  {inputFiles.length} file{inputFiles.length !== 1 ? "s" : ""} selected
                </span>
                <button
                  onClick={() => setInputFiles([])}
                  className="text-sm text-gray-500 hover:text-red-500"
                >
                  Clear
                </button>
              </div>
              {mediaInfo && inputFiles.length === 1 && (
                <div className="flex items-center gap-4 text-sm text-gray-600">
                  <span>{formatFileSize(mediaInfo.file_size)}</span>
                  {mediaInfo.width && mediaInfo.height && (
                    <span>{mediaInfo.width}×{mediaInfo.height}</span>
                  )}
                </div>
              )}
              {inputFiles.length > 1 && (
                <div className="max-h-32 overflow-auto mt-2">
                  {inputFiles.map((file, idx) => (
                    <div key={idx} className="text-sm text-gray-600 truncate">
                      {file.split("/").pop()}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Conversion Options */}
        {inputFiles.length > 0 && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            {/* Tabs */}
            <div className="flex border-b border-gray-200 mb-6">
              <button
                onClick={() => setActiveTab("convert")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "convert"
                    ? "border-purple-500 text-purple-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Convert Format
              </button>
              <button
                onClick={() => setActiveTab("resize")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "resize"
                    ? "border-purple-500 text-purple-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Resize
              </button>
              <button
                onClick={() => setActiveTab("compress")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "compress"
                    ? "border-purple-500 text-purple-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Compress
              </button>
            </div>

            {/* Convert Tab */}
            {activeTab === "convert" && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Output Format</label>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    >
                      {IMAGE_FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                  {["jpg", "jpeg", "webp"].includes(outputFormat) && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Quality</label>
                      <select
                        value={quality}
                        onChange={(e) => setQuality(Number(e.target.value))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      >
                        {QUALITY_PRESETS.map((q) => (
                          <option key={q.value} value={q.value}>{q.label}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <button
                  onClick={handleConvert}
                  disabled={converting}
                  className="w-full py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {converting ? "Converting..." : `Convert ${inputFiles.length} Image${inputFiles.length !== 1 ? "s" : ""}`}
                </button>
              </div>
            )}

            {/* Resize Tab */}
            {activeTab === "resize" && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Size Preset</label>
                  <select
                    value={selectedSize}
                    onChange={(e) => setSelectedSize(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  >
                    {SIZE_PRESETS.map((s, idx) => (
                      <option key={idx} value={idx}>{s.label}</option>
                    ))}
                    <option value={-1}>Custom...</option>
                  </select>
                </div>

                {selectedSize === -1 && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Width (px)</label>
                      <input
                        type="number"
                        value={customWidth}
                        onChange={(e) => setCustomWidth(e.target.value ? Number(e.target.value) : "")}
                        placeholder="Auto"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Height (px)</label>
                      <input
                        type="number"
                        value={customHeight}
                        onChange={(e) => setCustomHeight(e.target.value ? Number(e.target.value) : "")}
                        placeholder="Auto"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      />
                    </div>
                  </div>
                )}

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={maintainAspect}
                    onChange={(e) => setMaintainAspect(e.target.checked)}
                    className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                  />
                  <span className="text-sm text-gray-700">Maintain aspect ratio</span>
                </label>

                <button
                  onClick={handleResize}
                  disabled={converting || (selectedSize === 0 && !customWidth && !customHeight)}
                  className="w-full py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {converting ? "Resizing..." : `Resize ${inputFiles.length} Image${inputFiles.length !== 1 ? "s" : ""}`}
                </button>
              </div>
            )}

            {/* Compress Tab */}
            {activeTab === "compress" && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Quality</label>
                  <select
                    value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  >
                    {QUALITY_PRESETS.map((q) => (
                      <option key={q.value} value={q.value}>{q.label}</option>
                    ))}
                  </select>
                </div>
                <p className="text-sm text-gray-500">
                  Lower quality = smaller file size. Best for web use.
                </p>
                <button
                  onClick={handleCompress}
                  disabled={converting}
                  className="w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {converting ? "Compressing..." : `Compress ${inputFiles.length} Image${inputFiles.length !== 1 ? "s" : ""}`}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Progress */}
        {progress && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 text-blue-600 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-blue-800">{progress}</span>
            </div>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="font-medium text-green-800">
                {successCount}/{results.length} images processed
              </span>
              {totalSavedBytes > 0 && (
                <span className="text-sm text-green-600">
                  (Total: {formatFileSize(totalSavedBytes)})
                </span>
              )}
            </div>
            <div className="max-h-40 overflow-auto space-y-1">
              {results.map((r, idx) => (
                <div key={idx} className={`text-sm ${r.success ? "text-green-700" : "text-red-600"}`}>
                  {r.success ? "✓" : "✗"} {r.output_path.split("/").pop()}
                  {r.output_size && ` (${formatFileSize(r.output_size)})`}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-red-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-red-800">{error}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
