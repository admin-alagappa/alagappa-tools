import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

// Types
interface MediaInfo {
  file_path: string;
  file_name: string;
  file_size: number;
  format: string;
  duration?: number;
  width?: number;
  height?: number;
  bitrate?: number;
  codec?: string;
}

interface ConversionResult {
  success: boolean;
  output_path: string;
  message: string;
  output_size?: number;
}

interface VideoConvertOptions {
  input_path: string;
  output_path: string;
  format: string;
  quality: string;
  resolution?: string;
  fps?: number;
}

// Constants
const VIDEO_FORMATS = [
  { value: "mp4", label: "MP4 (H.264)", ext: "mp4" },
  { value: "webm", label: "WebM (VP9)", ext: "webm" },
  { value: "mov", label: "MOV (QuickTime)", ext: "mov" },
  { value: "avi", label: "AVI", ext: "avi" },
  { value: "mkv", label: "MKV", ext: "mkv" },
  { value: "gif", label: "GIF (Animated)", ext: "gif" },
];

const AUDIO_FORMATS = [
  { value: "mp3", label: "MP3", ext: "mp3" },
  { value: "aac", label: "AAC", ext: "m4a" },
  { value: "wav", label: "WAV", ext: "wav" },
  { value: "flac", label: "FLAC", ext: "flac" },
  { value: "ogg", label: "OGG", ext: "ogg" },
];

const QUALITY_OPTIONS = [
  { value: "high", label: "High Quality" },
  { value: "medium", label: "Medium (Balanced)" },
  { value: "low", label: "Low (Smaller file)" },
];

const RESOLUTION_OPTIONS = [
  { value: "", label: "Original" },
  { value: "1080p", label: "1080p (Full HD)" },
  { value: "720p", label: "720p (HD)" },
  { value: "480p", label: "480p (SD)" },
  { value: "360p", label: "360p" },
];

