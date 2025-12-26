import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

// Types
interface DocumentInfo {
  file_path: string;
  file_name: string;
  file_size: number;
  extension: string;
  page_count?: number;
  sheet_names?: string[];
}

interface ConversionResult {
  success: boolean;
  output_path: string;
  message: string;
  output_size?: number;
}

interface ToolStatus {
  name: string;
  available: boolean;
  version?: string;
}

// Helpers
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(ext: string): string {
  const icons: Record<string, string> = {
    pdf: "📕",
    doc: "📘", docx: "📘", odt: "📘",
    xls: "📗", xlsx: "📗", ods: "📗", csv: "📗",
    json: "📋",
    txt: "📝", md: "📝",
    html: "🌐", htm: "🌐",
  };
  return icons[ext.toLowerCase()] || "📄";
}

export default function DocumentConverter() {
  // State
  const [externalTools, setExternalTools] = useState<ToolStatus[]>([]);
  const [inputFile, setInputFile] = useState<string | null>(null);
  const [docInfo, setDocInfo] = useState<DocumentInfo | null>(null);
  const [pdfFiles, setPdfFiles] = useState<string[]>([]);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<ConversionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Excel options
  const [selectedSheet, setSelectedSheet] = useState<number>(0);

  // Active tab
  const [activeTab, setActiveTab] = useState<"excel" | "data" | "pdf" | "external">("excel");

  // Check external tools on mount
  useEffect(() => {
    checkTools();
  }, []);

  const checkTools = async () => {
    try {
      const status = await invoke<ToolStatus[]>("check_document_tools");
      setExternalTools(status);
    } catch (err) {
      console.error("Failed to check tools:", err);
    }
  };

  const hasTool = (name: string): boolean => {
    return externalTools.some(t => t.name === name && t.available);
  };

  const clearState = () => {
    setInputFile(null);
    setDocInfo(null);
    setPdfFiles([]);
    setResult(null);
    setError(null);
    setSelectedSheet(0);
  };

  const selectInputFile = async (fileTypes: string[]) => {
    try {
      const filters = [
        { name: "Documents", extensions: fileTypes },
        { name: "All Files", extensions: ["*"] },
      ];

      const selected = await open({ multiple: false, filters });

      if (selected && typeof selected === "string") {
        setInputFile(selected);
        setResult(null);
        setError(null);
        await loadDocInfo(selected);
      }
    } catch (err) {
      setError(`Failed to select file: ${err}`);
    }
  };

  const selectPdfFiles = async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });

      if (selected) {
        const files = Array.isArray(selected) ? selected : [selected];
        setPdfFiles(files);
        setInputFile(null);
        setDocInfo(null);
        setResult(null);
        setError(null);
      }
    } catch (err) {
      setError(`Failed to select files: ${err}`);
    }
  };

  const loadDocInfo = async (filePath: string) => {
    try {
      const info = await invoke<DocumentInfo>("bundled_get_doc_info", { filePath });
      setDocInfo(info);
      setSelectedSheet(0);
    } catch {
      setDocInfo(null);
    }
  };

  // ============================================================================
  // Bundled Conversions (No external tools needed!)
  // ============================================================================

  const handleExcelToCsv = async () => {
    if (!inputFile) return;

    const defaultName = inputFile.replace(/\.[^/.]+$/, ".csv");
    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: "CSV Files", extensions: ["csv"] }],
    });

    if (!outputPath) return;

    setConverting(true);
    setProgress("Converting Excel to CSV...");
    setResult(null);
    setError(null);

    try {
      const convResult = await invoke<ConversionResult>("bundled_excel_to_csv", {
        inputPath: inputFile,
        outputPath,
        sheetIndex: selectedSheet,
      });
      setResult(convResult);
    } catch (err) {
      setError(`Conversion failed: ${err}`);
    } finally {
      setConverting(false);
      setProgress("");
    }
  };

  const handleCsvToJson = async () => {
    if (!inputFile) return;

    const defaultName = inputFile.replace(/\.[^/.]+$/, ".json");
    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: "JSON Files", extensions: ["json"] }],
    });

    if (!outputPath) return;

    setConverting(true);
    setProgress("Converting CSV to JSON...");
    setResult(null);
    setError(null);

    try {
      const convResult = await invoke<ConversionResult>("bundled_csv_to_json", {
        inputPath: inputFile,
        outputPath,
      });
      setResult(convResult);
    } catch (err) {
      setError(`Conversion failed: ${err}`);
    } finally {
      setConverting(false);
      setProgress("");
    }
  };

  const handleJsonToCsv = async () => {
    if (!inputFile) return;

    const defaultName = inputFile.replace(/\.[^/.]+$/, ".csv");
    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: "CSV Files", extensions: ["csv"] }],
    });

    if (!outputPath) return;

    setConverting(true);
    setProgress("Converting JSON to CSV...");
    setResult(null);
    setError(null);

    try {
      const convResult = await invoke<ConversionResult>("bundled_json_to_csv", {
        inputPath: inputFile,
        outputPath,
      });
      setResult(convResult);
    } catch (err) {
      setError(`Conversion failed: ${err}`);
    } finally {
      setConverting(false);
      setProgress("");
    }
  };

  const handleMergePdfs = async () => {
    if (pdfFiles.length < 2) {
      setError("Please select at least 2 PDF files to merge");
      return;
    }

    const outputPath = await save({
      defaultPath: "merged.pdf",
      filters: [{ name: "PDF Files", extensions: ["pdf"] }],
    });

    if (!outputPath) return;

    setConverting(true);
    setProgress(`Merging ${pdfFiles.length} PDFs...`);
    setResult(null);
    setError(null);

    try {
      const convResult = await invoke<ConversionResult>("bundled_merge_pdfs", {
        inputPaths: pdfFiles,
        outputPath,
      });
      setResult(convResult);
    } catch (err) {
      setError(`Merge failed: ${err}`);
    } finally {
      setConverting(false);
      setProgress("");
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h2 className="text-2xl font-bold text-gray-800">Document Converter</h2>
        <p className="text-sm text-gray-600 mt-1">Convert spreadsheets, data files, and merge PDFs - no external tools needed!</p>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Bundled Features Banner */}
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center gap-2 text-green-800">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <span className="font-medium">Built-in converters - no installation required!</span>
          </div>
          <p className="text-sm text-green-700 mt-1">Excel, CSV, JSON conversions and PDF merge work out of the box.</p>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex border-b border-gray-200 mb-6">
            <button
              onClick={() => { setActiveTab("excel"); clearState(); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "excel"
                  ? "border-green-500 text-green-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              📗 Excel → CSV
            </button>
            <button
              onClick={() => { setActiveTab("data"); clearState(); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "data"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              📊 CSV ↔ JSON
            </button>
            <button
              onClick={() => { setActiveTab("pdf"); clearState(); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "pdf"
                  ? "border-red-500 text-red-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              📕 Merge PDFs
            </button>
            <button
              onClick={() => { setActiveTab("external"); clearState(); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === "external"
                  ? "border-purple-500 text-purple-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              ⚙️ Advanced
            </button>
          </div>

          {/* Excel Tab */}
          {activeTab === "excel" && (
            <div className="space-y-4">
              <button
                onClick={() => selectInputFile(["xlsx", "xls", "ods"])}
                disabled={converting}
                className="w-full p-6 border-2 border-dashed border-gray-300 rounded-lg hover:border-green-400 hover:bg-green-50 transition-colors disabled:opacity-50"
              >
                <div className="text-center">
                  <span className="text-4xl">📗</span>
                  <p className="text-gray-600 font-medium mt-2">Select Excel File</p>
                  <p className="text-sm text-gray-400">.xlsx, .xls, .ods</p>
                </div>
              </button>

              {docInfo && (
                <div className="p-4 bg-gray-50 rounded-lg space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{getFileIcon(docInfo.extension)}</span>
                    <div>
                      <p className="font-medium text-gray-900">{docInfo.file_name}</p>
                      <p className="text-sm text-gray-500">{formatFileSize(docInfo.file_size)}</p>
                    </div>
                  </div>

                  {docInfo.sheet_names && docInfo.sheet_names.length > 1 && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Select Sheet</label>
                      <select
                        value={selectedSheet}
                        onChange={(e) => setSelectedSheet(Number(e.target.value))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        {docInfo.sheet_names.map((name, idx) => (
                          <option key={idx} value={idx}>{name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <button
                    onClick={handleExcelToCsv}
                    disabled={converting}
                    className="w-full py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors font-medium"
                  >
                    {converting ? "Converting..." : "Convert to CSV"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Data Tab (CSV/JSON) */}
          {activeTab === "data" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => selectInputFile(["csv"])}
                  disabled={converting}
                  className="p-6 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors disabled:opacity-50"
                >
                  <div className="text-center">
                    <span className="text-3xl">📊</span>
                    <p className="text-gray-600 font-medium mt-2">CSV → JSON</p>
                  </div>
                </button>

                <button
                  onClick={() => selectInputFile(["json"])}
                  disabled={converting}
                  className="p-6 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors disabled:opacity-50"
                >
                  <div className="text-center">
                    <span className="text-3xl">📋</span>
                    <p className="text-gray-600 font-medium mt-2">JSON → CSV</p>
                  </div>
                </button>
              </div>

              {docInfo && (
                <div className="p-4 bg-gray-50 rounded-lg space-y-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{getFileIcon(docInfo.extension)}</span>
                    <div>
                      <p className="font-medium text-gray-900">{docInfo.file_name}</p>
                      <p className="text-sm text-gray-500">{formatFileSize(docInfo.file_size)}</p>
                    </div>
                  </div>

                  {docInfo.extension === "csv" && (
                    <button
                      onClick={handleCsvToJson}
                      disabled={converting}
                      className="w-full py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
                    >
                      {converting ? "Converting..." : "Convert to JSON"}
                    </button>
                  )}

                  {docInfo.extension === "json" && (
                    <button
                      onClick={handleJsonToCsv}
                      disabled={converting}
                      className="w-full py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium"
                    >
                      {converting ? "Converting..." : "Convert to CSV"}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* PDF Merge Tab */}
          {activeTab === "pdf" && (
            <div className="space-y-4">
              <button
                onClick={selectPdfFiles}
                disabled={converting}
                className="w-full p-6 border-2 border-dashed border-gray-300 rounded-lg hover:border-red-400 hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                <div className="text-center">
                  <span className="text-4xl">📕</span>
                  <p className="text-gray-600 font-medium mt-2">Select PDF Files to Merge</p>
                  <p className="text-sm text-gray-400">Select multiple PDFs</p>
                </div>
              </button>

              {pdfFiles.length > 0 && (
                <div className="p-4 bg-gray-50 rounded-lg space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-gray-800">
                      {pdfFiles.length} PDF{pdfFiles.length !== 1 ? "s" : ""} selected
                    </span>
                    <button
                      onClick={() => setPdfFiles([])}
                      className="text-sm text-gray-500 hover:text-red-500"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="max-h-32 overflow-auto space-y-1">
                    {pdfFiles.map((file, idx) => (
                      <div key={idx} className="text-sm text-gray-600 truncate">
                        {idx + 1}. {file.split("/").pop()}
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={handleMergePdfs}
                    disabled={converting || pdfFiles.length < 2}
                    className="w-full py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors font-medium"
                  >
                    {converting ? "Merging..." : `Merge ${pdfFiles.length} PDFs`}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* External Tools Tab */}
          {activeTab === "external" && (
            <div className="space-y-4">
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="font-medium text-gray-800 mb-3">External Tools Status</h4>
                <div className="flex flex-wrap gap-2">
                  {externalTools.map((tool) => (
                    <div
                      key={tool.name}
                      className={`px-3 py-1.5 rounded-full text-sm ${
                        tool.available
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-200 text-gray-500"
                      }`}
                    >
                      {tool.available ? "✓" : "✗"} {tool.name}
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-medium text-blue-800 mb-2">Advanced Conversions</h4>
                <p className="text-sm text-blue-700">
                  For Office document conversions (Word, PowerPoint to PDF), install:
                </p>
                <ul className="text-sm text-blue-600 mt-2 space-y-1">
                  <li>• <code className="bg-blue-100 px-1 rounded">brew install --cask libreoffice</code></li>
                  <li>• <code className="bg-blue-100 px-1 rounded">brew install pandoc</code> (for Markdown)</li>
                </ul>
              </div>

              {hasTool("LibreOffice") && (
                <div className="p-4 border border-gray-200 rounded-lg">
                  <p className="text-sm text-gray-600">
                    LibreOffice detected! Office document conversions are available through the command line.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

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
