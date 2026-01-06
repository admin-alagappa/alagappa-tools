import { useState } from "react";
import Layout from "./components/Layout";
import AttendanceModule from "./components/AttendanceModule";
import DocumentConverter from "./components/DocumentConverter";
import ImageConverter from "./components/ImageConverter";
import VideoConverter from "./components/VideoConverter";
import AlagappaAI from "./components/AlagappaAI";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginGate from "./components/LoginGate";

function App() {
  const [activeTool, setActiveTool] = useState<string>("attendance");

  const renderTool = () => {
    switch (activeTool) {
      case "attendance":
        return <AttendanceModule />;
      case "document":
        return <DocumentConverter />;
      case "image":
        return <ImageConverter />;
      case "video":
        return <VideoConverter />;
      case "ai":
        return <AlagappaAI />;
      default:
        return <AttendanceModule />;
    }
  };

  return (
    <ErrorBoundary>
      <LoginGate>
        <Layout activeTool={activeTool} onToolChange={setActiveTool}>
          {renderTool()}
        </Layout>
      </LoginGate>
    </ErrorBoundary>
  );
}

export default App;