// Helpers
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function VideoConverter() {
  // State
  const [ffmpegStatus, setFfmpegStatus] = useState<string | null>(null);
  const [ffmpegError, setFfmpegError] = useState<string | null>(null);
  const [inputFile, setInputFile] = useState<string | null>(null);
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Conversion options
  const [outputFormat, setOutputFormat] = useState("mp4");
  const [quality, setQuality] = useState("medium");
  const [resolution, setResolution] = useState("");

  // Extract audio options
  const [audioFormat, setAudioFormat] = useState("mp3");

  // Active tab
  const [activeTab, setActiveTab] = useState<"convert" | "compress" | "audio">("convert");

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

  const selectInputFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "Video Files", extensions: ["mp4", "avi", "mov", "mkv", "webm", "wmv", "flv", "m4v", "3gp"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });

      if (selected && typeof selected === "string") {
        setInputFile(selected);
        setResult(null);
        setError(null);
        await loadMediaInfo(selected);
      }
    } catch (err) {
      setError(`Failed to select file: ${err}`);
    }
  };

  const loadMediaInfo = async (filePath: string) => {
    setLoading(true);
    try {
      const info = await invoke<MediaInfo>("get_media_information", { filePath });
      setMediaInfo(info);
    } catch (err) {
      setError(`Failed to read file info: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  const handleConvert = async () => {
    if (!inputFile) return;

    const format = VIDEO_FORMATS.find(f => f.value === outputFormat);
    const ext = format?.ext || "mp4";
    const defaultName = inputFile.replace(/\.[^/.]+$/, `_converted.${ext}`);

    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: format?.label || "Video", extensions: [ext] }],
    });

    if (!outputPath) return;

    setConverting(true);
    setProgress("Starting conversion...");
    setResult(null);
    setError(null);

    try {
      const options: VideoConvertOptions = {
        input_path: inputFile,
        output_path: outputPath,
        format: outputFormat,
        quality,
        resolution: resolution || undefined,
      };

      setProgress("Converting video (this may take a while)...");
      const convResult = await invoke<ConversionResult>("video_convert", { options });
      setResult(convResult);
      setProgress("");
    } catch (err) {
      setError(`Conversion failed: ${err}`);
      setProgress("");
    } finally {
      setConverting(false);
    }
  };

  const handleCompress = async () => {
    if (!inputFile) return;

    const defaultName = inputFile.replace(/\.[^/.]+$/, "_compressed.mp4");
    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
    });

    if (!outputPath) return;

    setConverting(true);
    setProgress("Compressing video...");
    setResult(null);
    setError(null);

    try {
      const convResult = await invoke<ConversionResult>("video_compress", {
        inputPath: inputFile,
        outputPath,
        targetBitrate: null,
      });
      setResult(convResult);
      setProgress("");
    } catch (err) {
      setError(`Compression failed: ${err}`);
      setProgress("");
    } finally {
      setConverting(false);
    }
  };

  const handleExtractAudio = async () => {
    if (!inputFile) return;

    const format = AUDIO_FORMATS.find(f => f.value === audioFormat);
    const ext = format?.ext || "mp3";
    const defaultName = inputFile.replace(/\.[^/.]+$/, `.${ext}`);

    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: format?.label || "Audio", extensions: [ext] }],
    });

    if (!outputPath) return;

    setConverting(true);
    setProgress("Extracting audio...");
    setResult(null);
    setError(null);

    try {
      const convResult = await invoke<ConversionResult>("video_extract_audio", {
        inputPath: inputFile,
        outputPath,
        format: audioFormat,
      });
      setResult(convResult);
      setProgress("");
    } catch (err) {
      setError(`Audio extraction failed: ${err}`);
      setProgress("");
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h2 className="text-2xl font-bold text-gray-800">Video Converter</h2>
        <p className="text-sm text-gray-600 mt-1">Convert, compress, and extract audio from videos</p>
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
            <p className="text-sm text-red-700 mt-1">{ffmpegError}</p>
            <p className="text-sm text-red-600 mt-2">Please install FFmpeg to use video conversion features.</p>
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
          <h3 className="text-lg font-semibold text-gray-800 mb-4">Select Video File</h3>
          
          <button
            onClick={selectInputFile}
            disabled={loading || converting}
            className="w-full p-8 border-2 border-dashed border-gray-300 rounded-lg hover:border-primary-400 hover:bg-primary-50 transition-colors disabled:opacity-50"
          >
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto text-gray-400 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              <p className="text-gray-600 font-medium">Click to select video file</p>
              <p className="text-sm text-gray-400 mt-1">MP4, AVI, MOV, MKV, WebM, and more</p>
            </div>
          </button>

          {/* File Info */}
          {mediaInfo && (
            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{mediaInfo.file_name}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-sm text-gray-600">
                    <span>{formatFileSize(mediaInfo.file_size)}</span>
                    {mediaInfo.duration && <span>{formatDuration(mediaInfo.duration)}</span>}
                    {mediaInfo.width && mediaInfo.height && (
                      <span>{mediaInfo.width}×{mediaInfo.height}</span>
                    )}
                    {mediaInfo.codec && <span>{mediaInfo.codec.toUpperCase()}</span>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Conversion Options */}
        {inputFile && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            {/* Tabs */}
            <div className="flex border-b border-gray-200 mb-6">
              <button
                onClick={() => setActiveTab("convert")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "convert"
                    ? "border-primary-500 text-primary-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Convert Format
              </button>
              <button
                onClick={() => setActiveTab("compress")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "compress"
                    ? "border-primary-500 text-primary-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Compress
              </button>
              <button
                onClick={() => setActiveTab("audio")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === "audio"
                    ? "border-primary-500 text-primary-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Extract Audio
              </button>
            </div>

            {/* Convert Tab */}
            {activeTab === "convert" && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Output Format</label>
                    <select
                      value={outputFormat}
                      onChange={(e) => setOutputFormat(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    >
                      {VIDEO_FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Quality</label>
                    <select
                      value={quality}
                      onChange={(e) => setQuality(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    >
                      {QUALITY_OPTIONS.map((q) => (
                        <option key={q.value} value={q.value}>{q.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Resolution</label>
                    <select
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                    >
                      {RESOLUTION_OPTIONS.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  onClick={handleConvert}
                  disabled={converting}
                  className="w-full py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {converting ? "Converting..." : "Convert Video"}
                </button>
              </div>
            )}

            {/* Compress Tab */}
            {activeTab === "compress" && (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">
                  Compress video to reduce file size while maintaining reasonable quality.
                  Output will be in MP4 format with H.264 codec.
                </p>
                <button
                  onClick={handleCompress}
                  disabled={converting}
                  className="w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {converting ? "Compressing..." : "Compress Video"}
                </button>
              </div>
            )}

            {/* Audio Tab */}
            {activeTab === "audio" && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Audio Format</label>
                  <select
                    value={audioFormat}
                    onChange={(e) => setAudioFormat(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                  >
                    {AUDIO_FORMATS.map((f) => (
                      <option key={f.value} value={f.value}>{f.label}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleExtractAudio}
                  disabled={converting}
                  className="w-full py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  {converting ? "Extracting..." : "Extract Audio"}
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

        {/* Result */}
        {result && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-green-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div>
                <p className="font-medium text-green-800">{result.message}</p>
                <p className="text-sm text-green-700 mt-1 break-all">{result.output_path}</p>
                {result.output_size && (
                  <p className="text-sm text-green-600 mt-1">Size: {formatFileSize(result.output_size)}</p>
                )}
              </div>
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
